use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicBool, Ordering}, mpsc::Sender, Arc},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use fs2::FileExt;
use interprocess::{
    local_socket::{
        prelude::*, ConnectOptions, Listener, ListenerNonblockingMode, ListenerOptions, Name,
    },
    ConnectWaitMode,
};

#[derive(Debug)]
pub enum Event {
    Show { position: Option<(f64, f64)> },
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    CheckUpdates,
    Quit,
}

pub struct Instance {
    _lock: File,
    stop: Arc<AtomicBool>,
    listener: Option<JoinHandle<()>>,
}

impl Drop for Instance {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(listener) = self.listener.take() {
            listener.thread().unpark();
            if listener.join().is_err() {
                eprintln!("QuickDrop instance listener panicked.");
            }
        }
    }
}

pub fn claim_instance(events: Sender<Event>) -> Result<Option<Instance>, String> {
    let directory = instance_directory()?;
    claim_instance_in(&directory, std::env::args_os().any(|arg| arg == "--tray-start"), events)
        .map_err(|error| format!("Could not establish the QuickDrop user instance: {error}"))
}

fn claim_instance_in(directory: &Path, tray_start: bool, events: Sender<Event>) -> io::Result<Option<Instance>> {
    let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(directory.join("instance.lock"))?;
    let name = instance_name(directory)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                match ConnectOptions::new().name(name.borrow())
                    .wait_mode(ConnectWaitMode::Timeout(Duration::from_millis(200)))
                    .nonblocking_stream(true).connect_sync()
                {
                    Ok(stream) => break stream,
                    Err(error) if Instant::now() < deadline
                        && matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused | io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => return Err(error),
                }
            };
            stream.write_all(&[u8::from(!tray_start)])?;
            if read_byte(&mut stream)? != 1 {
                return Err(io::Error::other("The running instance did not acknowledge the request."));
            }
            return Ok(None);
        }
        Err(error) => return Err(error),
    }

    #[cfg(unix)]
    match fs::remove_file(directory.join("instance.sock")) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let options = ListenerOptions::new().name(name)
        .nonblocking(ListenerNonblockingMode::Both);
    #[cfg(windows)]
    let options = {
        use interprocess::os::windows::{local_socket::ListenerOptionsExt, security_descriptor::SecurityDescriptor};
        let descriptor = widestring::U16CString::from_str("D:P(A;;GA;;;OW)")
            .map_err(io::Error::other)?;
        options.security_descriptor(SecurityDescriptor::deserialize(&descriptor)?)
    };
    let listener: Listener = options.create_sync()?;
    let stop = Arc::new(AtomicBool::new(false));
    let stopping = stop.clone();
    let worker = thread::Builder::new().name("quickdrop-instance".into()).spawn(move || {
        while !stopping.load(Ordering::Acquire) {
            match listener.accept() {
                Ok(mut stream) => {
                    let result = (|| -> io::Result<()> {
                        match read_byte(&mut stream)? {
                            0 => {}
                            1 => events.send(Event::Show { position: None })
                                .map_err(|_| io::Error::other("The application event loop has stopped."))?,
                            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid instance request.")),
                        }
                        stream.write_all(&[1])
                    })();
                    if let Err(error) = result {
                        eprintln!("QuickDrop instance request failed: {error}");
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::park_timeout(Duration::from_millis(40));
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => {
                    eprintln!("QuickDrop instance listener failed: {error}");
                    let _ = events.send(Event::Quit);
                    break;
                }
            }
        }
    })?;
    Ok(Some(Instance { _lock: lock, stop, listener: Some(worker) }))
}

fn read_byte(stream: &mut impl Read) -> io::Result<u8> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut byte = [0];
    loop {
        match stream.read(&mut byte) {
            Ok(1) => return Ok(byte[0]),
            Ok(_) => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "Instance connection closed.")),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "Instance acknowledgement timed out."));
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(unix)]
fn instance_directory() -> Result<PathBuf, String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let uid = rustix::process::geteuid().as_raw();
    let directory = PathBuf::from(format!("/tmp/quickdrop-{uid}"));
    match fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(format!("Could not create private instance directory: {error}")),
    }
    let metadata = fs::symlink_metadata(&directory)
        .map_err(|error| format!("Could not inspect instance directory: {error}"))?;
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err("QuickDrop instance directory must be owned by this user with mode 0700.".into());
    }
    Ok(directory)
}

