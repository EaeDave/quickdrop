use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
};

use reqwest::{Client, Url};
use sha2::{Digest, Sha256};

use crate::{endpoint, http_client, parse_server_url, QdError};

const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(windows)]
const CHECKSUM_PATH: &str = "windows/qd/latest.sha256";
#[cfg(not(windows))]
const CHECKSUM_PATH: &str = "linux/qd/latest.sha256";

#[cfg(windows)]
const BINARY_PATH: &str = "windows/qd/latest.exe";
#[cfg(not(windows))]
const BINARY_PATH: &str = "linux/qd/latest";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AvailableUpdate {
    pub version: String,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChecksumAsset {
    pub checksum: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestartCommand {
    executable: PathBuf,
    args: Vec<OsString>,
}

impl RestartCommand {
    pub fn current() -> Result<Self, QdError> {
        let executable = env::current_exe().map_err(|error| {
            QdError::Runtime(format!("could not locate the current qd binary: {error}"))
        })?;
        Ok(Self {
            executable,
            args: env::args_os().skip(1).collect(),
        })
    }

    pub fn execute(self) -> Result<(), QdError> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let error = ProcessCommand::new(&self.executable)
                .args(&self.args)
                .exec();
            Err(QdError::Runtime(format!("could not restart qd: {error}")))
        }
        #[cfg(windows)]
        {
            ProcessCommand::new(&self.executable)
                .args(&self.args)
                .spawn()
                .map_err(|error| QdError::Runtime(format!("could not restart qd: {error}")))?;
            Ok(())
        }
    }
}

pub fn parse_version(value: &str) -> Result<(u64, u64, u64), QdError> {
    let value = value.strip_prefix('v').unwrap_or(value);
    let mut parts = value.split('.');
    let major = parse_version_part(parts.next(), value)?;
    let minor = parse_version_part(parts.next(), value)?;
    let patch = parse_version_part(parts.next(), value)?;
    if parts.next().is_some() {
        return Err(invalid_version(value));
    }
    Ok((major, minor, patch))
}

pub fn is_newer(remote: &str, current: &str) -> Result<bool, QdError> {
    Ok(parse_version(remote)? > parse_version(current)?)
}

pub fn assert_supported_update_platform() -> Result<(), QdError> {
    match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") | ("windows", "x86_64") => Ok(()),
        (os, arch) => Err(QdError::Runtime(format!(
            "qd update is only available on x86_64 Linux and Windows, not {os}/{arch}."
        ))),
    }
}

pub fn assert_update_origin(server: &Url) -> Result<(), QdError> {
    if server.scheme() == "https" {
        return Ok(());
    }
    if server.scheme() == "http" && matches!(server.host_str(), Some("127.0.0.1" | "localhost")) {
        return Ok(());
    }
    Err(QdError::Runtime(
        "qd update requires an https:// server, or http://127.0.0.1 for local development."
            .to_owned(),
    ))
}

pub fn parse_checksum_asset(body: &str) -> Result<ChecksumAsset, QdError> {
    let line = body
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| QdError::Runtime("the update checksum was empty.".to_owned()))?;
    let mut parts = line.split_whitespace();
    let checksum = parts
        .next()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| QdError::Runtime("the update checksum is invalid.".to_owned()))?
        .to_ascii_lowercase();
    let file_name = parts.next().ok_or_else(|| {
        QdError::Runtime("the update checksum is missing a file name.".to_owned())
    })?;
    let version = file_name
        .strip_prefix("qd_")
        .and_then(|value| value.split('_').next())
        .ok_or_else(|| QdError::Runtime("the update checksum is missing a version.".to_owned()))?;
    parse_version(version)?;
    Ok(ChecksumAsset {
        checksum,
        version: version.to_owned(),
    })
}

pub fn cleanup_previous_update() {
    if let Ok(current) = env::current_exe() {
        let _ = fs::remove_file(backup_path(&current));
    }
}

pub async fn check_for_update(server: &Url) -> Result<Option<AvailableUpdate>, QdError> {
    assert_supported_update_platform()?;
    assert_update_origin(server)?;
    let client = update_client()?;
    let asset = fetch_checksum_asset(&client, server).await?;
    if is_newer(&asset.version, CURRENT_VERSION)? {
        Ok(Some(AvailableUpdate {
            version: asset.version,
            checksum: asset.checksum,
        }))
    } else {
        Ok(None)
    }
}

