use futures_util::TryStreamExt;
use reqwest::multipart::{Form, Part};
use std::collections::HashMap;
use std::fs::File as StdFile;
use std::io::BufReader;
#[cfg(target_os = "linux")]
use std::io::Write as _;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Stdio;
use std::process;
#[cfg(target_os = "linux")]
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::window::Color;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri_plugin_autostart::ManagerExt as _;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri_plugin_clipboard_manager::ClipboardExt as _;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri_plugin_notification::NotificationExt as _;
use tokio_util::io::ReaderStream;
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    sent_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    id: String,
    url: String,
    expires_at: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalUploadInput {
    path: String,
    name: String,
    temporary: bool,
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, PartialEq, Eq)]
enum ClipboardSelection {
    Image {
        mime_type: String,
        extension: &'static str,
    },
    Text {
        mime_type: String,
    },
}

struct ClipboardPayload {
    file_name: String,
    bytes: Vec<u8>,
}

struct DesktopConfig {
    api_base_url: String,
}

struct ZipInput {
    path: PathBuf,
    entry_name: String,
}

const WINDOW_WIDTH: f64 = 380.0;
const WINDOW_HEIGHT: f64 = 220.0;
const LAUNCHER_GAP: f64 = 10.0;
#[cfg(any(target_os = "windows", target_os = "macos"))]
const PRODUCTION_API_BASE_URL: &str = "https://quickdrop.eaedave.xyz";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const DEFAULT_API_BASE_URL: &str = PRODUCTION_API_BASE_URL;
#[cfg(target_os = "linux")]
const DEFAULT_API_BASE_URL: &str = "http://127.0.0.1:3000";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const TRAY_ID: &str = "quickdrop-tray";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const TRAY_MENU_OPEN_ID: &str = "open";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const TRAY_MENU_AUTOSTART_ID: &str = "start_at_login";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const TRAY_MENU_UPDATE_ID: &str = "check_for_updates";
#[cfg(target_os = "windows")]
const TRAY_MENU_AUTOSTART_LABEL: &str = "Iniciar com Windows";
#[cfg(target_os = "macos")]
const TRAY_MENU_AUTOSTART_LABEL: &str = "Abrir ao iniciar sessão";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const TRAY_MENU_QUIT_ID: &str = "quit";
#[cfg(any(target_os = "windows", target_os = "macos", test))]
const AUTOSTART_CONFIGURED_MARKER: &str = "autostart-configured";

#[cfg_attr(
    not(any(target_os = "windows", target_os = "macos", test)),
    allow(dead_code)
)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct MonitorArea {
    screen_x: f64,
    screen_y: f64,
    screen_width: f64,
    screen_height: f64,
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
}

impl DesktopConfig {
    fn from_env() -> Self {
        let raw_base_url = std::env::var("QUICKDROP_API_BASE_URL")
            .unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_string());
        let api_base_url = raw_base_url.trim_end_matches('/').to_string();

        Self { api_base_url }
    }
}

#[tauri::command]
async fn upload_file(
    window: tauri::Window,
    path: String,
    state: tauri::State<'_, DesktopConfig>,
) -> Result<UploadResponse, String> {
    upload_single_path(
        window,
        PathBuf::from(path),
        None,
        None,
        state.api_base_url.clone(),
    )
    .await
}

#[tauri::command]
async fn upload_files(
    window: tauri::Window,
    paths: Vec<String>,
    cleanup_paths: Option<Vec<String>>,
    state: tauri::State<'_, DesktopConfig>,
) -> Result<UploadResponse, String> {
    let response = upload_files_from_paths(window, paths, state.api_base_url.clone()).await;

    if let Some(paths) = cleanup_paths {
        cleanup_temporary_upload_paths(&paths).await;
    }

    response
}

async fn upload_files_from_paths(
    window: tauri::Window,
    paths: Vec<String>,
    api_base_url: String,
) -> Result<UploadResponse, String> {
    if paths.is_empty() {
        return Err("Selecione pelo menos um arquivo.".to_string());
    }

    if paths.len() == 1 {
        return upload_single_path(
            window,
            PathBuf::from(paths[0].clone()),
            None,
            None,
            api_base_url,
        )
        .await;
    }

    let inputs = validate_zip_inputs(&paths).await?;
    let zip_path = temp_zip_path();
    let zip_file_name = format!("quickdrop-{}-arquivos.zip", inputs.len());
    let zip_path_for_task = zip_path.clone();

    tokio::task::spawn_blocking(move || create_zip_archive(&zip_path_for_task, &inputs))
        .await
        .map_err(|error| format!("Falha ao criar ZIP: {error}"))??;

    let response = upload_single_path(
        window,
        zip_path.clone(),
        Some(zip_file_name),
        Some("application/zip".to_string()),
        api_base_url,
    )
    .await;

    if let Err(error) = tokio::fs::remove_file(&zip_path).await {
        eprintln!("Failed to remove temporary QuickDrop ZIP: {error}");
    }

    response
}

