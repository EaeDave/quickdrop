use std::{
    collections::HashSet,
    fs::File,
    io::{BufReader, Seek, Write},
    path::{Path, PathBuf},
    sync::mpsc::Sender,
    time::Duration,
};
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};

use futures_util::TryStreamExt;
use reqwest::multipart::{Form, Part};
use tempfile::NamedTempFile;
use tokio_util::io::ReaderStream;
use zip::{write::SimpleFileOptions, CompressionMethod};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub url: String,
    pub expires_at: String,
}

pub async fn upload(
    mut paths: Vec<PathBuf>,
    base_url: String,
    progress: Sender<u8>,
) -> Result<Upload, String> {
    if paths.is_empty() {
        return Err("Select at least one file.".to_string());
    }

    let mut archive = None;
    let (path, file_name, mime_type) = if paths.len() == 1 {
        let path = paths.pop().unwrap();
        let file_name = file_name_of(&path)?;
        let mime_type = mime_guess::from_path(&path)
            .first_or_octet_stream()
            .to_string();
        (path, file_name, mime_type)
    } else {
        let file_name = format!("quickdrop-{}-files.zip", paths.len());
        let temporary = tokio::task::spawn_blocking(move || create_zip_archive(&paths))
            .await
            .map_err(|error| format!("Failed to create ZIP: {error}"))??;
        let path = temporary.path().to_path_buf();
        archive = Some(temporary);
        (path, file_name, "application/zip".to_string())
    };

    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("File not found: {}: {error}", path.display()))?;
    validate_file(&metadata, &path)?;
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
    validate_file(&metadata, &path)?;
    let total_bytes = metadata.len();
    let _ = progress.send(0);
    let stream_progress = progress.clone();
    let mut sent_bytes = 0_u64;
    let mut last_percent = 0;
    let stream = ReaderStream::new(file).map_ok(move |chunk| {
        sent_bytes = sent_bytes.saturating_add(chunk.len() as u64);
        let percent = (sent_bytes.saturating_mul(100) / total_bytes).min(99) as u8;
        if percent != last_percent {
            let _ = stream_progress.send(percent);
            last_percent = percent;
        }
        chunk
    });
    let part = Part::stream_with_length(reqwest::Body::wrap_stream(stream), total_bytes)
        .file_name(file_name)
        .mime_str(&mime_type)
        .map_err(|error| format!("Invalid MIME type: {error}"))?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| format!("Could not configure the upload client: {error}"))?;
    let response = client
        .post(format!("{}/api/upload", base_url.trim_end_matches('/')))
        .header("x-quickdrop-file-size", total_bytes.to_string())
        .multipart(Form::new().part("file", part))
        .send()
        .await
        .map_err(|error| format!("Failed to upload file: {error}"))?;

    if !response.status().is_success() {
        return Err(response
            .text()
            .await
            .unwrap_or_else(|_| "Upload failed.".to_string()));
    }
    let uploaded = response
        .json::<Upload>()
        .await
        .map_err(|error| format!("Invalid server response: {error}"))?;
    let _ = progress.send(100);
    drop(archive);
    Ok(uploaded)
}

fn validate_file(metadata: &std::fs::Metadata, path: &Path) -> Result<(), String> {
    if !metadata.is_file() {
        return Err(format!("Select regular files only: {}", path.display()));
    }
    if metadata.len() == 0 {
        return Err(format!("Empty file is not allowed: {}", path.display()));
    }
    Ok(())
}

fn file_name_of(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| "Invalid file name.".to_string())
}

