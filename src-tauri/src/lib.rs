use futures_util::TryStreamExt;
use reqwest::multipart::{Form, Part};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use tauri::window::Color;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
use tokio_util::io::ReaderStream;

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

const WINDOW_WIDTH: f64 = 500.0;
const WINDOW_HEIGHT: f64 = 300.0;
const LAUNCHER_GAP: f64 = 10.0;

struct DesktopConfig {
    api_base_url: String,
}

impl DesktopConfig {
    fn from_env() -> Self {
        let raw_base_url = std::env::var("QUICKDROP_API_BASE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());
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

    let file_name = Path::new(&path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Nome do arquivo inválido.".to_string())?
        .to_string();
    let mime_type = mime_guess::from_path(&path).first_or_octet_stream().to_string();
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
        .post(format!("{}/api/upload", state.api_base_url))
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

#[tauri::command]
fn copy_link(link: String) -> Result<(), String> {
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
fn notify_success() -> Result<(), String> {
    let status = Command::new("notify-send")
        .arg("QuickDrop")
        .arg("Upload concluído. Link copiado para a área de transferência.")
        .status()
        .map_err(|error| format!("notify-send não encontrado ou falhou ao iniciar: {error}"))?;

    if !status.success() {
        return Err("notify-send retornou erro.".to_string());
    }

    Ok(())
}

fn compute_window_position(app: &tauri::App) -> (f64, f64) {
    let launch_point = launcher_position_from_env()
        .or_else(|| app.cursor_position().ok())
        .unwrap_or_else(|| PhysicalPosition::new(WINDOW_WIDTH, WINDOW_HEIGHT));
    let mut x = launch_point.x - (WINDOW_WIDTH / 2.0);
    let mut y = launch_point.y + LAUNCHER_GAP;

    if let Ok(Some(monitor)) = app.monitor_from_point(launch_point.x, launch_point.y) {
        let work_area = monitor.work_area();
        let min_x = f64::from(work_area.position.x);
        let min_y = f64::from(work_area.position.y);
        let max_x = min_x + f64::from(work_area.size.width) - WINDOW_WIDTH;
        let max_y = min_y + f64::from(work_area.size.height) - WINDOW_HEIGHT;

        x = x.clamp(min_x, max_x.max(min_x));
        y = y.clamp(min_y, max_y.max(min_y));
    }

    (x.round(), y.round())
}

fn launcher_position_from_env() -> Option<PhysicalPosition<f64>> {
    let x = std::env::var("QUICKDROP_LAUNCHER_X").ok()?.trim().parse::<f64>().ok()?;
    let y = std::env::var("QUICKDROP_LAUNCHER_Y").ok()?.trim().parse::<f64>().ok()?;

    Some(PhysicalPosition::new(x, y))
}


pub fn run() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(DesktopConfig::from_env())
        .setup(|app| {
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
                .visible(true)
                .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![upload_file, copy_link, notify_success])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
