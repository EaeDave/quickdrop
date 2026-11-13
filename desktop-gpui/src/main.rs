#![cfg_attr(all(target_os = "windows", not(debug_assertions)), windows_subsystem = "windows")]

mod config;
mod files;
mod rooms;
mod platform;
mod updater;

use std::{path::PathBuf, sync::{mpsc, Arc}, time::Duration};
use gpui::{prelude::*, *};
use gpui_component::{button::*, input::{Input, InputEvent, InputState}, ActiveTheme, Disableable, Root, Selectable, Sizable, Theme, ThemeMode};
use serde::{Deserialize, Serialize};

const APP_ID: &str = "quickdrop";
const WIDTH: f32 = 380.;
const HEIGHT: f32 = 360.;
const PRIMARY_SHORTCUT: &str = if cfg!(target_os = "macos") { "⌘" } else { "Ctrl+" };

fn pin_ready(pin: &str) -> bool {
    (4..=64).contains(&pin.trim().encode_utf16().count())
}

#[derive(Default, Deserialize, Serialize)]
struct Settings {
    recent: Vec<String>,
    muted: bool,
}

fn settings_path() -> PathBuf {
    dirs::config_dir().expect("Could not locate the configuration directory").join("quickdrop/settings.json")
}

enum UpdateEvent {
    Checked { result: Result<Option<updater::Update>, String>, interactive: bool },
    Installed(Result<(), String>),
}