fn create_zip_archive(paths: &[PathBuf]) -> Result<NamedTempFile, String> {
    let mut temporary = tempfile::Builder::new()
        .prefix("quickdrop-")
        .suffix(".zip")
        .tempfile()
        .map_err(|error| format!("Failed to create temporary ZIP: {error}"))?;
    let mut zip = zip::ZipWriter::new(temporary.as_file_mut());
    let mut archive_names = HashSet::new();
    for path in paths {
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("File not found: {}: {error}", path.display()))?;
        validate_file(&metadata, path)?;
        let source = File::open(path)
            .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
        let metadata = source
            .metadata()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        validate_file(&metadata, path)?;
        let entry_name = unique_archive_name(file_name_of(path)?, &mut archive_names);
        zip.start_file(&entry_name, zip_file_options(metadata.len()))
            .map_err(|error| format!("Failed to add {entry_name} to ZIP: {error}"))?;
        std::io::copy(&mut BufReader::new(source), &mut zip)
            .map_err(|error| format!("Failed to write {entry_name} to ZIP: {error}"))?;
    }
    zip.finish()
        .map_err(|error| format!("Failed to finish ZIP: {error}"))?;
    Ok(temporary)
}

fn zip_file_options(size: u64) -> SimpleFileOptions {
    SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(size >= u64::from(u32::MAX))
}

fn unique_archive_name(file_name: String, archive_names: &mut HashSet<String>) -> String {
    if archive_names.insert(file_name.clone()) {
        return file_name;
    }
    let path = Path::new(&file_name);
    let stem = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&file_name);
    let extension = path.extension().and_then(|extension| extension.to_str());
    for count in 2.. {
        let candidate = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem}-{count}.{extension}"),
            _ => format!("{stem}-{count}"),
        };
        if archive_names.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

/// Keep the returned file alive until its upload completes; dropping it removes the clipboard data.
#[cfg(target_os = "linux")]
pub fn clipboard_file() -> Result<NamedTempFile, String> {
    let types = list_clipboard_types()?;
    let (mime_type, extension) = select_clipboard_type(&types)
        .ok_or_else(|| "The clipboard has no supported image or text to send.".to_string())?;
    let mut temporary = tempfile::Builder::new()
        .prefix("quickdrop-clipboard-")
        .suffix(&format!(".{extension}"))
        .tempfile()
        .map_err(|error| format!("Failed to prepare clipboard file: {error}"))?;
    let output = temporary
        .as_file()
        .try_clone()
        .map_err(|error| format!("Failed to prepare clipboard file: {error}"))?;
    let mut command = Command::new("wl-paste");
    if extension == "txt" {
        command.arg("--no-newline");
    }
    let status = command
        .arg("--type")
        .arg(mime_type)
        .stdout(Stdio::from(output))
        .status()
        .map_err(|error| format!("wl-paste was not found or failed to start: {error}"))?;
    if !status.success() {
        return Err("Could not read clipboard content.".to_string());
    }
    let metadata = temporary
        .as_file()
        .metadata()
        .map_err(|error| format!("Could not inspect clipboard file: {error}"))?;
    validate_file(&metadata, temporary.path())?;
    temporary
        .as_file_mut()
        .rewind()
        .map_err(|error| format!("Could not rewind clipboard file: {error}"))?;
    Ok(temporary)
}

#[cfg(target_os = "linux")]
pub fn clipboard_text() -> Result<String, String> {
    let types = list_clipboard_types()?;
    let mime_type = types
        .iter()
        .find(|mime_type| is_plain_text_type(mime_type))
        .ok_or_else(|| "The clipboard has no text to send.".to_string())?;
    let output = Command::new("wl-paste")
        .args(["--no-newline", "--type", mime_type])
        .output()
        .map_err(|error| format!("wl-paste was not found or failed to start: {error}"))?;
    if !output.status.success() {
        return Err("Could not read clipboard text.".to_string());
    }
    let text = String::from_utf8(output.stdout)
        .map_err(|_| "Clipboard text is not valid UTF-8.".to_string())?;
    if text.trim().is_empty() {
        return Err("The clipboard has no text to send.".to_string());
    }
    Ok(text)
}