pub async fn apply_update(
    server: &Url,
    expected: Option<&AvailableUpdate>,
) -> Result<String, QdError> {
    assert_supported_update_platform()?;
    assert_update_origin(server)?;
    let client = update_client()?;
    let asset = fetch_checksum_asset(&client, server).await?;
    if !is_newer(&asset.version, CURRENT_VERSION)? {
        return Err(QdError::Runtime(format!(
            "qd is already up to date ({CURRENT_VERSION})."
        )));
    }
    if let Some(expected) = expected {
        if expected.version != asset.version || expected.checksum != asset.checksum {
            return Err(QdError::Runtime(
                "the available update changed before it could be installed.".to_owned(),
            ));
        }
    }

    let bytes = client
        .get(endpoint(server, BINARY_PATH)?)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| QdError::Runtime(format!("could not download the qd update: {error}")))?
        .bytes()
        .await
        .map_err(|error| QdError::Runtime(format!("could not read the qd update: {error}")))?;
    if bytes.len() < 1_048_576 {
        return Err(QdError::Runtime(
            "the downloaded qd update is unexpectedly small.".to_owned(),
        ));
    }

    let current = env::current_exe().map_err(|error| {
        QdError::Runtime(format!("could not locate the current qd binary: {error}"))
    })?;
    install_verified_binary(&bytes, &asset.checksum, &current)?;
    Ok(asset.version)
}

pub fn install_verified_binary(
    bytes: &[u8],
    expected_hex: &str,
    current_exe: &Path,
) -> Result<(), QdError> {
    let expected = decode_sha256(expected_hex)?;
    let actual = Sha256::digest(bytes);
    if actual.as_slice() != expected {
        return Err(QdError::Runtime(
            "the downloaded qd update failed checksum verification.".to_owned(),
        ));
    }
    replace_executable(current_exe, bytes)
}

pub fn capture_restart_command() -> Result<RestartCommand, QdError> {
    RestartCommand::current()
}

pub async fn run_update(args: Vec<String>) -> Result<(), QdError> {
    let mut check_only = false;
    let mut server = env::var("QUICKDROP_API_BASE_URL")
        .unwrap_or_else(|_| crate::DEFAULT_API_BASE_URL.to_owned());
    let mut arguments = args.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--check" => check_only = true,
            "--server" => {
                server = arguments
                    .next()
                    .filter(|value| !value.starts_with('-'))
                    .ok_or_else(|| QdError::Usage("--server requires a URL.".to_owned()))?;
            }
            _ if argument.starts_with('-') => {
                return Err(QdError::Usage(format!("unknown option: {argument}")));
            }
            _ => {
                return Err(QdError::Usage(format!(
                    "unknown update argument: {argument}"
                )));
            }
        }
    }

    let server = parse_server_url(&server)?;
    if check_only {
        match check_for_update(&server).await? {
            Some(update) => println!("qd {CURRENT_VERSION} → {} is available.", update.version),
            None => println!("qd is already up to date ({CURRENT_VERSION})."),
        }
        return Ok(());
    }

    let version = apply_update(&server, None).await?;
    println!("Updated qd to {version}.");
    Ok(())
}

async fn fetch_checksum_asset(client: &Client, server: &Url) -> Result<ChecksumAsset, QdError> {
    let body = client
        .get(endpoint(server, CHECKSUM_PATH)?)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| QdError::Runtime(format!("could not check for qd updates: {error}")))?
        .text()
        .await
        .map_err(|error| {
            QdError::Runtime(format!("could not read the update checksum: {error}"))
        })?;
    parse_checksum_asset(&body)
}

fn update_client() -> Result<Client, QdError> {
    Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .or_else(|_| http_client())
}