async fn upload_single_path(
    window: tauri::Window,
    path: PathBuf,
    file_name_override: Option<String>,
    mime_type_override: Option<String>,
    api_base_url: String,
) -> Result<UploadResponse, String> {
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| "Arquivo não encontrado.".to_string())?;

    if !metadata.is_file() {
        return Err("Selecione um arquivo regular.".to_string());
    }

    let total_bytes = metadata.len();

    if total_bytes == 0 {
        return Err("Arquivo vazio não é permitido.".to_string());
    }

    let file_name = match file_name_override {
        Some(file_name) => file_name,
        None => file_name_of(&path)?,
    };
    let mime_type = mime_type_override.unwrap_or_else(|| {
        mime_guess::from_path(&path)
            .first_or_octet_stream()
            .to_string()
    });
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| "Não foi possível abrir o arquivo.".to_string())?;
    let mut sent_bytes = 0_u64;
    let progress_window = window.clone();
    let progress_stream = ReaderStream::new(file).map_ok(move |chunk| {
        sent_bytes = sent_bytes.saturating_add(chunk.len() as u64);
        let percent = ((sent_bytes.saturating_mul(100)) / total_bytes).min(100) as u8;
        let _ = progress_window.emit(
            "upload-progress",
            UploadProgress {
                sent_bytes,
                total_bytes,
                percent,
            },
        );
        chunk
    });
    let body = reqwest::Body::wrap_stream(progress_stream);
    let part = Part::stream_with_length(body, total_bytes)
        .file_name(file_name)
        .mime_str(&mime_type)
        .map_err(|error| format!("MIME inválido: {error}"))?;
    let form = Form::new().part("file", part);
    let response = reqwest::Client::new()
        .post(format!("{}/api/upload", api_base_url))
        .header("x-quickdrop-file-size", total_bytes.to_string())
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("Falha ao enviar arquivo: {error}"))?;

    if !response.status().is_success() {
        return Err(response
            .text()
            .await
            .unwrap_or_else(|_| "Falha no upload.".to_string()));
    }

    response
        .json::<UploadResponse>()
        .await
        .map_err(|error| format!("Resposta inválida do servidor: {error}"))
}

async fn validate_zip_inputs(paths: &[String]) -> Result<Vec<ZipInput>, String> {
    let mut archive_names = HashMap::new();
    let mut inputs = Vec::with_capacity(paths.len());

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        let display_name = display_name(&path);
        let metadata = tokio::fs::metadata(&path)
            .await
            .map_err(|_| format!("Arquivo não encontrado: {display_name}"))?;

        if !metadata.is_file() {
            return Err(format!(
                "Selecione apenas arquivos regulares: {display_name}"
            ));
        }

        if metadata.len() == 0 {
            return Err(format!("Arquivo vazio não é permitido: {display_name}"));
        }

        let entry_name = unique_archive_name(file_name_of(&path)?, &mut archive_names);
        inputs.push(ZipInput { path, entry_name });
    }

    Ok(inputs)
}

fn create_zip_archive(zip_path: &Path, inputs: &[ZipInput]) -> Result<(), String> {
    let file = StdFile::create(zip_path).map_err(|error| format!("Falha ao criar ZIP: {error}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    for input in inputs {
        let source = StdFile::open(&input.path)
            .map_err(|error| format!("Falha ao abrir {}: {error}", display_name(&input.path)))?;
        let mut reader = BufReader::new(source);

        zip.start_file(input.entry_name.as_str(), options)
            .map_err(|error| format!("Falha ao adicionar {} ao ZIP: {error}", input.entry_name))?;
        std::io::copy(&mut reader, &mut zip)
            .map_err(|error| format!("Falha ao escrever {} no ZIP: {error}", input.entry_name))?;
    }

    zip.finish()
        .map_err(|error| format!("Falha ao finalizar ZIP: {error}"))?;

    Ok(())
}

fn unique_archive_name(file_name: String, archive_names: &mut HashMap<String, usize>) -> String {
    let count = archive_names.entry(file_name.clone()).or_insert(0);
    *count += 1;

    if *count == 1 {
        return file_name;
    }

    let path = Path::new(&file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name.as_str());
    let extension = path.extension().and_then(|value| value.to_str());

    match extension {
        Some(extension) if !extension.is_empty() => format!("{stem}-{}.{}", *count, extension),
        _ => format!("{stem}-{}", *count),
    }
}

fn file_name_of(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| "Nome do arquivo inválido.".to_string())
}

fn display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn temp_zip_path() -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    std::env::temp_dir().join(format!("quickdrop-{}-{timestamp}.zip", process::id()))
}