#[cfg(windows)]
fn instance_directory() -> Result<PathBuf, String> {
    let directory = dirs::data_local_dir().ok_or("Could not locate the current user's local data directory.")?
        .join("quickdrop");
    fs::create_dir_all(&directory).map_err(|error| format!("Could not create instance directory: {error}"))?;
    Ok(directory)
}

#[cfg(unix)]
fn instance_name(directory: &Path) -> io::Result<Name<'static>> {
    directory.join("instance.sock").as_os_str().to_fs_name::<interprocess::local_socket::GenericFilePath>()
        .map(Name::into_owned)
}

#[cfg(windows)]
fn instance_name(directory: &Path) -> io::Result<Name<'static>> {
    use sha2::{Digest, Sha256};
    use std::os::windows::ffi::OsStrExt;
    let mut hash = Sha256::new();
    for word in directory.as_os_str().encode_wide() {
        hash.update(word.to_le_bytes());
    }
    format!("quickdrop-{:x}", hash.finalize()).to_ns_name::<interprocess::local_socket::GenericNamespaced>()
        .map(Name::into_owned)
}

// Linux deliberately uses the Omarchy launcher, not a tray service.
#[cfg(target_os = "linux")]
pub struct Platform;

#[cfg(target_os = "linux")]
pub fn start(_events: Sender<Event>) -> Result<Platform, String> {
    Ok(Platform)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub use desktop::{start, Platform};

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod desktop {
    use super::*;
    use std::{cell::RefCell, rc::{Rc, Weak}};
    use tray_icon::{
        menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem},
        Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
    };

    struct LoginMenu {
        item: CheckMenuItem,
        marker: PathBuf,
    }

    thread_local! {
        static LOGIN_MENU: RefCell<Weak<LoginMenu>> = RefCell::new(Weak::new());
    }

    pub struct Platform {
        _tray: TrayIcon,
        _menu: Menu,
        _login: Rc<LoginMenu>,
    }

    pub fn start(events: Sender<Event>) -> Result<Platform, String> {
        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
            let main = objc2::MainThreadMarker::new().ok_or("Tray initialization requires the main thread.")?;
            if !NSApplication::sharedApplication(main).setActivationPolicy(NSApplicationActivationPolicy::Accessory) {
                return Err("Could not set the menu-bar application activation policy.".into());
            }
        }
        let marker = dirs::config_dir().ok_or("Could not locate the user configuration directory.")?
            .join("dev.quickdrop.quickdrop").join("autostart-configured");
        let enabled = super::login_enabled()?;
        #[cfg(target_os = "windows")]
        let enabled = {
            if !marker.try_exists().map_err(|error| format!("Could not inspect autostart marker: {error}"))? {
                super::set_login_enabled(true)?;
                write_marker(&marker)?;
                true
            } else {
                if enabled { super::set_login_enabled(true)?; }
                enabled
            }
        };
        #[cfg(target_os = "macos")]
        if enabled { super::set_login_enabled(true)?; }

        let open = MenuItem::with_id("open", "Open QuickDrop", true, None);
        let updates = MenuItem::with_id("updates", "Check for updates…", true, None);
        let login = Rc::new(LoginMenu {
            item: CheckMenuItem::with_id("login", "Launch at login", true, enabled, None),
            marker,
        });
        let quit = MenuItem::with_id("quit", "Quit", true, None);
        let menu = Menu::new();
        menu.append_items(&[&open, &updates, &login.item, &PredefinedMenuItem::separator(), &quit])
            .map_err(|error| format!("Could not create tray menu: {error}"))?;
        #[cfg(target_os = "windows")]
        let bytes = include_bytes!("../icons/icon.png").as_slice();
        #[cfg(target_os = "macos")]
        let bytes = include_bytes!("../icons/tray-icon-template.png").as_slice();
        let icon = decode_icon(bytes)?;
        LOGIN_MENU.with(|state| *state.borrow_mut() = Rc::downgrade(&login));
        let menu_events = events.clone();
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| match event.id.as_ref() {
            "open" => { let _ = menu_events.send(Event::Show { position: None }); }
            "updates" => { let _ = menu_events.send(Event::CheckUpdates); }
            "quit" => { let _ = menu_events.send(Event::Quit); }
            "login" => LOGIN_MENU.with(|state| {
                if let Some(login) = state.borrow().upgrade() {
                    match super::login_enabled() {
                        Ok(enabled) => {
                            match super::set_login_enabled(!enabled) {
                                Ok(()) => {
                                    login.item.set_checked(!enabled);
                                    if let Err(error) = write_marker(&login.marker) { eprintln!("{error}"); }
                                }
                                Err(error) => {
                                    login.item.set_checked(enabled);
                                    eprintln!("Could not change launch at login: {error}");
                                    if let Err(notification_error) = crate::files::notify("QuickDrop", &error) {
                                        eprintln!("{notification_error}");
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            login.item.set_checked(false);
                            eprintln!("Could not read launch at login: {error}");
                        }
                    }
                }
            }),
            _ => {}
        }));
        TrayIconEvent::set_event_handler(Some(move |event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                #[cfg(target_os = "windows")]
                let position = Some((rect.position.x, rect.position.y));
                #[cfg(target_os = "macos")]
                let position = {
                    let _ = rect;
                    match super::mac_tray_position() {
                        Ok(position) => Some(position),
                        Err(error) => { eprintln!("{error}"); return; }
                    }
                };
                let _ = events.send(Event::Show { position });
            }
        }));
        let tray = TrayIconBuilder::new().with_id("quickdrop").with_icon(icon).with_tooltip("QuickDrop")
            .with_menu(Box::new(menu.clone())).with_menu_on_left_click(false)
            .with_icon_as_template(cfg!(target_os = "macos"))
            .build().map_err(|error| format!("Could not create tray icon: {error}"))?;
        Ok(Platform { _tray: tray, _menu: menu, _login: login })
    }

    fn decode_icon(bytes: &[u8]) -> Result<Icon, String> {
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().map_err(|error| format!("Could not decode tray icon: {error}"))?;
        let mut rgba = vec![0; reader.output_buffer_size()];
        let image = reader.next_frame(&mut rgba).map_err(|error| format!("Could not decode tray icon: {error}"))?;
        if image.bit_depth != png::BitDepth::Eight {
            return Err("Tray icon must contain 8-bit pixels.".into());
        }
        rgba.truncate(image.buffer_size());
        match image.color_type {
            png::ColorType::Rgba => {}
            png::ColorType::GrayscaleAlpha => {
                let pixels = rgba.len() / 2;
                rgba.resize(pixels * 4, 0);
                for index in (0..pixels).rev() {
                    let (gray, alpha) = (rgba[index * 2], rgba[index * 2 + 1]);
                    rgba[index * 4..index * 4 + 4].copy_from_slice(&[gray, gray, gray, alpha]);
                }
            }
            _ => return Err("Tray icon must contain RGBA or grayscale-alpha pixels.".into()),
        }
        Icon::from_rgba(rgba, image.width, image.height)
            .map_err(|error| format!("Could not create tray icon: {error}"))
    }

    #[test]
    fn bundled_tray_icons_decode_native_rgba_and_grayscale_alpha() {
        for bytes in [
            include_bytes!("../icons/icon.png").as_slice(),
            include_bytes!("../icons/tray-icon-template.png").as_slice(),
        ] {
            assert!(decode_icon(bytes).is_ok());
        }
        assert!(decode_icon(b"not a PNG").is_err());
    }

    fn write_marker(marker: &Path) -> Result<(), String> {
        fs::create_dir_all(marker.parent().ok_or("Autostart marker has no parent directory.")?)
            .and_then(|()| fs::write(marker, "configured=true\n"))
            .map_err(|error| format!("Could not save autostart preference: {error}"))
    }
}

