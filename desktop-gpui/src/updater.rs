use std::{collections::HashMap, io::Read, path::Path, time::Duration};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;

const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Deserialize)]
pub struct Update {
    pub version: String,
    pub url: String,
    pub signature: String,
}

#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: HashMap<String, Artifact>,
}

#[derive(Deserialize)]
struct Artifact {
    url: String,
    signature: String,
}

pub fn configured() -> bool {
    option_env!("QUICKDROP_UPDATER_PUBLIC_KEY").is_some_and(|key| !key.is_empty())
}

fn platform() -> Result<String, String> {
    let os = match std::env::consts::OS {
        "linux" => "linux", "windows" => "windows", "macos" => "darwin",
        other => return Err(format!("Unsupported update platform: {other}")),
    };
    Ok(format!("{os}-{}", std::env::consts::ARCH))
}

fn client(base: &str) -> Result<reqwest::Client, String> {
    let url = url::Url::parse(base).map_err(|error| error.to_string())?;
    if url.scheme() != "https" && !(url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))) {
        return Err("Updates require HTTPS, or localhost for development.".into());
    }
    reqwest::Client::builder().connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300)).redirect(reqwest::redirect::Policy::none())
        .build().map_err(|error| error.to_string())
}

fn select_update(manifest: Manifest, base: &str, current: &str, target: &str) -> Result<Option<Update>, String> {
    let remote = semver::Version::parse(&manifest.version).map_err(|error| format!("Invalid update version: {error}"))?;
    let current = semver::Version::parse(current).map_err(|error| error.to_string())?;
    if remote <= current { return Ok(None); }
    let artifact = manifest.platforms.get(target).ok_or("No signed update is available for this platform.")?;
    let expected = format!("{}/desktop/update/{}/{target}", base.trim_end_matches('/'), manifest.version);
    if artifact.url != expected || artifact.signature.is_empty() {
        return Err("The update manifest contains an invalid signed artifact.".into());
    }
    Ok(Some(Update {version: manifest.version, url: artifact.url.clone(), signature: artifact.signature.clone()}))
}

pub async fn check(base: &str) -> Result<Option<Update>, String> {
    if !configured() { return Err("This development build has no updater public key.".into()); }
    let response = client(base)?.get(format!("{}/desktop/update/latest.json", base.trim_end_matches('/')))
        .timeout(Duration::from_secs(15)).send().await.map_err(|error| error.to_string())?;
    if response.status() == reqwest::StatusCode::NO_CONTENT { return Ok(None); }
    let mut response = response.error_for_status().map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > 64 * 1024 { return Err("The update manifest is too large.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let manifest = serde_json::from_slice(&bytes).map_err(|error| format!("Invalid update manifest: {error}"))?;
    select_update(manifest, base, env!("CARGO_PKG_VERSION"), &platform()?)
}

fn decode(value: &str) -> Result<String, String> {
    String::from_utf8(STANDARD.decode(value.trim()).map_err(|error| format!("Invalid signing data: {error}"))?)
        .map_err(|error| format!("Invalid signing data: {error}"))
}

fn verify(file: &mut std::fs::File, public_key: &str, signature: &str) -> Result<(), String> {
    let key = PublicKey::decode(&decode(public_key)?).map_err(|error| error.to_string())?;
    let signature = Signature::decode(&decode(signature)?).map_err(|error| error.to_string())?;
    let mut verifier = key.verify_stream(&signature).map_err(|error| format!("Update signature rejected: {error}"))?;
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 { break; }
        verifier.update(&buffer[..count]);
    }
    verifier.finalize().map_err(|error| format!("Update signature rejected: {error}"))
}

pub async fn install(base: String, update: Update) -> Result<(), String> {
    let key = option_env!("QUICKDROP_UPDATER_PUBLIC_KEY").filter(|key| !key.is_empty()).ok_or("No updater public key configured.")?;
    let expected = format!("{}/desktop/update/{}/{}", base.trim_end_matches('/'), update.version, platform()?);
    if update.url != expected { return Err("Invalid update URL.".into()); }
    let response = client(&base)?.get(&update.url).send().await.map_err(|error| error.to_string())?
        .error_for_status().map_err(|error| error.to_string())?;
    if response.content_length().is_some_and(|length| length > MAX_DOWNLOAD_BYTES) {
        return Err("The update exceeds the download size limit.".into());
    }
    let temporary = tempfile::Builder::new().prefix("quickdrop-update-").suffix(if cfg!(windows) { ".exe" } else { ".download" })
        .tempfile().map_err(|error| error.to_string())?;
    let mut writer = tokio::fs::File::from_std(temporary.reopen().map_err(|error| error.to_string())?);
    let mut stream = response.bytes_stream();
    let mut length = 0_u64;
    use tokio::io::AsyncWriteExt;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        length += chunk.len() as u64;
        if length > MAX_DOWNLOAD_BYTES { return Err("The update exceeds the download size limit.".into()); }
        writer.write_all(&chunk).await.map_err(|error| error.to_string())?;
    }
    writer.sync_all().await.map_err(|error| error.to_string())?;
    drop(writer);
    if length == 0 { return Err("The update download is empty.".into()); }
    tokio::task::spawn_blocking(move || {
        verify(&mut temporary.reopen().map_err(|error| error.to_string())?, key, &update.signature)?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        install_verified(temporary, &executable)
    }).await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "linux")]