fn replace_executable(current: &Path, bytes: &[u8]) -> Result<(), QdError> {
    let tmp = temp_path(current);
    let result = install_temporary_binary(current, &tmp, bytes);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn install_temporary_binary(current: &Path, tmp: &Path, bytes: &[u8]) -> Result<(), QdError> {
    fs::write(tmp, bytes)
        .map_err(|error| QdError::Runtime(format!("could not write the qd update: {error}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(tmp, fs::Permissions::from_mode(0o755)).map_err(|error| {
            QdError::Runtime(format!("could not make the qd update executable: {error}"))
        })?;
        fs::rename(tmp, current).map_err(|error| {
            QdError::Runtime(format!("could not install the qd update: {error}"))
        })?;
    }
    #[cfg(windows)]
    {
        let backup = backup_path(current);
        let _ = fs::remove_file(&backup);
        fs::rename(current, &backup).map_err(|error| {
            QdError::Runtime(format!("could not replace the running qd binary: {error}"))
        })?;
        if let Err(error) = fs::rename(tmp, current) {
            let _ = fs::rename(&backup, current);
            return Err(QdError::Runtime(format!(
                "could not install the qd update: {error}"
            )));
        }
    }
    Ok(())
}

fn temp_path(current: &Path) -> PathBuf {
    current.with_file_name(format!(
        ".{}.new",
        current.file_name().unwrap_or_default().to_string_lossy()
    ))
}

fn backup_path(current: &Path) -> PathBuf {
    current.with_file_name(format!(
        ".{}.old",
        current.file_name().unwrap_or_default().to_string_lossy()
    ))
}

fn decode_sha256(value: &str) -> Result<[u8; 32], QdError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(QdError::Runtime(
            "the update checksum is invalid.".to_owned(),
        ));
    }
    let mut decoded = [0_u8; 32];
    for (index, chunk) in decoded.iter_mut().enumerate() {
        *chunk = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| QdError::Runtime("the update checksum is invalid.".to_owned()))?;
    }
    Ok(decoded)
}

fn parse_version_part(part: Option<&str>, value: &str) -> Result<u64, QdError> {
    let part = part.ok_or_else(|| invalid_version(value))?;
    if part.is_empty()
        || !part.bytes().all(|byte| byte.is_ascii_digit())
        || (part.len() > 1 && part.starts_with('0'))
    {
        return Err(invalid_version(value));
    }
    part.parse().map_err(|_| invalid_version(value))
}

fn invalid_version(value: &str) -> QdError {
    QdError::Runtime(format!("invalid qd version: {value}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_checksum_assets() {
        let asset = parse_checksum_asset(
            "53e33adf9eefe30c8196e34fa4f9f20c562ae9d0b14af7fc8b5ce0e985c12fad  qd_0.1.4_x86_64-linux\n",
        )
        .unwrap();
        assert_eq!(asset.version, "0.1.4");
        assert_eq!(
            asset.checksum,
            "53e33adf9eefe30c8196e34fa4f9f20c562ae9d0b14af7fc8b5ce0e985c12fad"
        );
    }

    #[test]
    fn compares_semantic_versions() {
        assert!(is_newer("0.1.4", "0.1.3").unwrap());
        assert!(!is_newer("0.1.3", "0.1.3").unwrap());
        assert!(!is_newer("0.1.2", "0.1.3").unwrap());
        assert!(is_newer("v1.0.0", "0.9.9").unwrap());
    }

    #[test]
    fn rejects_insecure_remote_update_origins() {
        assert_update_origin(&Url::parse("https://quickdrop.example").unwrap()).unwrap();
        assert_update_origin(&Url::parse("http://127.0.0.1:3000").unwrap()).unwrap();
        assert!(assert_update_origin(&Url::parse("http://quickdrop.example").unwrap()).is_err());
    }

    #[test]
    fn rejects_a_binary_with_the_wrong_checksum() {
        let directory = env::temp_dir().join(format!("qd-update-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let current = directory.join("qd");
        fs::write(&current, b"old-binary").unwrap();
        let error = install_verified_binary(
            b"new-binary",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &current,
        )
        .unwrap_err();
        assert!(matches!(error, QdError::Runtime(message) if message.contains("checksum")));
        assert_eq!(fs::read(&current).unwrap(), b"old-binary");
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn replaces_the_current_binary_after_checksum_verification() {
        let directory = env::temp_dir().join(format!("qd-update-ok-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let current = directory.join("qd");
        fs::write(&current, b"old-binary").unwrap();
        let bytes = b"replacement-binary";
        let checksum = format!("{:x}", Sha256::digest(bytes));
        install_verified_binary(bytes, &checksum, &current).unwrap();
        assert_eq!(fs::read(&current).unwrap(), bytes);
        let _ = fs::remove_dir_all(directory);
    }
}