struct Panel {
    runtime: Arc<tokio::runtime::Runtime>,
    base: String,
    native_events: mpsc::Receiver<platform::Event>,
    update_events: mpsc::Receiver<UpdateEvent>,
    update_sender: mpsc::Sender<UpdateEvent>,
    update_pending: bool,
    _platform: platform::Platform,
    _instance: platform::Instance,
    text_mode: bool,
    code_input: Entity<InputState>,
    pin_input: Entity<InputState>,
    composer: Entity<InputState>,
    show_pin: bool,
    room: Option<String>,
    connected: bool,
    opening: bool,
    presence: u64,
    expiry: Option<String>,
    drops: Vec<rooms::Drop>,
    commands: Option<tokio::sync::mpsc::UnboundedSender<rooms::Command>>,
    room_events: Option<mpsc::Receiver<rooms::Event>>,
    settings: Settings,
    message: String,
    upload_message: String,
    uploading: bool,
    progress: u8,
    upload_events: Option<mpsc::Receiver<Result<files::Upload, String>>>,
    progress_events: Option<mpsc::Receiver<u8>>,
    uploaded: Option<files::Upload>,
    pending_composer: Option<String>,
    sending: bool,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

impl Panel {
    fn new(base: String, runtime: Arc<tokio::runtime::Runtime>, native_events: mpsc::Receiver<platform::Event>, native_platform: platform::Platform, instance: platform::Instance, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let code_input = cx.new(|cx| InputState::new(window, cx).placeholder("Room: DEV, A, 42…"));
        let pin_input = cx.new(|cx| InputState::new(window, cx).placeholder("PIN (4–64 characters)").masked(true));
        let composer = cx.new(|cx| InputState::new(window, cx).placeholder("Type or paste text…").multi_line(true));
        let settings = match std::fs::read(settings_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => Settings::default(),
        };
        let mut subscriptions = Vec::new();
        for input in [&code_input, &pin_input] {
            subscriptions.push(cx.subscribe_in(input, window, |this, _, event, window, cx| {
                match event {
                    InputEvent::PressEnter { .. } => this.connect(window, cx),
                    InputEvent::Change => cx.notify(),
                    _ => (),
                }
            }));
        }
        subscriptions.push(cx.subscribe_in(&composer, window, |this, _, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { secondary: true }) { this.send(false, cx); }
        }));
        cx.spawn_in(window, async move |view, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                if view.update_in(cx, |this, window, cx| this.receive(window, cx)).is_err() { break; }
            }
        }).detach();
        let focus = cx.focus_handle();
        focus.focus(window);
        let (update_sender, update_events) = mpsc::channel();
        let mut panel = Self {
            runtime, base, text_mode: false, code_input, pin_input, composer,
            native_events, update_events, update_sender, update_pending: false,
            _platform: native_platform, _instance: instance,
            show_pin: false, room: None, connected: false, opening: false,
            presence: 0, expiry: None, drops: Vec::new(), commands: None, room_events: None,
            settings, message: String::new(), upload_message: String::new(), uploading: false,
            progress: 0, upload_events: None, progress_events: None, uploaded: None,
            pending_composer: None, sending: false, focus, _subscriptions: subscriptions,
        };
        if updater::configured() { panel.check_updates(false); }
        panel
    }

    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Err(error) = platform::hide_window(window) {
            self.message = error;
            cx.notify();
        }
        #[cfg(target_os = "linux")]
        { let _ = window; cx.quit(); }
    }

    fn check_updates(&mut self, interactive: bool) {
        if self.update_pending { return; }
        self.update_pending = true;
        let sender = self.update_sender.clone();
        let base = self.base.clone();
        self.runtime.spawn(async move {
            if !interactive { tokio::time::sleep(Duration::from_secs(3)).await; }
            let _ = sender.send(UpdateEvent::Checked { result: updater::check(&base).await, interactive });
        });
    }

    fn offer_update(&mut self, update: updater::Update, window: &mut Window, cx: &mut Context<Self>) {
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        if let Err(error) = platform::show_window(window, None) { self.message = error; cx.notify(); return; }
        let prompt = window.prompt(PromptLevel::Info, &format!("QuickDrop {} is available", update.version),
            Some("Install the signed update and restart QuickDrop?"), &["Install and restart", "Later"], cx);
        cx.spawn_in(window, async move |view, cx| {
            if prompt.await == Ok(0) {
                let _ = view.update_in(cx, |this, _, cx| {
                    this.update_pending = true;
                    this.message = "Downloading and verifying update…".into();
                    this.upload_message = this.message.clone();
                    let sender = this.update_sender.clone();
                    let base = this.base.clone();
                    this.runtime.spawn(async move { let _ = sender.send(UpdateEvent::Installed(updater::install(base, update).await)); });
                    cx.notify();
                });
            }
        }).detach();
    }

    fn save_settings(&mut self) {
        let path = settings_path();
        let result = (|| -> anyhow::Result<()> {
            std::fs::create_dir_all(path.parent().unwrap())?;
            let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
            serde_json::to_writer(temporary.as_file_mut(), &self.settings)?;
            temporary.persist(path)?;
            Ok(())
        })();
        if let Err(error) = result { self.message = format!("Could not save preferences: {error}"); }
    }

    fn connect(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.opening { return; }
        self.disconnect();
        let code = self.code_input.read(cx).value().trim().to_ascii_uppercase();
        let pin = self.show_pin.then(|| self.pin_input.read(cx).value().trim().to_string());
        if pin.as_ref().is_some_and(|pin| !pin_ready(pin)) {
            self.message = "Use a PIN with 4–64 characters.".into();
            cx.notify();
            return;
        }
        let (commands, receiver) = tokio::sync::mpsc::unbounded_channel();
        let (events, room_events) = mpsc::channel();
        self.commands = Some(commands);
        self.room_events = Some(room_events);
        self.opening = true;
        self.message = "Connecting…".into();
        let base = self.base.clone();
        self.runtime.spawn(async move {
            let _ = rooms::connect(base, code, pin, receiver, events).await;
        });
        cx.notify();
    }

    fn disconnect(&mut self) {
        if let Some(commands) = self.commands.take() { let _ = commands.send(rooms::Command::Close); }
        self.room_events = None;
        self.room = None;
        self.connected = false;
        self.opening = false;
        self.sending = false;
        self.pending_composer = None;
        self.drops.clear();
        self.expiry = None;
        self.presence = 0;
    }

    fn command(&mut self, command: rooms::Command) {
        if !self.connected { self.message = "Connect to a room first.".into(); return; }
        if self.commands.as_ref().is_none_or(|sender| sender.send(command).is_err()) {
            self.connected = false;
            self.message = "Connection closed. Leave and reconnect.".into();
        }
    }

    fn send(&mut self, paste: bool, cx: &mut Context<Self>) {
        if !self.connected || self.sending { return; }
        let content = if paste {
            match files::clipboard_text() {
                Ok(text) => text,
                Err(error) => { self.message = error; cx.notify(); return; }
            }
        } else { self.composer.read(cx).value().to_string() };
        if content.trim().is_empty() { self.message = "Enter text before sending.".into(); }
        else {
            self.pending_composer = (!paste).then(|| content.clone());
            self.sending = true;
            self.command(rooms::Command::Add(content));
        }
        cx.notify();
    }

    fn upload(&mut self, paths: Vec<PathBuf>, temporary: Option<tempfile::NamedTempFile>, cx: &mut Context<Self>) {
        if self.uploading || paths.is_empty() { return; }
        self.uploading = true;
        self.progress = 0;
        self.uploaded = None;
        self.upload_message = if paths.len() > 1 { "Creating ZIP…".into() } else { "Uploading…".into() };
        let (progress, progress_events) = mpsc::channel();
        let (sender, events) = mpsc::channel();
        self.progress_events = Some(progress_events);
        self.upload_events = Some(events);
        let base = self.base.clone();
        self.runtime.spawn(async move {
            let result = files::upload(paths, base, progress).await;
            drop(temporary);
            let _ = sender.send(result);
        });
        cx.notify();
    }

    fn paste_file(&mut self, cx: &mut Context<Self>) {
        if self.uploading { return; }
        match files::clipboard_file() {
            Ok(file) => self.upload(vec![file.path().to_owned()], Some(file), cx),
            Err(error) => { self.upload_message = error; cx.notify(); }
        }
    }

    fn pick_files(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.uploading { return; }
        let receiver = cx.prompt_for_paths(PathPromptOptions {
            files: true, directories: false, multiple: true, prompt: Some("Send files".into()),
        });
        cx.spawn_in(window, async move |view, cx| {
            let result = receiver.await;
            let _ = view.update_in(cx, |this, _, cx| match result {
                Ok(Ok(Some(paths))) => this.upload(paths, None, cx),
                Ok(Ok(None)) => (),
                other => { this.upload_message = format!("Could not open file picker: {other:?}"); cx.notify(); }
            });
        }).detach();
    }

    fn receive(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut changed = false;
        while let Ok(event) = self.native_events.try_recv() {
            match event {
                platform::Event::Show { position } => {
                    #[cfg(any(target_os = "windows", target_os = "macos"))]
                    if let Err(error) = platform::show_window(window, position) { self.message = error; }
                    #[cfg(target_os = "linux")]
                    { let _ = position; window.activate_window(); }
                }
                #[cfg(any(target_os = "windows", target_os = "macos"))]
                platform::Event::CheckUpdates => self.check_updates(true),
                platform::Event::Quit => cx.quit(),
            }
            changed = true;
        }
        while let Ok(event) = self.update_events.try_recv() {
            self.update_pending = false;
            match event {
                UpdateEvent::Checked { result: Ok(Some(update)), .. } => self.offer_update(update, window, cx),
                UpdateEvent::Checked { result: Ok(None), interactive: true } => {
                    let _ = window.prompt(PromptLevel::Info, "QuickDrop is up to date", None, &["OK"], cx);
                }
                UpdateEvent::Checked { result: Err(error), interactive } => {
                    eprintln!("Update check failed: {error}");
                    if interactive {
                        let _ = window.prompt(PromptLevel::Warning, "Could not check for updates", Some(&error), &["OK"], cx);
                    }
                }
                UpdateEvent::Checked { .. } => (),
                UpdateEvent::Installed(Ok(())) => cx.quit(),
                UpdateEvent::Installed(Err(error)) => {
                    self.message = format!("Update failed: {error}");
                    self.upload_message = self.message.clone();
                    let _ = window.prompt(PromptLevel::Critical, "Could not install update", Some(&error), &["OK"], cx);
                }
            }
            changed = true;
        }
        while let Some(Ok(percent)) = self.progress_events.as_ref().map(|events| events.try_recv()) {
            self.progress = percent;
            changed = true;
        }
        if let Some(Ok(result)) = self.upload_events.as_ref().map(|events| events.try_recv()) {
            self.uploading = false;
            self.upload_events = None;
            self.progress_events = None;
            match result {
                Ok(upload) => {
                    self.upload_message = match files::copy_text(&upload.url) {
                        Ok(()) => "Upload complete · Link copied".into(),
                        Err(error) => format!("Upload complete · {error}"),
                    };
                    if let Err(error) = files::notify("QuickDrop", "Upload complete. Your link is ready.") {
                        self.upload_message.push_str(&format!(" · {error}"));
                    }
                    self.uploaded = Some(upload);
                }
                Err(error) => self.upload_message = error,
            }
            changed = true;
        }
        while let Some(Ok(event)) = self.room_events.as_ref().map(|events| events.try_recv()) {
            changed = true;
            match event {
                rooms::Event::Connected { code } => {
                    self.opening = false;
                    self.room = Some(code.clone());
                    self.settings.recent.retain(|recent| recent != &code);
                    self.settings.recent.insert(0, code);
                    self.settings.recent.truncate(5);
                    self.message.clear();
                    self.save_settings();
                    self.pin_input.update(cx, |input, cx| input.set_value("", window, cx));
                }
                rooms::Event::Snapshot { mut drops, presence, expires_at } => {
                    drops.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
                    self.drops = drops; self.presence = presence; self.expiry = expires_at;
                    self.connected = true;
                    self.message = "Connected".into();
                }
                rooms::Event::Added { drop, remote } => {
                    self.drops.retain(|entry| entry.id != drop.id);
                    self.drops.insert(0, drop);
                    self.message = if remote { "New text received." } else { "Text sent." }.into();
                    if remote && !self.settings.muted {
                        if let Err(error) = files::notify("QuickDrop", &format!("New text in {}", self.room.as_deref().unwrap_or("room"))) {
                            self.message = error;
                        }
                    }
                }
                rooms::Event::Updated(drop) => {
                    if let Some(entry) = self.drops.iter_mut().find(|entry| entry.id == drop.id) { *entry = drop; }
                }
                rooms::Event::Removed(ids) => self.drops.retain(|entry| !ids.contains(&entry.id)),
                rooms::Event::Cleared => self.drops.clear(),
                rooms::Event::Presence(count) => self.presence = count,
                rooms::Event::Lifecycle(expiry) => self.expiry = expiry,
                rooms::Event::Sent => {
                    if self.pending_composer.take().is_some_and(|sent| self.composer.read(cx).value().as_ref() == sent) {
                        self.composer.update(cx, |input, cx| input.set_value("", window, cx));
                    }
                    self.sending = false;
                }
                rooms::Event::Error(error) => { self.message = error; self.sending = false; self.pending_composer = None; }
                rooms::Event::Closed => {
                    self.connected = false; self.opening = false;
                    self.sending = false; self.pending_composer = None;
                    if self.message == "Connected" || self.message.is_empty() { self.message = "Connection closed. Leave and reconnect.".into(); }
                }
            }
        }
        if changed { cx.notify(); }
    }

    fn open_browser(&mut self, cx: &mut Context<Self>) {
        let code = self.room.clone().unwrap_or_else(|| self.code_input.read(cx).value().trim().to_ascii_uppercase());
        if !code.is_empty() && code.len() <= 16 && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            cx.open_url(&format!("{}/{}", self.base, code));
        } else { self.message = "Enter a valid room code.".into(); cx.notify(); }
    }

    fn render_files(&self, cx: &mut Context<Self>) -> AnyElement {
        div().flex().flex_col().flex_1().min_h_0().items_center().justify_center()
            .gap(px(10.)).m(px(12.)).p(px(18.)).rounded(px(7.))
            .border_1().border_dashed().border_color(rgba(0x38bdf870)).bg(rgba(0x0f172a47))
            .child(Button::new("select-files").custom(
                ButtonCustomVariant::new(cx).color(rgba(0x0f172a75).into())
                    .foreground(rgb(0xcbd5e1).into()).border(rgba(0x38bdf83d).into())
                    .hover(rgba(0x0ea5e924).into()))
                .child(div().text_size(px(32.)).child("⇪")).w(px(52.)).h(px(52.)).rounded(px(26.))
                .tooltip(format!("Select files · {PRIMARY_SHORTCUT}V to paste image or text")).disabled(self.uploading)
                .on_click(cx.listener(|this, _, window, cx| this.pick_files(window, cx))))
            .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD)
                .child(if self.uploading { "Sending files…" } else { "Drop files to send" }))
            .child(div().text_size(px(12.)).text_center().text_color(rgb(0x94a3b8))
                .child("Multiple files become one ZIP with a single link."))
            .when(self.uploading, |view| view.child(div().text_sm().child(format!("{}% uploaded", self.progress))))
            .when_some(self.uploaded.as_ref(), |view, upload| {
                let url = upload.url.clone();
                view.child(div().w_full().text_sm().text_color(rgb(0xbae6fd)).overflow_hidden().child(upload.url.clone()))
                    .child(div().text_xs().text_color(cx.theme().muted_foreground).child(format!("Expires {}", display_date(&upload.expires_at))))
                    .child(Button::new("copy-upload").label("Copy link").on_click(cx.listener(move |this, _, _, cx| {
                        this.upload_message = match files::copy_text(&url) { Ok(()) => "Link copied".into(), Err(error) => error };
                        cx.notify();
                    })))
            })
            .when(!self.upload_message.is_empty(), |view| view.child(div().text_size(px(12.)).text_center().child(self.upload_message.clone())))
            .into_any_element()
    }

    fn render_text(&self, cx: &mut Context<Self>) -> AnyElement {
        let mut panel = div().flex().flex_col().flex_1().min_h_0().gap_2().p(px(12.));
        if let Some(code) = &self.room {
            panel = panel.child(div().flex().items_center().gap_2()
                .child(div().flex_1().font_weight(FontWeight::BOLD).child(code.clone()))
                .child(Button::new("mute").small().label(if self.settings.muted { "Unmute" } else { "Mute" })
                    .on_click(cx.listener(|this, _, _, cx| { this.settings.muted = !this.settings.muted; this.save_settings(); cx.notify(); })))
                .child(Button::new("browser").small().label("Web").on_click(cx.listener(|this, _, _, cx| this.open_browser(cx))))
                .child(Button::new("leave").small().label("Leave").on_click(cx.listener(|this, _, _, cx| { this.disconnect(); this.message.clear(); cx.notify(); }))))
                .child(div().text_xs().text_color(cx.theme().muted_foreground).child(format!("{} · {} online · {}", if self.connected { "Connected" } else { "Closed" }, self.presence, self.expiry.as_deref().map(display_date).unwrap_or_else(|| "Active room".into()))))
                .child(Input::new(&self.composer).h(px(74.)).disabled(!self.connected))
                .child(div().flex().gap_2()
                    .child(Button::new("send").primary().label(format!("Send · {PRIMARY_SHORTCUT}Enter")).disabled(!self.connected || self.sending)
                        .on_click(cx.listener(|this, _, _, cx| this.send(false, cx))))
                    .child(Button::new("paste-send").label("Paste and send").disabled(!self.connected || self.sending)
                        .on_click(cx.listener(|this, _, _, cx| this.send(true, cx)))))
                .child(div().id("drops").flex().flex_col().flex_1().min_h_0().overflow_y_scroll().gap_2()
                    .when(self.drops.is_empty(), |view| view.child(div().text_sm().text_color(cx.theme().muted_foreground).child("Waiting for text in this room…")))
                    .children(self.drops.iter().map(|drop| {
                        let content = drop.content.clone();
                        let id = drop.id.clone();
                        div().id(SharedString::from(format!("drop-{}", drop.id))).flex().items_center().gap_2().p_2().rounded_md().bg(cx.theme().muted)
                            .child(Button::new(SharedString::from(format!("copy-{}", drop.id))).flex_1().label(preview(&drop.content))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.message = match files::copy_text(&content) { Ok(()) => "Text copied.".into(), Err(error) => error }; cx.notify();
                                })))
                            .child(Button::new(SharedString::from(format!("delete-{}", drop.id))).small().label("Delete").disabled(!self.connected)
                                .on_click(cx.listener(move |this, _, _, cx| { this.command(rooms::Command::Delete(id.clone())); cx.notify(); })))
                    })));
        } else {
            panel = panel.child(Input::new(&self.code_input).disabled(self.opening))
                .when(self.show_pin, |view| view.child(Input::new(&self.pin_input).disabled(self.opening)))
                .child(div().flex().gap_2()
                    .child(Button::new("connect").primary().label(if self.opening { "Opening…" } else { "Connect" })
                        .disabled(self.opening || self.code_input.read(cx).value().trim().is_empty()
                            || (self.show_pin && !pin_ready(&self.pin_input.read(cx).value())))
                        .on_click(cx.listener(|this, _, window, cx| this.connect(window, cx))))
                    .child(Button::new("pin-toggle").label("PIN").selected(self.show_pin).disabled(self.opening)
                        .on_click(cx.listener(|this, _, _, cx| { this.show_pin = !this.show_pin; cx.notify(); })))
                    .child(Button::new("open-browser").label("Open in browser").on_click(cx.listener(|this, _, _, cx| this.open_browser(cx)))))
                .child(div().flex().flex_wrap().gap_2().children(self.settings.recent.iter().map(|code| {
                    let recent = code.clone();
                    Button::new(SharedString::from(format!("recent-{code}"))).small().label(code.clone()).disabled(self.opening)
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.code_input.update(cx, |input, cx| input.set_value(recent.clone(), window, cx));
                            this.connect(window, cx);
                        }))
                })))
                .child(div().flex().flex_col().flex_1().items_center().justify_center().gap_2()
                    .child(div().text_lg().child("Text across devices"))
                    .child(div().text_sm().text_center().text_color(cx.theme().muted_foreground).child("Connect to a room to send and receive snippets.")));
        }
        panel.child(div().text_xs().child(self.message.clone())).into_any_element()
    }
}