fn install_verified(mut downloaded: tempfile::NamedTempFile, executable: &Path) -> Result<(), String> {
    use std::{io::Seek, os::unix::fs::PermissionsExt};
    let parent = executable.parent().ok_or("Executable has no parent directory.")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    downloaded.rewind().map_err(|error| error.to_string())?;
    std::io::copy(&mut downloaded, &mut staged).map_err(|error| error.to_string())?;
    staged.as_file().set_permissions(std::fs::Permissions::from_mode(0o755)).map_err(|error| error.to_string())?;
    staged.as_file().sync_all().map_err(|error| error.to_string())?;
    staged.persist(executable).map_err(|error| error.to_string())?;
    restart_after_exit(executable, false)
}

#[cfg(target_os = "windows")]
fn install_verified(downloaded: tempfile::NamedTempFile, executable: &Path) -> Result<(), String> {
    let parent = executable.parent().ok_or("Executable has no parent directory.")?;
    let path = downloaded.into_temp_path().keep().map_err(|error| error.to_string())?;
    let spawn = std::process::Command::new(&path).args(["/S", "/UPDATE", "/R"])
        .arg(format!("/D={}", parent.display())).spawn();
    if let Err(error) = spawn { let _ = std::fs::remove_file(path); return Err(format!("Could not start the verified installer: {error}")); }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_verified(downloaded: tempfile::NamedTempFile, executable: &Path) -> Result<(), String> {
    let current = executable.ancestors().find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .ok_or("Run QuickDrop from its installed application bundle to update.")?;
    let parent = current.parent().ok_or("Application has no parent directory.")?;
    let staging = tempfile::tempdir_in(parent).map_err(|error| error.to_string())?;
    let file = downloaded.reopen().map_err(|error| error.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path().map_err(|error| error.to_string())?;
        if !path.starts_with("QuickDrop.app") || path.components().any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
            return Err("Invalid application update archive path.".into());
        }
        if !entry.unpack_in(staging.path()).map_err(|error| error.to_string())? { return Err("Unsafe update archive entry.".into()); }
    }
    let staged = staging.path().join("QuickDrop.app");
    if !std::fs::symlink_metadata(staged.join("Contents/MacOS/quickdrop")).map_err(|error| error.to_string())?.file_type().is_file() {
        return Err("Update bundle is missing its application binary.".into());
    }
    let backup = tempfile::Builder::new().prefix(".quickdrop-backup-").tempdir_in(parent).map_err(|error| error.to_string())?.keep();
    let backup_app = backup.join("QuickDrop.app");
    std::fs::rename(current, &backup_app).map_err(|error| error.to_string())?;
    if let Err(error) = std::fs::rename(&staged, current) {
        if let Err(rollback) = std::fs::rename(&backup_app, current) {
            return Err(format!("Update failed: {error}. Restore your app from {}: {rollback}", backup_app.display()));
        }
        let _ = std::fs::remove_dir(backup);
        return Err(format!("Update failed; previous app restored: {error}"));
    }
    std::fs::remove_dir_all(&backup).map_err(|error| format!("Updated, but could not remove backup at {}: {error}", backup.display()))?;
    restart_after_exit(current, true)
}

#[cfg(unix)]
fn restart_after_exit(path: &Path, bundle: bool) -> Result<(), String> {
    let script = if bundle {
        "while kill -0 \"$1\" 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open -n \"$2\""
    } else {
        "while kill -0 \"$1\" 2>/dev/null; do sleep 0.1; done; exec \"$2\""
    };
    std::process::Command::new("sh").args(["-c", script, "quickdrop-restart", &std::process::id().to_string()]).arg(path)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|error| format!("Updated, but could not schedule restart: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_foreign_update_origins_and_old_versions() {
        let make = |version: &str, url: &str| Manifest { version: version.into(), platforms: HashMap::from([("linux-x86_64".into(), Artifact {url:url.into(),signature:"sig".into()})]) };
        assert!(select_update(make("1.2.3", "https://evil.test/app"), "https://drop.test", "1.2.2", "linux-x86_64").is_err());
        assert!(select_update(make("1.2.3", "https://drop.test/desktop/update/1.2.3/linux-x86_64"), "https://drop.test", "1.2.3", "linux-x86_64").unwrap().is_none());
        let update = select_update(make("1.2.3", "https://drop.test/desktop/update/1.2.3/linux-x86_64"), "https://drop.test", "1.2.2", "linux-x86_64").unwrap().unwrap();
        assert_eq!(update.version,"1.2.3");
    }
    #[test]
    fn rejects_insecure_update_transport() {
        assert!(client("http://example.com").is_err());
        assert!(client("http://127.0.0.1:3000").is_ok());
    }
    #[test]
    fn verifies_prehashed_signatures_and_rejects_modified_bytes() {
        let public = STANDARD.encode("untrusted comment: test\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3");
        let signature = STANDARD.encode("untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==");
        let mut file = tempfile::tempfile().unwrap(); file.write_all(b"test").unwrap();
        use std::io::{Seek, Write};
        file.rewind().unwrap(); assert!(verify(&mut file, &public, &signature).is_ok());
        file.rewind().unwrap(); file.write_all(b"Test").unwrap(); file.rewind().unwrap();
        assert!(verify(&mut file, &public, &signature).is_err());
    }
}