#[cfg(target_os = "linux")]
fn list_clipboard_types() -> Result<Vec<String>, String> {
    let output = Command::new("wl-paste")
        .arg("--list-types")
        .output()
        .map_err(|error| format!("wl-paste was not found or failed to start: {error}"))?;
    if !output.status.success() {
        return Err("The clipboard has no image or text to send.".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

#[cfg(any(target_os = "linux", test))]
fn select_clipboard_type(types: &[String]) -> Option<(&str, &'static str)> {
    types
        .iter()
        .find_map(|mime_type| {
            let base_type = base_mime_type(mime_type);
            let extension = [
                ("image/png", "png"),
                ("image/jpeg", "jpg"),
                ("image/jpg", "jpg"),
                ("image/webp", "webp"),
                ("image/gif", "gif"),
                ("image/bmp", "bmp"),
                ("image/tiff", "tiff"),
                ("image/svg+xml", "svg"),
            ]
            .into_iter()
            .find_map(|(supported, extension)| {
                base_type.eq_ignore_ascii_case(supported).then_some(extension)
            })?;
            Some((mime_type.as_str(), extension))
        })
        .or_else(|| {
            types
                .iter()
                .find(|mime_type| is_plain_text_type(mime_type))
                .map(|mime_type| (mime_type.as_str(), "txt"))
        })
}

#[cfg(any(target_os = "linux", test))]
fn base_mime_type(mime_type: &str) -> &str {
    mime_type.split(';').next().unwrap_or(mime_type).trim()
}

#[cfg(any(target_os = "linux", test))]
fn is_plain_text_type(mime_type: &str) -> bool {
    let base_type = base_mime_type(mime_type);
    ["text/plain", "utf8_string", "text", "string"]
        .into_iter()
        .any(|supported| base_type.eq_ignore_ascii_case(supported))
}

#[cfg(target_os = "linux")]
pub fn copy_text(text: &str) -> Result<(), String> {
    let mut child = Command::new("wl-copy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| format!("wl-copy was not found or failed to start: {error}"))?;
    let written = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open wl-copy stdin.".to_string())
        .and_then(|mut stdin| {
            stdin
                .write_all(text.as_bytes())
                .map_err(|error| format!("Failed to write to wl-copy: {error}"))
        });
    let status = child.wait();
    written?;
    let status = status.map_err(|error| format!("Failed while waiting for wl-copy: {error}"))?;
    if !status.success() {
        return Err("wl-copy returned an error.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn notify(summary: &str, body: &str) -> Result<(), String> {
    let status = Command::new("notify-send")
        .args(["--", summary, body])
        .status()
        .map_err(|error| format!("notify-send was not found or failed to start: {error}"))?;
    if !status.success() {
        return Err("notify-send returned an error.".to_string());
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn clipboard_file() -> Result<NamedTempFile, String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| format!("Could not open the clipboard: {error}"))?;
    match clipboard.get_image() {
        Ok(image) => clipboard_image_file(image.width, image.height, &image.bytes),
        Err(arboard::Error::ContentNotAvailable) => {
            let text = clipboard.get_text()
                .map_err(|error| format!("Could not read clipboard content: {error}"))?;
            if text.is_empty() {
                return Err("The clipboard has no image or text to send.".into());
            }
            let mut temporary = tempfile::Builder::new()
                .prefix("quickdrop-clipboard-")
                .suffix(".txt")
                .tempfile()
                .map_err(|error| format!("Failed to prepare clipboard file: {error}"))?;
            temporary.write_all(text.as_bytes())
                .and_then(|()| temporary.rewind())
                .map_err(|error| format!("Failed to write clipboard file: {error}"))?;
            Ok(temporary)
        }
        Err(error) => Err(format!("Could not read clipboard image: {error}")),
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn clipboard_image_file(width: usize, height: usize, rgba: &[u8]) -> Result<NamedTempFile, String> {
    let width = u32::try_from(width).map_err(|_| "Clipboard image is too wide.")?;
    let height = u32::try_from(height).map_err(|_| "Clipboard image is too tall.")?;
    if width == 0 || height == 0
        || (width as usize).checked_mul(height as usize).and_then(|size| size.checked_mul(4))
            != Some(rgba.len())
    {
        return Err("Clipboard image has invalid RGBA dimensions.".into());
    }
    let mut temporary = tempfile::Builder::new()
        .prefix("quickdrop-clipboard-")
        .suffix(".png")
        .tempfile()
        .map_err(|error| format!("Failed to prepare clipboard image: {error}"))?;
    {
        let mut encoder = png::Encoder::new(temporary.as_file_mut(), width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()
            .map_err(|error| format!("Failed to prepare clipboard image: {error}"))?;
        writer.write_image_data(rgba)
            .map_err(|error| format!("Failed to encode clipboard image: {error}"))?;
        writer.finish()
            .map_err(|error| format!("Failed to finish clipboard image: {error}"))?;
    }
    temporary.rewind()
        .map_err(|error| format!("Could not rewind clipboard image: {error}"))?;
    Ok(temporary)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn clipboard_text() -> Result<String, String> {
    let text = arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .map_err(|error| format!("Could not read clipboard text: {error}"))?;
    if text.trim().is_empty() {
        return Err("The clipboard has no text to send.".into());
    }
    Ok(text)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn copy_text(text: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| format!("Could not copy text: {error}"))
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn notify(summary: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        static APPLICATION: std::sync::LazyLock<Result<(), String>> = std::sync::LazyLock::new(||
            notify_rust::set_application("dev.quickdrop.quickdrop")
                .map_err(|error| format!("Could not initialize macOS notifications: {error}")));
        APPLICATION.clone()?;
    }
    let mut notification = notify_rust::Notification::new();
    notification.summary(summary).body(body);
    #[cfg(target_os = "windows")]
    notification.app_id("dev.quickdrop.quickdrop");
    notification.show()
        .map(|_| ())
        .map_err(|error| format!("Could not show notification: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[tokio::test]
    async fn stalled_upload_times_out_without_completing_progress() {
        use tokio::{io::AsyncReadExt, net::TcpListener, time};

        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"stalled upload").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (progress, updates) = std::sync::mpsc::channel();
        let request = tokio::spawn(upload(vec![file.path().to_path_buf()], base, progress));
        let (mut socket, _) = time::timeout(Duration::from_secs(5), listener.accept())
            .await.unwrap().unwrap();
        let mut byte = [0_u8; 1];
        assert_eq!(time::timeout(Duration::from_secs(5), socket.read(&mut byte))
            .await.unwrap().unwrap(), 1);
        // Pause only after real socket I/O, so connection setup cannot consume the deadline.
        time::pause();
        time::advance(Duration::from_secs(301)).await;
        let error = time::timeout(Duration::from_secs(1), request)
            .await.expect("Upload must stop at its deadline").unwrap().unwrap_err();
        assert!(error.contains("Failed to upload file"), "{error}");
        assert!(!updates.try_iter().any(|percent| percent == 100));
        drop(socket);
    }

    #[test]
    fn zip64_options_follow_input_size_without_large_fixtures() {
        for (size, large) in [
            (u64::from(u32::MAX) - 1, false),
            (u64::from(u32::MAX), true),
            (u64::from(u32::MAX) + 1, true),
        ] {
            let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            zip.start_file("tiny.txt", zip_file_options(size)).unwrap();
            zip.write_all(b"tiny fixture").unwrap();
            let bytes = zip.finish().unwrap().into_inner();
            let local_size = u32::from_le_bytes(bytes[22..26].try_into().unwrap());
            assert_eq!(local_size == u32::MAX, large, "Input size: {size}");
            let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
            let mut contents = String::new();
            archive.by_index(0).unwrap().read_to_string(&mut contents).unwrap();
            assert_eq!(contents, "tiny fixture");
        }
    }

    #[test]
    fn archive_names_avoid_existing_and_generated_suffixes() {
        for (names, expected) in [
            (
                ["foo.txt", "foo-2.txt", "foo.txt", "foo.txt"],
                ["foo.txt", "foo-2.txt", "foo-3.txt", "foo-4.txt"],
            ),
            (
                ["foo.txt", "foo.txt", "foo-2.txt", "foo-2.txt"],
                ["foo.txt", "foo-2.txt", "foo-2-2.txt", "foo-2-3.txt"],
            ),
            (
                ["README", "README", ".env", ".env"],
                ["README", "README-2", ".env", ".env-2"],
            ),
        ] {
            let mut used = HashSet::new();
            let actual: Vec<_> = names
                .into_iter()
                .map(|name| unique_archive_name(name.to_string(), &mut used))
                .collect();
            assert_eq!(actual, expected);
        }
    }

    #[test]
    fn zip_keeps_all_colliding_files_and_cleans_up() {
        let root = tempfile::tempdir().unwrap();
        let mut paths = Vec::new();
        for (index, name) in ["foo.txt", "foo-2.txt", "foo.txt"].into_iter().enumerate() {
            let directory = root.path().join(index.to_string());
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join(name);
            std::fs::write(&path, index.to_string()).unwrap();
            paths.push(path);
        }
        let temporary = create_zip_archive(&paths).unwrap();
        let temporary_path = temporary.path().to_path_buf();
        let mut archive = zip::ZipArchive::new(temporary.reopen().unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        for (index, name) in ["foo.txt", "foo-2.txt", "foo-3.txt"].into_iter().enumerate() {
            let mut contents = String::new();
            archive.by_name(name).unwrap().read_to_string(&mut contents).unwrap();
            assert_eq!(contents, index.to_string());
        }
        drop(archive);
        drop(temporary);
        assert!(!temporary_path.exists());
    }

    #[test]
    fn zip_rejects_empty_and_nonregular_inputs() {
        let directory = tempfile::tempdir().unwrap();
        let empty = directory.path().join("empty.txt");
        std::fs::write(&empty, []).unwrap();
        assert!(create_zip_archive(&[empty]).unwrap_err().contains("Empty file"));
        assert!(create_zip_archive(&[directory.path().to_path_buf()])
            .unwrap_err()
            .contains("regular files"));
    }

    #[test]
    fn clipboard_prefers_supported_images_and_keeps_correct_suffix() {
        for (mime_type, extension) in [
            ("image/png", "png"),
            ("IMAGE/JPEG;quality=90", "jpg"),
            ("image/jpg", "jpg"),
            ("image/webp", "webp"),
            ("image/gif", "gif"),
            ("image/bmp", "bmp"),
            ("image/tiff", "tiff"),
            ("image/svg+xml", "svg"),
        ] {
            let types = vec!["text/plain;charset=utf-8".to_string(), mime_type.to_string()];
            assert_eq!(select_clipboard_type(&types), Some((mime_type, extension)));
        }
    }

    #[test]
    fn clipboard_ignores_unsupported_images_and_file_uris() {
        let types = vec!["image/unknown".to_string(), "text/plain;charset=utf-8".to_string()];
        assert_eq!(select_clipboard_type(&types), Some(("text/plain;charset=utf-8", "txt")));
        for mime_type in ["text/uri-list", "image/unknown", "application/octet-stream"] {
            assert_eq!(select_clipboard_type(&[mime_type.to_string()]), None);
        }
        for mime_type in ["UTF8_STRING", "TEXT", "STRING"] {
            assert_eq!(select_clipboard_type(&[mime_type.to_string()]), Some((mime_type, "txt")));
        }
    }

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    #[test]
    fn native_clipboard_image_is_png_and_cleans_up() {
        let mut file = clipboard_image_file(1, 1, &[255, 0, 0, 255]).unwrap();
        let path = file.path().to_path_buf();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert_eq!(file.path().extension().unwrap(), "png");
        assert!(clipboard_image_file(0, 1, &[]).is_err());
        assert!(clipboard_image_file(1, 1, &[0, 0, 0]).is_err());
        drop(file);
        assert!(!path.exists());
    }
}