fn temp_clipboard_path(file_name: &str) -> PathBuf {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();

    std::env::temp_dir().join(format!(
        "quickdrop-clipboard-{}-{timestamp}-{file_name}",
        process::id()
    ))
}

#[tauri::command]
fn read_clipboard_upload_inputs(app: AppHandle) -> Result<Vec<LocalUploadInput>, String> {
    let payload = read_clipboard_payload_for_platform(&app)?;
    let path = temp_clipboard_path(&payload.file_name);

    std::fs::write(&path, payload.bytes)
        .map_err(|error| format!("Falha ao preparar clipboard para upload: {error}"))?;

    Ok(vec![LocalUploadInput {
        path: path.to_string_lossy().to_string(),
        name: payload.file_name,
        temporary: true,
    }])
}

#[cfg(target_os = "linux")]
fn read_clipboard_payload_for_platform(_app: &AppHandle) -> Result<ClipboardPayload, String> {
    read_wayland_clipboard_payload()
}

#[cfg(target_os = "macos")]
fn read_clipboard_payload_for_platform(app: &AppHandle) -> Result<ClipboardPayload, String> {
    if let Ok(image) = app.clipboard().read_image() {
        if image.width() > 0 && image.height() > 0 && !image.rgba().is_empty() {
            return Ok(ClipboardPayload {
                file_name: "quickdrop-clipboard.png".to_string(),
                bytes: encode_rgba_png(image.width(), image.height(), image.rgba())?,
            });
        }
    }

    let text = app
        .clipboard()
        .read_text()
        .map_err(|_| "Clipboard sem imagem ou texto para enviar.".to_string())?;
    if text.is_empty() {
        return Err("Clipboard sem imagem ou texto para enviar.".to_string());
    }

    Ok(ClipboardPayload {
        file_name: "quickdrop-paste.txt".to_string(),
        bytes: text.into_bytes(),
    })
}

#[cfg(any(target_os = "macos", test))]
fn encode_rgba_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("Falha ao preparar imagem do clipboard: {error}"))?;
        writer
            .write_image_data(rgba)
            .map_err(|error| format!("Falha ao preparar imagem do clipboard: {error}"))?;
    }
    Ok(bytes)
}

#[cfg(target_os = "windows")]
fn read_clipboard_payload_for_platform(_app: &AppHandle) -> Result<ClipboardPayload, String> {
    Err("Clipboard nativo indisponível nesta plataforma.".to_string())
}

#[cfg(target_os = "linux")]
fn read_wayland_clipboard_payload() -> Result<ClipboardPayload, String> {
    let types = list_clipboard_types()?;
    let selection = select_clipboard_type(&types)
        .ok_or_else(|| "Clipboard sem imagem ou texto para enviar.".to_string())?;

    match selection {
        ClipboardSelection::Image {
            mime_type,
            extension,
        } => {
            let bytes = read_clipboard_bytes(&mime_type)?;
            if bytes.is_empty() {
                return Err("Clipboard sem imagem para enviar.".to_string());
            }

            Ok(ClipboardPayload {
                file_name: format!("quickdrop-clipboard.{extension}"),
                bytes,
            })
        }
        ClipboardSelection::Text { mime_type } => {
            let bytes = read_clipboard_text_bytes(&mime_type)?;
            if bytes.is_empty() {
                return Err("Clipboard sem texto para enviar.".to_string());
            }

            Ok(ClipboardPayload {
                file_name: "quickdrop-paste.txt".to_string(),
                bytes,
            })
        }
    }
}