impl Render for Panel {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div().id("quickdrop-panel").track_focus(&self.focus).size_full().flex().flex_col()
            .overflow_hidden().rounded(px(7.)).border_1().border_color(rgba(0x94a3b833))
            .bg(linear_gradient(180., linear_color_stop(rgba(0x0f172ac7), 0.), linear_color_stop(rgba(0x020617e0), 1.)))
            .text_size(px(14.)).text_color(rgb(0xe5e7eb))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                if event.keystroke.key == "escape" { this.dismiss(window, cx); }
                if event.keystroke.modifiers.secondary() && event.keystroke.key == "u" { this.check_updates(true); }
                if !this.text_mode && event.keystroke.modifiers.secondary() && event.keystroke.key == "v" { this.paste_file(cx); }
            }))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                if !this.text_mode { this.upload(paths.paths().to_vec(), None, cx); }
            }))
            .child(div().flex().items_center().justify_between().h(px(42.)).flex_shrink_0()
                .px(px(12.)).border_b_1().border_color(rgba(0x94a3b81f))
                .child(div().font_weight(FontWeight::SEMIBOLD).text_color(rgb(0x38bdf8)).child("QuickDrop")
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move()))
                .child(div().flex().gap(px(3.)).p(px(3.)).rounded(px(9.)).bg(rgba(0x02061766))
                    .child(Button::new("files-tab").small().compact().rounded(px(6.)).label("Files")
                        .custom(ButtonCustomVariant::new(cx)
                            .color(if !self.text_mode { rgba(0x38bdf829) } else { rgba(0x00000000) }.into())
                            .foreground(if !self.text_mode { rgb(0xbae6fd) } else { rgb(0x94a3b8) }.into())
                            .border(if !self.text_mode { rgba(0x38bdf84d) } else { rgba(0x00000000) }.into())
                            .hover(rgba(0x38bdf824).into()))
                        .on_click(cx.listener(|this, _, _, cx| { this.text_mode = false; cx.notify(); })))
                    .child(Button::new("text-tab").small().compact().rounded(px(6.)).label("Text")
                        .custom(ButtonCustomVariant::new(cx)
                            .color(if self.text_mode { rgba(0x38bdf829) } else { rgba(0x00000000) }.into())
                            .foreground(if self.text_mode { rgb(0xbae6fd) } else { rgb(0x94a3b8) }.into())
                            .border(if self.text_mode { rgba(0x38bdf84d) } else { rgba(0x00000000) }.into())
                            .hover(rgba(0x38bdf824).into()))
                        .on_click(cx.listener(|this, _, _, cx| { this.text_mode = true; cx.notify(); }))))
                .child(Button::new("close").ghost().small().label("×").tooltip("Close QuickDrop")
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx)))))
            .child(if self.text_mode { self.render_text(cx) } else { self.render_files(cx) })
    }
}

