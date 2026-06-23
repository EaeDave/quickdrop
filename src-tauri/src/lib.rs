use futures_util::TryStreamExt;
use reqwest::multipart::{Form, Part};
use std::collections::HashMap;
use std::fs::File as StdFile;
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{self, Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::window::Color;
use tauri::{Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
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

struct DesktopConfig {
    api_base_url: String,
}

struct ZipInput {
    path: PathBuf,
    entry_name: String,
}

const WINDOW_WIDTH: f64 = 500.0;
const WINDOW_HEIGHT: f64 = 300.0;
const LAUNCHER_GAP: f64 = 10.0;

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
    state: tauri::State<'_, DesktopConfig>,
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
            state.api_base_url.clone(),
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
        state.api_base_url.clone(),
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
fn notify_success(file_count: Option<usize>) -> Result<(), String> {
    let message = match file_count.unwrap_or(1) {
        1 => "Upload concluído. Link copiado para a área de transferência.".to_string(),
        count => format!(
            "{count} arquivos enviados em um ZIP. Link copiado para a área de transferência."
        ),
    };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Read as _;

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
}

pub fn run() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
        .invoke_handler(tauri::generate_handler![
            upload_file,
            upload_files,
            copy_link,
            notify_success
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