#[cfg(target_os = "linux")]
fn list_clipboard_types() -> Result<Vec<String>, String> {
    let output = Command::new("wl-paste")
        .arg("--list-types")
        .output()
        .map_err(|error| format!("wl-paste não encontrado ou falhou ao iniciar: {error}"))?;

    if !output.status.success() {
        return Err("Clipboard sem imagem ou texto para enviar.".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

#[cfg(any(target_os = "linux", test))]
fn select_clipboard_type(types: &[String]) -> Option<ClipboardSelection> {
    for clipboard_type in types {
        if let Some(extension) = image_extension_for_mime_type(clipboard_type) {
            return Some(ClipboardSelection::Image {
                mime_type: clipboard_type.clone(),
                extension,
            });
        }
    }

    for clipboard_type in types {
        if is_plain_text_clipboard_type(clipboard_type) {
            return Some(ClipboardSelection::Text {
                mime_type: clipboard_type.clone(),
            });
        }
    }

    None
}

#[cfg(any(target_os = "linux", test))]
fn image_extension_for_mime_type(mime_type: &str) -> Option<&'static str> {
    let base_type = mime_type
        .split(';')
        .next()
        .unwrap_or(mime_type)
        .trim()
        .to_ascii_lowercase();

    match base_type.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/bmp" => Some("bmp"),
        "image/tiff" => Some("tiff"),
        "image/svg+xml" => Some("svg"),
        value if value.starts_with("image/") => Some("img"),
        _ => None,
    }
}

#[cfg(any(target_os = "linux", test))]
fn is_plain_text_clipboard_type(clipboard_type: &str) -> bool {
    let base_type = clipboard_type
        .split(';')
        .next()
        .unwrap_or(clipboard_type)
        .trim()
        .to_ascii_lowercase();

    matches!(
        base_type.as_str(),
        "text/plain" | "utf8_string" | "text" | "string"
    )
}

#[cfg(target_os = "linux")]
fn read_clipboard_bytes(mime_type: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("wl-paste")
        .arg("--type")
        .arg(mime_type)
        .output()
        .map_err(|error| format!("wl-paste não encontrou o conteúdo do clipboard: {error}"))?;

    if !output.status.success() {
        return Err("Não foi possível ler imagem do clipboard.".to_string());
    }

    Ok(output.stdout)
}

#[cfg(target_os = "linux")]
fn read_clipboard_text_bytes(mime_type: &str) -> Result<Vec<u8>, String> {
    let output = Command::new("wl-paste")
        .arg("--no-newline")
        .arg("--type")
        .arg(mime_type)
        .output()
        .map_err(|error| format!("wl-paste não encontrou texto no clipboard: {error}"))?;

    if !output.status.success() {
        return Err("Não foi possível ler texto do clipboard.".to_string());
    }

    Ok(output.stdout)
}

async fn cleanup_temporary_upload_paths(paths: &[String]) {
    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        if !is_quickdrop_clipboard_temp_path(&path) {
            continue;
        }

        if let Err(error) = tokio::fs::remove_file(&path).await {
            eprintln!("Failed to remove temporary QuickDrop clipboard file: {error}");
        }
    }
}

fn is_quickdrop_clipboard_temp_path(path: &Path) -> bool {
    if path.parent() != Some(std::env::temp_dir().as_path()) {
        return false;
    }

    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("quickdrop-clipboard-"))
}