fn preview(content: &str) -> String {
    let text = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = text.chars();
    let mut result: String = chars.by_ref().take(44).collect();
    if chars.next().is_some() { result.push('…'); }
    result
}

fn display_date(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value).map(|date| date.with_timezone(&chrono::Local).format("%d/%m %H:%M").to_string()).unwrap_or_else(|_| value.into())
}

fn main() -> anyhow::Result<()> {
    let base = std::env::var("QUICKDROP_API_BASE_URL").unwrap_or_else(|_| env!("QUICKDROP_BUILD_BASE_URL").into());
    let base = config::backend_origin(&base, true).map_err(anyhow::Error::msg)?;
    let runtime = Arc::new(tokio::runtime::Runtime::new()?);
    let (native_sender, native_events) = mpsc::channel();
    let Some(instance) = platform::claim_instance(native_sender.clone()).map_err(anyhow::Error::msg)? else { return Ok(()); };
    let tray_start = cfg!(target_os = "macos") || (cfg!(target_os = "windows") && std::env::args().any(|arg| arg == "--tray-start"));
    let app = Application::new();
    let reopen_sender = native_sender.clone();
    app.on_reopen(move |_| { let _ = reopen_sender.send(platform::Event::Show { position: None }); });
    app.run(move |cx| {
        gpui_component::init(cx);
        Theme::change(ThemeMode::Dark, None, cx);
        let theme = Theme::global_mut(cx);
        theme.background = transparent_black();
        theme.foreground = rgb(0xe5e7eb).into();
        theme.muted_foreground = rgb(0x94a3b8).into();
        theme.muted = rgba(0x0f172a85).into();
        theme.primary = rgba(0x0ea5e926).into();
        theme.primary_hover = rgba(0x0ea5e947).into();
        theme.primary_active = rgba(0x0ea5e957).into();
        theme.primary_foreground = rgb(0xe0f2fe).into();
        theme.secondary = rgba(0x0f172a75).into();
        theme.secondary_hover = rgba(0x38bdf829).into();
        theme.secondary_foreground = rgb(0xcbd5e1).into();
        theme.accent = rgba(0x38bdf829).into();
        theme.accent_foreground = rgb(0xe0f2fe).into();
        theme.border = rgba(0x94a3b833).into();
        theme.input = rgba(0x0206177a).into();
        theme.ring = rgba(0x38bdf8a8).into();
        theme.window_border = transparent_black();
        theme.font_family = if cfg!(target_os = "linux") { "Adwaita Sans" } else { ".SystemUIFont" }.into();
        theme.font_size = px(14.);
        theme.radius = px(7.);
        theme.shadow = false;
        cx.on_window_closed(|cx| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        let native_platform = platform::start(native_sender).expect("Could not initialize native desktop integration");
        cx.open_window(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size(px(WIDTH), px(HEIGHT)), cx))),
            titlebar: None, app_id: Some(APP_ID.into()), is_resizable: false,
            window_decorations: Some(WindowDecorations::Client),
            window_background: WindowBackgroundAppearance::Blurred,
            show: !tray_start, focus: !tray_start,
            ..Default::default()
        }, |window, cx| {
            window.set_window_title("QuickDrop");
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            window.on_window_should_close(cx, |window, _| {
                if let Err(error) = platform::hide_window(window) { eprintln!("{error}"); }
                false
            });
            let panel = cx.new(|cx| Panel::new(base, runtime, native_events, native_platform, instance, window, cx));
            cx.new(|cx| Root::new(panel, window, cx))
        }).expect("Could not open QuickDrop GPUI window");
        if !tray_start { cx.activate(true); }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{pin_ready, preview};
    #[test]
    fn previews_preserve_unicode_and_bound_visible_text() {
        assert_eq!(preview("  hello\nworld  "), "hello world");
        assert_eq!(preview(&"á".repeat(45)), format!("{}…", "á".repeat(44)));
    }

    #[test]
    fn pin_readiness_matches_trimmed_server_utf16_length() {
        assert!(!pin_ready("    "));
        assert!(!pin_ready(" 123 "));
        assert!(pin_ready(" 1234 "));
        assert!(pin_ready("🔒🔒"));
        assert!(!pin_ready(&"🔒".repeat(33)));
    }
}