#[cfg(target_os = "windows")]
fn login_enabled() -> Result<bool, String> {
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_READ}, RegKey};
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let run = match user.open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", KEY_READ) {
        Ok(run) => run,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not read Windows startup settings: {error}")),
    };
    match run.get_value::<String, _>("QuickDrop") {
        Ok(value) if !value.is_empty() => {}
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not read QuickDrop startup setting: {error}")),
    }
    let approved = match user.open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run", KEY_READ) {
        Ok(approved) => approved,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(format!("Could not read Windows startup approval: {error}")),
    };
    match approved.get_raw_value("QuickDrop") {
        Ok(value) => match value.bytes.first() {
            Some(2) | Some(6) => Ok(true),
            Some(3) | Some(7) => Ok(false),
            _ => Err("QuickDrop startup approval has an unknown state.".into()),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(format!("Could not read QuickDrop startup approval: {error}")),
    }
}

#[cfg(target_os = "windows")]
fn set_login_enabled(enabled: bool) -> Result<(), String> {
    use winreg::{enums::{HKEY_CURRENT_USER, RegType::REG_BINARY}, RegKey, RegValue};
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = user.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|error| format!("Could not open Windows startup settings: {error}"))?;
    if enabled {
        let executable = std::env::current_exe().map_err(|error| format!("Could not locate QuickDrop executable: {error}"))?;
        let executable = executable.to_str().ok_or("QuickDrop executable path is not valid Unicode.")?;
        run.set_value("QuickDrop", &format!("\"{executable}\" --tray-start"))
            .map_err(|error| format!("Could not enable launch at login: {error}"))?;
        let (approved, _) = user.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run")
            .map_err(|error| format!("Could not open Windows startup approval: {error}"))?;
        let mut bytes = vec![0; 12];
        bytes[0] = 2;
        approved.set_raw_value("QuickDrop", &RegValue { vtype: REG_BINARY, bytes })
            .map_err(|error| format!("Could not approve launch at login: {error}"))?;
    } else {
        match run.delete_value("QuickDrop") {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not disable launch at login: {error}")),
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Result<PathBuf, String> {
    Ok(dirs::home_dir().ok_or("Could not locate the current user's home directory.")?
        .join("Library/LaunchAgents/QuickDrop.plist"))
}

#[cfg(target_os = "macos")]
fn login_enabled() -> Result<bool, String> {
    let path = launch_agent_path()?;
    if !path.try_exists().map_err(|error| format!("Could not inspect launch agent: {error}"))? { return Ok(false); }
    let value = plist::Value::from_file(path).map_err(|error| format!("Could not read QuickDrop launch agent: {error}"))?;
    let dictionary = value.as_dictionary().ok_or("QuickDrop launch agent is not a plist dictionary.")?;
    Ok(dictionary.get("RunAtLoad").and_then(plist::Value::as_boolean).unwrap_or(false))
}

#[cfg(target_os = "macos")]
fn set_login_enabled(enabled: bool) -> Result<(), String> {
    let path = launch_agent_path()?;
    if !enabled {
        return match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not disable launch at login: {error}")),
        };
    }
    let executable = std::env::current_exe().map_err(|error| format!("Could not locate QuickDrop executable: {error}"))?;
    let executable = executable.to_str().ok_or("QuickDrop executable path is not valid Unicode.")?;
    let mut agent = plist::Dictionary::new();
    agent.insert("Label".into(), plist::Value::String("QuickDrop".into()));
    agent.insert("ProgramArguments".into(), plist::Value::Array(vec![
        plist::Value::String(executable.into()), plist::Value::String("--tray-start".into()),
    ]));
    agent.insert("RunAtLoad".into(), plist::Value::Boolean(true));
    let directory = path.parent().ok_or("Launch agent has no parent directory.")?;
    fs::create_dir_all(directory).map_err(|error| format!("Could not create launch agent directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|error| format!("Could not prepare launch agent: {error}"))?;
    plist::Value::Dictionary(agent).to_writer_xml(temporary.as_file_mut())
        .map_err(|error| format!("Could not write launch agent: {error}"))?;
    temporary.as_file().sync_all().map_err(|error| format!("Could not save launch agent: {error}"))?;
    temporary.persist(path).map_err(|error| format!("Could not install launch agent: {error}"))?;
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn clamp_origin(x: f64, y: f64, width: f64, height: f64, area: (f64, f64, f64, f64)) -> (f64, f64) {
    (x.clamp(area.0, (area.0 + area.2 - width).max(area.0)),
        y.clamp(area.1, (area.1 + area.3 - height).max(area.1)))
}

#[cfg(target_os = "windows")]
fn native_window(window: &gpui::Window) -> Result<windows_sys::Win32::Foundation::HWND, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).map_err(|error| format!("Could not access native window: {error}"))?.as_raw() {
        RawWindowHandle::Win32(handle) => Ok(handle.hwnd.get() as _),
        _ => Err("GPUI did not provide a Windows window handle.".into()),
    }
}

#[cfg(target_os = "windows")]
pub fn hide_window(window: &gpui::Window) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};
    let handle = native_window(window)?;
    // GPUI owns this HWND for the duration of the borrowed Window.
    unsafe {
        ShowWindow(handle, SW_HIDE);
        if IsWindowVisible(handle) != 0 { return Err("Windows did not hide the QuickDrop window.".into()); }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn show_window(window: &gpui::Window, position: Option<(f64, f64)>) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{POINT, RECT},
        Graphics::Gdi::{GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
        UI::WindowsAndMessaging::{GetWindowRect, SetForegroundWindow, SetWindowPos, ShowWindow,
            HWND_TOPMOST, SWP_NOSIZE, SWP_SHOWWINDOW, SW_RESTORE},
    };
    let handle = native_window(window)?;
    // All handles and output structs belong to this call or the borrowed GPUI Window.
    unsafe {
        let mut rectangle: RECT = std::mem::zeroed();
        if GetWindowRect(handle, &mut rectangle) == 0 {
            return Err(format!("Could not inspect QuickDrop window: {}", io::Error::last_os_error()));
        }
        let monitor = match position {
            Some((x, y)) => MonitorFromPoint(POINT { x: x as i32, y: y as i32 }, MONITOR_DEFAULTTONEAREST),
            None => MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST),
        };
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return Err(format!("Could not inspect window monitor: {}", io::Error::last_os_error()));
        }
        let work = info.rcWork;
        let width = f64::from(rectangle.right - rectangle.left);
        let height = f64::from(rectangle.bottom - rectangle.top);
        let (x, y) = position.map(|(x, y)| (x - width / 2.0, y - height - 10.0))
            .unwrap_or((f64::from(work.right) - width - 10.0, f64::from(work.bottom) - height - 10.0));
        let (x, y) = clamp_origin(x, y, width, height,
            (f64::from(work.left), f64::from(work.top), f64::from(work.right - work.left), f64::from(work.bottom - work.top)));
        ShowWindow(handle, SW_RESTORE);
        if SetWindowPos(handle, HWND_TOPMOST, x as i32, y as i32, 0, 0, SWP_NOSIZE | SWP_SHOWWINDOW) == 0 {
            return Err(format!("Could not position QuickDrop window: {}", io::Error::last_os_error()));
        }
        if SetForegroundWindow(handle) == 0 {
            return Err("Windows refused to focus the QuickDrop window.".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_tray_position() -> Result<(f64, f64), String> {
    use objc2_app_kit::{NSEvent, NSScreen};
    let main = objc2::MainThreadMarker::new().ok_or("Tray events require the main thread.")?;
    let screens = NSScreen::screens(main);
    let primary = screens.firstObject().ok_or("No macOS display is available.")?;
    let primary_top = primary.frame().origin.y + primary.frame().size.height;
    // AppKit returns global logical coordinates with a bottom-left origin.
    let mouse = unsafe { NSEvent::mouseLocation() };
    let screen = screens.iter().find(|screen| {
        let frame = screen.frame();
        mouse.x >= frame.origin.x && mouse.x <= frame.origin.x + frame.size.width
            && mouse.y >= frame.origin.y && mouse.y <= frame.origin.y + frame.size.height
    }).ok_or("Tray click did not belong to an active display.")?;
    let scale = screen.backingScaleFactor();
    Ok((mouse.x * scale, (primary_top - mouse.y) * scale))
}

#[cfg(target_os = "macos")]
fn native_window(window: &gpui::Window) -> Result<objc2::rc::Retained<objc2_app_kit::NSWindow>, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    if objc2::MainThreadMarker::new().is_none() { return Err("Window operations require the main thread.".into()); }
    match HasWindowHandle::window_handle(window).map_err(|error| format!("Could not access native window: {error}"))?.as_raw() {
        RawWindowHandle::AppKit(handle) => {
            // The borrowed GPUI Window keeps its NSView alive on the main thread.
            let view = unsafe { &*handle.ns_view.as_ptr().cast::<objc2_app_kit::NSView>() };
            view.window().ok_or("GPUI view has no native window.".into())
        }
        _ => Err("GPUI did not provide an AppKit window handle.".into()),
    }
}

#[cfg(target_os = "macos")]
pub fn hide_window(window: &gpui::Window) -> Result<(), String> {
    native_window(window)?.orderOut(None);
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn show_window(window: &gpui::Window, position: Option<(f64, f64)>) -> Result<(), String> {
    use objc2_app_kit::{NSApplication, NSScreen};
    use objc2_foundation::NSPoint;
    let main = objc2::MainThreadMarker::new().ok_or("Window operations require the main thread.")?;
    let window = native_window(window)?;
    let screens = NSScreen::screens(main);
    let primary = screens.firstObject().ok_or("No macOS display is available.")?;
    let primary_top = primary.frame().origin.y + primary.frame().size.height;
    let mut screen = window.screen().unwrap_or_else(|| primary.clone());
    if let Some((x, y)) = position {
        for candidate in screens.iter() {
            let scale = candidate.backingScaleFactor();
            let frame = candidate.frame();
            let logical_x = x / scale;
            let logical_y = primary_top - y / scale;
            if logical_x >= frame.origin.x && logical_x <= frame.origin.x + frame.size.width
                && logical_y >= frame.origin.y && logical_y <= frame.origin.y + frame.size.height {
                screen = candidate;
                break;
            }
        }
    }
    let work = screen.visibleFrame();
    let frame = window.frame();
    let scale = screen.backingScaleFactor();
    let (x, y) = position.map(|(x, y)| (x / scale - frame.size.width / 2.0, primary_top - y / scale - frame.size.height - 10.0))
        .unwrap_or((work.origin.x + work.size.width - frame.size.width - 10.0,
            work.origin.y + work.size.height - frame.size.height - 10.0));
    let (x, y) = clamp_origin(x, y, frame.size.width, frame.size.height,
        (work.origin.x, work.origin.y, work.size.width, work.size.height));
    // The window is retained and this function requires the AppKit main thread.
    unsafe { window.setFrameOrigin(NSPoint::new(x, y)); }
    #[allow(deprecated)]
    NSApplication::sharedApplication(main).activateIgnoringOtherApps(true);
    window.makeKeyAndOrderFront(None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_clamps_to_negative_and_small_work_areas() {
        assert_eq!(clamp_origin(-2000.0, 2000.0, 380.0, 360.0, (-1920.0, 0.0, 1920.0, 1080.0)), (-1920.0, 720.0));
        assert_eq!(clamp_origin(100.0, 100.0, 380.0, 360.0, (0.0, 0.0, 100.0, 100.0)), (0.0, 0.0));
    }

    #[test]
    fn instance_forwards_launch_but_not_tray_start_and_releases_lock() {
        let directory = tempfile::tempdir().unwrap();
        let (events, receiver) = std::sync::mpsc::channel();
        let instance = claim_instance_in(directory.path(), false, events.clone()).unwrap().unwrap();
        assert!(claim_instance_in(directory.path(), false, events.clone()).unwrap().is_none());
        assert!(matches!(receiver.recv_timeout(Duration::from_secs(1)).unwrap(), Event::Show { position: None }));
        assert!(claim_instance_in(directory.path(), true, events.clone()).unwrap().is_none());
        assert!(receiver.try_recv().is_err());
        drop(instance);
        assert!(claim_instance_in(directory.path(), false, events).unwrap().is_some());
    }

    #[test]
    fn instance_rejects_missing_ipc_instead_of_false_success() {
        let directory = tempfile::tempdir().unwrap();
        let lock = OpenOptions::new().create(true).truncate(false).read(true).write(true)
            .open(directory.path().join("instance.lock")).unwrap();
        lock.try_lock_exclusive().unwrap();
        let (events, _) = std::sync::mpsc::channel();
        assert!(claim_instance_in(directory.path(), false, events).is_err());
    }
}