#[tauri::command]
fn copy_link(app: AppHandle, link: String) -> Result<(), String> {
    copy_link_for_platform(&app, link)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn copy_link_for_platform(app: &AppHandle, link: String) -> Result<(), String> {
    app.clipboard()
        .write_text(link)
        .map_err(|error| format!("Falha ao copiar link para o clipboard: {error}"))
}

#[cfg(target_os = "linux")]
fn copy_link_for_platform(_app: &AppHandle, link: String) -> Result<(), String> {
    let mut child = Command::new("wl-copy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("wl-copy não encontrado ou falhou ao iniciar: {error}"))?;

    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "Não foi possível abrir stdin do wl-copy.".to_string())?;
    stdin
        .write_all(link.as_bytes())
        .map_err(|error| format!("Falha ao escrever no wl-copy: {error}"))?;
    drop(child.stdin.take());

    let status = child
        .wait()
        .map_err(|error| format!("Falha ao aguardar wl-copy: {error}"))?;

    if !status.success() {
        return Err("wl-copy retornou erro.".to_string());
    }

    Ok(())
}

#[tauri::command]
fn notify_success(app: AppHandle, file_count: Option<usize>) -> Result<(), String> {
    notify_success_for_platform(&app, upload_success_message(file_count))
}

fn upload_success_message(file_count: Option<usize>) -> String {
    match file_count.unwrap_or(1) {
        1 => "Upload concluído. Link copiado para a área de transferência.".to_string(),
        count => format!(
            "{count} arquivos enviados em um ZIP. Link copiado para a área de transferência."
        ),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn notify_success_for_platform(app: &AppHandle, message: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title("QuickDrop")
        .body(message)
        .show()
        .map_err(|error| format!("Falha ao exibir notificação: {error}"))
}

#[cfg(target_os = "linux")]
fn notify_success_for_platform(_app: &AppHandle, message: String) -> Result<(), String> {
    let status = Command::new("notify-send")
        .arg("QuickDrop")
        .arg(message)
        .status()
        .map_err(|error| format!("notify-send não encontrado ou falhou ao iniciar: {error}"))?;

    if !status.success() {
        return Err("notify-send retornou erro.".to_string());
    }

    Ok(())
}
#[tauri::command]
fn get_api_base_url(state: tauri::State<'_, DesktopConfig>) -> String {
    state.api_base_url.clone()
}

#[tauri::command]
fn dismiss_window(window: tauri::Window) -> Result<(), String> {
    dismiss_window_for_platform(&window)
        .map_err(|error| format!("Falha ao fechar janela QuickDrop: {error}"))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn dismiss_window_for_platform(window: &tauri::Window) -> tauri::Result<()> {
    window.hide()
}

#[cfg(target_os = "linux")]
fn dismiss_window_for_platform(window: &tauri::Window) -> tauri::Result<()> {
    window.close()
}

#[tauri::command]
fn uses_native_clipboard_paste() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

#[cfg(target_os = "linux")]
fn compute_window_position(app: &AppHandle) -> (f64, f64) {
    let launch_point = launcher_position_from_env()
        .or_else(|| app.cursor_position().ok())
        .unwrap_or_else(|| PhysicalPosition::new(WINDOW_WIDTH, WINDOW_HEIGHT));
    let monitor_area = app
        .monitor_from_point(launch_point.x, launch_point.y)
        .ok()
        .flatten()
        .map(|monitor| monitor_area_from_monitor(&monitor));

    compute_anchor_window_position(launch_point, monitor_area)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn compute_window_position(app: &AppHandle) -> (f64, f64) {
    compute_desktop_tray_window_position(app)
}

fn compute_anchor_window_position(
    launch_point: PhysicalPosition<f64>,
    monitor_area: Option<MonitorArea>,
) -> (f64, f64) {
    let x = launch_point.x - (WINDOW_WIDTH / 2.0);
    let y = launch_point.y + LAUNCHER_GAP;

    match monitor_area {
        Some(area) => clamp_window_position(x, y, area),
        None => (x.round(), y.round()),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn compute_desktop_tray_window_position(app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        return compute_tray_window_position(monitor_area_from_monitor(&monitor));
    }

    if let Ok(cursor_position) = app.cursor_position() {
        if let Ok(Some(monitor)) = app.monitor_from_point(cursor_position.x, cursor_position.y) {
            return compute_tray_window_position(monitor_area_from_monitor(&monitor));
        }
    }

    (
        (WINDOW_WIDTH + LAUNCHER_GAP).round(),
        (WINDOW_HEIGHT + LAUNCHER_GAP).round(),
    )
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn compute_tray_window_position(area: MonitorArea) -> (f64, f64) {
    let taskbar_left = area.work_x > area.screen_x;
    let taskbar_right = area.work_right() < area.screen_right();
    let taskbar_top = area.work_y > area.screen_y;
    let taskbar_bottom = area.work_bottom() < area.screen_bottom();

    let x = if taskbar_left && !taskbar_right && !taskbar_top && !taskbar_bottom {
        area.work_x + LAUNCHER_GAP
    } else {
        area.work_right() - WINDOW_WIDTH - LAUNCHER_GAP
    };

    let y = if taskbar_top && !taskbar_bottom {
        area.work_y + LAUNCHER_GAP
    } else {
        area.work_bottom() - WINDOW_HEIGHT - LAUNCHER_GAP
    };

    clamp_window_position(x, y, area)
}

fn clamp_window_position(x: f64, y: f64, area: MonitorArea) -> (f64, f64) {
    let max_x = (area.work_right() - WINDOW_WIDTH).max(area.work_x);
    let max_y = (area.work_bottom() - WINDOW_HEIGHT).max(area.work_y);

    (
        x.clamp(area.work_x, max_x).round(),
        y.clamp(area.work_y, max_y).round(),
    )
}

fn monitor_area_from_monitor(monitor: &tauri::window::Monitor) -> MonitorArea {
    let position = monitor.position();
    let size = monitor.size();
    let work_area = monitor.work_area();

    MonitorArea {
        screen_x: f64::from(position.x),
        screen_y: f64::from(position.y),
        screen_width: f64::from(size.width),
        screen_height: f64::from(size.height),
        work_x: f64::from(work_area.position.x),
        work_y: f64::from(work_area.position.y),
        work_width: f64::from(work_area.size.width),
        work_height: f64::from(work_area.size.height),
    }
}

impl MonitorArea {
    #[cfg(any(target_os = "windows", target_os = "macos", test))]
    fn screen_right(self) -> f64 {
        self.screen_x + self.screen_width
    }

    #[cfg(any(target_os = "windows", target_os = "macos", test))]
    fn screen_bottom(self) -> f64 {
        self.screen_y + self.screen_height
    }

    fn work_right(self) -> f64 {
        self.work_x + self.work_width
    }

    fn work_bottom(self) -> f64 {
        self.work_y + self.work_height
    }
}

#[cfg(target_os = "linux")]
fn launcher_position_from_env() -> Option<PhysicalPosition<f64>> {
    let x = std::env::var("QUICKDROP_LAUNCHER_X")
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()?;
    let y = std::env::var("QUICKDROP_LAUNCHER_Y")
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()?;

    Some(PhysicalPosition::new(x, y))
}

fn build_quickdrop_window(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    let (x, y) = compute_window_position(app);

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("QuickDrop")
        .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
        .position(x, y)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .shadow(false)
        .always_on_top(true)
        .visible(visible)
        .build()
}

fn show_quickdrop_window(app: &AppHandle) -> tauri::Result<()> {
    show_quickdrop_window_at(app, None)
}

fn show_quickdrop_window_at(
    app: &AppHandle,
    launch_point: Option<PhysicalPosition<f64>>,
) -> tauri::Result<()> {
    let window = match app.get_webview_window("main") {
        Some(window) => window,
        None => build_quickdrop_window(app, false)?,
    };
    let (x, y) = match launch_point {
        Some(launch_point) => compute_window_position_from_anchor(app, launch_point),
        None => compute_window_position(app),
    };

    window.set_position(PhysicalPosition::new(x, y))?;
    window.show()?;
    window.unminimize()?;
    window.set_focus()?;

    Ok(())
}

fn compute_window_position_from_anchor(
    app: &AppHandle,
    launch_point: PhysicalPosition<f64>,
) -> (f64, f64) {
    let monitor_area = app
        .monitor_from_point(launch_point.x, launch_point.y)
        .ok()
        .flatten()
        .map(|monitor| monitor_area_from_monitor(&monitor));

    compute_anchor_window_position(launch_point, monitor_area)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn tray_event_position_to_physical(position: tauri::Position) -> PhysicalPosition<f64> {
    match position {
        tauri::Position::Physical(position) => {
            PhysicalPosition::new(f64::from(position.x), f64::from(position.y))
        }
        tauri::Position::Logical(position) => PhysicalPosition::new(position.x, position.y),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos", test))]
fn autostart_configured_marker_path(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join(AUTOSTART_CONFIGURED_MARKER)
}

#[cfg(any(target_os = "windows", test))]
fn should_enable_initial_autostart(
    configured_marker_exists: bool,
    autostart_enabled: bool,
) -> bool {
    !configured_marker_exists && !autostart_enabled
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn write_autostart_configured_marker(marker_path: &Path) -> std::io::Result<()> {
    if let Some(parent) = marker_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    std::fs::write(marker_path, "configured=true\n")
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn desktop_autostart_marker_path(app: &AppHandle) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(path) => Some(autostart_configured_marker_path(&path)),
        Err(error) => {
            eprintln!("Failed to resolve QuickDrop config directory: {error}");
            None
        }
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn persist_desktop_autostart_configured(app: &AppHandle) {
    let Some(marker_path) = desktop_autostart_marker_path(app) else {
        return;
    };

    if let Err(error) = write_autostart_configured_marker(&marker_path) {
        eprintln!("Failed to persist QuickDrop autostart setup marker: {error}");
    }
}

#[cfg(target_os = "windows")]
fn ensure_initial_windows_autostart(app: &AppHandle) {
    let Some(marker_path) = desktop_autostart_marker_path(app) else {
        return;
    };
    let marker_exists = marker_path.exists();

    if marker_exists {
        return;
    }

    let currently_enabled = app.autolaunch().is_enabled().unwrap_or(false);
    if should_enable_initial_autostart(marker_exists, currently_enabled) {
        if let Err(error) = app.autolaunch().enable() {
            eprintln!("Failed to enable QuickDrop autostart on first Windows launch: {error}");
            return;
        }
    }

    persist_desktop_autostart_configured(app);
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn setup_desktop_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_item = MenuItem::with_id(
        app,
        TRAY_MENU_OPEN_ID,
        "Abrir QuickDrop",
        true,
        None::<&str>,
    )?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        TRAY_MENU_AUTOSTART_ID,
        TRAY_MENU_AUTOSTART_LABEL,
        true,
        app.handle().autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let update_item = MenuItem::with_id(
        app,
        TRAY_MENU_UPDATE_ID,
        "Verificar atualizações…",
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT_ID, "Sair", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open_item, &autostart_item, &update_item, &separator, &quit_item],
    )?;
    let autostart_item_for_menu = autostart_item.clone();
    #[cfg(target_os = "windows")]
    let tray_icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;
    #[cfg(target_os = "macos")]
    let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon-template.png"))?;
    let tray_builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon)
        .tooltip("QuickDrop");
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);

    tray_builder
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            TRAY_MENU_OPEN_ID => {
                if let Err(error) = show_quickdrop_window(app) {
                    eprintln!("Failed to show QuickDrop from tray menu: {error}");
                }
            }
            TRAY_MENU_UPDATE_ID => {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.emit("quickdrop://check-for-updates", ()) {
                        eprintln!("Failed to request a QuickDrop update check: {error}");
                    }
                }
            }
            TRAY_MENU_AUTOSTART_ID => {
                let currently_enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let result = if currently_enabled {
                    app.autolaunch().disable()
                } else {
                    app.autolaunch().enable()
                };

                match result {
                    Ok(()) => {
                        let _ = autostart_item_for_menu.set_checked(!currently_enabled);
                        persist_desktop_autostart_configured(app);
                    }
                    Err(error) => {
                        eprintln!("Failed to toggle QuickDrop autostart: {error}");
                        let _ = autostart_item_for_menu.set_checked(currently_enabled);
                    }
                }
            }
            TRAY_MENU_QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let launch_point = tray_event_position_to_physical(rect.position);
                if let Err(error) = show_quickdrop_window_at(tray.app_handle(), Some(launch_point))
                {
                    eprintln!("Failed to show QuickDrop from tray click: {error}");
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(target_os = "windows")]
fn started_in_tray_mode() -> bool {
    std::env::args().any(|arg| arg == "--tray-start")
}

#[cfg(target_os = "macos")]
fn started_in_tray_mode() -> bool {
    true
}

#[cfg(target_os = "linux")]
fn started_in_tray_mode() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::ffi::OsString;
    use std::fs;
    use std::io::Read as _;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(target_os = "linux")]
    struct PathGuard {
        original: Option<OsString>,
    }

    #[cfg(target_os = "linux")]
    impl Drop for PathGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => env::set_var("PATH", value),
                None => env::remove_var("PATH"),
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn prepend_path_for_test(dir: &Path) -> PathGuard {
        let original = env::var_os("PATH");
        let mut paths = vec![dir.to_path_buf()];

        if let Some(original_value) = &original {
            paths.extend(env::split_paths(original_value));
        }

        let joined = env::join_paths(paths).unwrap();
        env::set_var("PATH", joined);

        PathGuard { original }
    }

    struct EnvVarGuard {
        key: &'static str,
        original: Option<OsString>,
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(value) => env::set_var(self.key, value),
                None => env::remove_var(self.key),
            }
        }
    }

    fn remove_env_var_for_test(key: &'static str) -> EnvVarGuard {
        let original = env::var_os(key);
        env::remove_var(key);

        EnvVarGuard { key, original }
    }

    fn set_env_var_for_test(key: &'static str, value: &str) -> EnvVarGuard {
        let original = env::var_os(key);
        env::set_var(key, value);

        EnvVarGuard { key, original }
    }

    #[cfg(target_os = "linux")]
    fn write_executable(path: &Path, contents: &str) {
        fs::write(path, contents).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn desktop_config_uses_platform_default_api_url_when_env_missing() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = remove_env_var_for_test("QUICKDROP_API_BASE_URL");

        assert_eq!(DesktopConfig::from_env().api_base_url, DEFAULT_API_BASE_URL);

        #[cfg(target_os = "windows")]
        assert_eq!(
            DesktopConfig::from_env().api_base_url,
            PRODUCTION_API_BASE_URL
        );
    }

    #[test]
    fn desktop_config_trims_api_url_env_override() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _guard = set_env_var_for_test("QUICKDROP_API_BASE_URL", "https://example.com///");

        assert_eq!(
            DesktopConfig::from_env().api_base_url,
            "https://example.com"
        );
    }

    #[test]
    fn initial_autostart_only_enables_before_first_configuration() {
        assert!(should_enable_initial_autostart(false, false));
        assert!(!should_enable_initial_autostart(false, true));
        assert!(!should_enable_initial_autostart(true, false));
        assert!(!should_enable_initial_autostart(true, true));
    }

    #[test]
    fn autostart_configured_marker_lives_in_app_config_dir() {
        let path = autostart_configured_marker_path(Path::new("QuickDrop"));

        assert_eq!(
            path,
            Path::new("QuickDrop").join(AUTOSTART_CONFIGURED_MARKER)
        );
    }

    #[test]
    fn tray_window_position_uses_bottom_right_work_area() {
        let area = MonitorArea {
            screen_x: 0.0,
            screen_y: 0.0,
            screen_width: 1920.0,
            screen_height: 1080.0,
            work_x: 0.0,
            work_y: 0.0,
            work_width: 1920.0,
            work_height: 1040.0,
        };

        assert_eq!(compute_tray_window_position(area), (1530.0, 810.0));
    }

    #[test]
    fn tray_window_position_handles_top_taskbar() {
        let area = MonitorArea {
            screen_x: 0.0,
            screen_y: 0.0,
            screen_width: 1920.0,
            screen_height: 1080.0,
            work_x: 0.0,
            work_y: 40.0,
            work_width: 1920.0,
            work_height: 1040.0,
        };

        assert_eq!(compute_tray_window_position(area), (1530.0, 50.0));
    }

    #[test]
    fn tray_click_anchor_clamps_window_above_taskbar() {
        let area = MonitorArea {
            screen_x: 0.0,
            screen_y: 0.0,
            screen_width: 1920.0,
            screen_height: 1080.0,
            work_x: 0.0,
            work_y: 0.0,
            work_width: 1920.0,
            work_height: 1040.0,
        };

        assert_eq!(
            compute_anchor_window_position(PhysicalPosition::new(1850.0, 1040.0), Some(area)),
            (1540.0, 820.0)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn wayland_clipboard_payload_reads_image_bytes() {
        let _lock = ENV_LOCK.lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "quickdrop-wl-paste-test-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        let wl_paste = root.join("wl-paste");
        write_executable(
            &wl_paste,
            r#"#!/usr/bin/env sh
if [ "$1" = "--list-types" ]; then
  printf 'text/plain\nimage/png\n'
  exit 0
fi

if [ "$1" = "--type" ] && [ "$2" = "image/png" ]; then
  printf 'image-bytes'
  exit 0
fi

exit 1
"#,
        );

        let _path_guard = prepend_path_for_test(&root);
        let payload = read_wayland_clipboard_payload().unwrap();

        assert_eq!(payload.file_name, "quickdrop-clipboard.png");
        assert_eq!(payload.bytes, b"image-bytes");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn create_zip_archive_keeps_files_and_deduplicates_names() {
        let root = std::env::temp_dir().join(format!(
            "quickdrop-zip-test-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis())
                .unwrap_or_default()
        ));
        let left_dir = root.join("left");
        let right_dir = root.join("right");
        fs::create_dir_all(&left_dir).unwrap();
        fs::create_dir_all(&right_dir).unwrap();
        let left_file = left_dir.join("same.txt");
        let right_file = right_dir.join("same.txt");
        fs::write(&left_file, "left").unwrap();
        fs::write(&right_file, "right").unwrap();

        let mut archive_names = HashMap::new();
        let inputs = vec![
            ZipInput {
                entry_name: unique_archive_name(
                    file_name_of(&left_file).unwrap(),
                    &mut archive_names,
                ),
                path: left_file,
            },
            ZipInput {
                entry_name: unique_archive_name(
                    file_name_of(&right_file).unwrap(),
                    &mut archive_names,
                ),
                path: right_file,
            },
        ];
        let zip_path = root.join("quickdrop.zip");

        create_zip_archive(&zip_path, &inputs).unwrap();

        let file = StdFile::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut first = String::new();
        let mut second = String::new();
        archive
            .by_name("same.txt")
            .unwrap()
            .read_to_string(&mut first)
            .unwrap();
        archive
            .by_name("same-2.txt")
            .unwrap()
            .read_to_string(&mut second)
            .unwrap();

        assert_eq!(first, "left");
        assert_eq!(second, "right");

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn clipboard_type_prefers_image_over_text() {
        let types = vec![
            "text/plain;charset=utf-8".to_string(),
            "image/png".to_string(),
        ];

        assert_eq!(
            select_clipboard_type(&types),
            Some(ClipboardSelection::Image {
                mime_type: "image/png".to_string(),
                extension: "png",
            })
        );
    }

    #[test]
    fn macos_clipboard_image_is_encoded_as_png() {
        let png = encode_rgba_png(1, 1, &[255, 0, 0, 255]).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn clipboard_type_accepts_plain_text_without_file_uris() {
        assert_eq!(
            select_clipboard_type(&["text/plain;charset=utf-8".to_string()]),
            Some(ClipboardSelection::Text {
                mime_type: "text/plain;charset=utf-8".to_string(),
            })
        );
        assert_eq!(select_clipboard_type(&["text/uri-list".to_string()]), None);
    }

    #[test]
    fn cleanup_only_accepts_quickdrop_clipboard_temp_files() {
        let temp_path = std::env::temp_dir().join("quickdrop-clipboard-123-image.png");
        let user_path = PathBuf::from("/home/user/quickdrop-clipboard-123-image.png");
        let other_temp_path = std::env::temp_dir().join("not-quickdrop.png");

        assert!(is_quickdrop_clipboard_temp_path(&temp_path));
        assert!(!is_quickdrop_clipboard_temp_path(&user_path));
        assert!(!is_quickdrop_clipboard_temp_path(&other_temp_path));
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|arg| arg == "--tray-start") {
                return;
            }

            if let Err(error) = show_quickdrop_window(app) {
                eprintln!("Failed to show existing QuickDrop window: {error}");
            }
        }));

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--tray-start"]),
    ));

    builder
        .manage(DesktopConfig::from_env())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(target_os = "windows")]
            ensure_initial_windows_autostart(app.handle());

            #[cfg(any(target_os = "windows", target_os = "macos"))]
            setup_desktop_tray(app)?;

            build_quickdrop_window(app.handle(), !started_in_tray_mode())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            upload_file,
            upload_files,
            read_clipboard_upload_inputs,
            copy_link,
            notify_success,
            get_api_base_url,
            dismiss_window,
            uses_native_clipboard_paste
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
