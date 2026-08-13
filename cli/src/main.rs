use std::{
    env,
    io::{self, IsTerminal, Read, Write},
    process::{Command as ProcessCommand, Stdio},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use reqwest::{
    header::{COOKIE, SET_COOKIE},
    Client, Url,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::HeaderValue, Message},
};
mod tui;
mod update;

pub(crate) const DEFAULT_API_BASE_URL: &str = "https://quickdrop.eaedave.xyz";
const USAGE: &str = "Usage:
  qd
  qd --tui [room] [--server <url>]
  qd update [--check] [--server <url>]
  qd <room> [--server <url>]
  qd <message> <room> [pin] [--server <url>]
  echo \"message\" | qd <room> [pin] [--server <url>]

Options:
  --tui                  Open the interactive terminal interface.
  update                 Download and install the latest qd binary.
  --check                Report whether a qd update is available.
  --server <url>         QuickDrop URL (default: QUICKDROP_API_BASE_URL or https://quickdrop.eaedave.xyz).
  -V, --version          Show the installed qd version.
  -h, --help             Show this help.";

#[derive(Debug, PartialEq, Eq)]
struct QdCommand {
    code: String,
    content: Option<String>,
    pin: Option<String>,
    server: Url,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenPayload {
    code: String,
    protected: bool,
}

struct OpenResponse {
    code: String,
    protected: bool,
    access_cookie: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotResponse {
    text: String,
    #[serde(default)]
    drops: Vec<TextDrop>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextDrop {
    content: String,
    created_at: String,
    id: String,
}

#[tokio::main]
async fn main() {
    match run(env::args().skip(1).collect()).await {
        Ok(()) => {}
        Err(QdError::Usage(message)) => {
            eprintln!("{message}\n\n{USAGE}");
            std::process::exit(2);
        }
        Err(QdError::Runtime(message) | QdError::Remote { message, .. }) => {
            eprintln!("qd: {message}");
            std::process::exit(1);
        }
    }
}

async fn run(args: Vec<String>) -> Result<(), QdError> {
    update::cleanup_previous_update();
    if args
        .iter()
        .any(|argument| argument == "--help" || argument == "-h")
    {
        if args.len() == 1 {
            println!("{USAGE}");
            return Ok(());
        }
        return Err(QdError::Usage(
            "--help cannot be combined with other options.".to_owned(),
        ));
    }
    if args
        .iter()
        .any(|argument| argument == "--version" || argument == "-V")
    {
        if args.len() == 1 {
            println!("qd {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        return Err(QdError::Usage(
            "--version cannot be combined with other options.".to_owned(),
        ));
    }

    if args.first().is_some_and(|argument| argument == "update") {
        return update::run_update(args.into_iter().skip(1).collect()).await;
    }

    if should_launch_tui(&args, io::stdin().is_terminal()) {
        let restart = update::capture_restart_command()?;
        let tui_args = if args.first().is_some_and(|arg| arg == "--tui") {
            args.into_iter().skip(1).collect()
        } else {
            args
        };
        let (server, code) = parse_tui_command(tui_args)?;
        if tui::run_tui(server, code).await? {
            restart.execute()?;
        }
        return Ok(());
    }
    if args.first().is_some_and(|argument| argument == "--tui") {
        return Err(QdError::Usage(
            "--tui requires an interactive terminal.".to_owned(),
        ));
    }

    let piped_content = if io::stdin().is_terminal() {
        None
    } else {
        Some(read_piped_stdin()?).filter(|content| !content.is_empty())
    };
    let command = parse_command(args, piped_content.is_some())?;
    let content = piped_content.or_else(|| command.content.clone());
    let client = http_client()?;
    let room = match open_room(&client, &command, command.pin.as_deref()).await {
        Err(QdError::Remote {
            code: Some(code), ..
        }) if code == "pin_required" && command.pin.is_none() => {
            return Err(QdError::Runtime(
                "Clipboard is protected by a PIN.\nuse: qd <message> <room> <pin>".to_owned(),
            ));
        }
        result => result?,
    };

    if let Some(content) = content {
        publish_drop(
            &command.server,
            &room.code,
            &content,
            room.access_cookie.as_deref(),
        )
        .await?;
        return Ok(());
    }

    let content = latest_drop(
        &client,
        &command.server,
        &room.code,
        room.access_cookie.as_deref(),
    )
    .await?;
    if let Some(content) = prepare_received_content(content, copy_to_system_clipboard)? {
        print!("{content}");
    } else {
        eprintln!("qd: No messages found.");
    }
    Ok(())
}

fn should_launch_tui(args: &[String], stdin_is_terminal: bool) -> bool {
    stdin_is_terminal && (args.is_empty() || args.first().is_some_and(|arg| arg == "--tui"))
}

fn parse_tui_command(args: Vec<String>) -> Result<(Url, Option<String>), QdError> {
    let mut code = None;
    let mut server =
        env::var("QUICKDROP_API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_owned());
    let mut arguments = args.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--server" => {
                server = arguments
                    .next()
                    .filter(|value| !value.starts_with('-'))
                    .ok_or_else(|| QdError::Usage("--server requires a URL.".to_owned()))?;
            }
            _ if argument.starts_with('-') => {
                return Err(QdError::Usage(format!("unknown option: {argument}")));
            }
            _ if code.is_some() => {
                return Err(QdError::Usage(
                    "provide only one clipboard code.".to_owned(),
                ));
            }
            _ => code = Some(validate_code(&argument)?),
        }
    }
    Ok((parse_server_url(&server)?, code))
}

fn validate_code(code: &str) -> Result<String, QdError> {
    if code.len() > 16
        || code.is_empty()
        || !code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(QdError::Usage(
            "use 1–16 letters, numbers, hyphens, or underscores in the code.".to_owned(),
        ));
    }
    Ok(code.to_ascii_uppercase())
}

pub(crate) fn parse_server_url(server: &str) -> Result<Url, QdError> {
    let mut server = Url::parse(server).map_err(|_| {
        QdError::Usage("the server URL must start with http:// or https://.".to_owned())
    })?;
    if !matches!(server.scheme(), "http" | "https") {
        return Err(QdError::Usage(
            "the server URL must start with http:// or https://.".to_owned(),
        ));
    }
    if !server.username().is_empty() || server.password().is_some() {
        return Err(QdError::Usage(
            "the server URL must not contain credentials.".to_owned(),
        ));
    }
    server.set_query(None);
    server.set_fragment(None);
    if server.path().ends_with('/') && server.path() != "/" {
        let trimmed_path = server.path().trim_end_matches('/').to_owned();
        server.set_path(&trimmed_path);
    }
    Ok(server)
}

fn parse_command(args: Vec<String>, has_piped_content: bool) -> Result<QdCommand, QdError> {
    let mut positional = Vec::new();
    let mut server =
        env::var("QUICKDROP_API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_owned());
    let mut arguments = args.into_iter();

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--server" => {
                server = arguments
                    .next()
                    .filter(|value| !value.starts_with('-'))
                    .ok_or_else(|| QdError::Usage("--server requires a URL.".to_owned()))?;
            }
            _ if argument.starts_with('-') => {
                return Err(QdError::Usage(format!("unknown option: {argument}")));
            }
            _ => positional.push(argument),
        }
    }
    let (content, code, pin) = if has_piped_content {
        match positional.as_slice() {
            [code] => (None, code, None),
            [code, pin] => (None, code, Some(pin.clone())),
            [] => return Err(QdError::Usage("provide a clipboard room.".to_owned())),
            _ => {
                return Err(QdError::Usage(
                    "use: echo \"message\" | qd <room> [pin]".to_owned(),
                ))
            }
        }
    } else {
        match positional.as_slice() {
            [code] => (None, code, None),
            [content, code] => (Some(content.clone()), code, None),
            [content, code, pin] => (Some(content.clone()), code, Some(pin.clone())),
            [] => return Err(QdError::Usage("provide a clipboard room.".to_owned())),
            _ => return Err(QdError::Usage("use: qd <message> <room> [pin]".to_owned())),
        }
    };
    let code = validate_code(code)?;
    let pin = pin
        .filter(|pin| !pin.trim().is_empty())
        .map(|pin| pin.trim().to_owned());
    Ok(QdCommand {
        code,
        content,
        pin,
        server: parse_server_url(&server)?,
    })
}

async fn open_room(
    client: &Client,
    command: &QdCommand,
    pin: Option<&str>,
) -> Result<OpenResponse, QdError> {
    let url = endpoint(&command.server, &format!("api/text/{}/open", command.code))?;
    let payload = pin
        .filter(|pin| !pin.trim().is_empty())
        .map_or_else(|| json!({}), |pin| json!({ "pin": pin.trim() }));
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|error| QdError::Runtime(format!("could not open the clipboard: {error}")))?;
    let access_cookie = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| value.split(';').next().map(str::to_owned));
    let opened: OpenPayload = parse_response(response, "could not open the clipboard.").await?;
    Ok(OpenResponse {
        code: opened.code,
        protected: opened.protected,
        access_cookie,
    })
}

async fn latest_drop(
    client: &Client,
    server: &Url,
    code: &str,
    access_cookie: Option<&str>,
) -> Result<String, QdError> {
    let url = endpoint(server, &format!("api/text/{code}"))?;
    let mut request = client.get(url);
    if let Some(cookie) = access_cookie {
        request = request.header(COOKIE, cookie);
    }
    let response = request
        .send()
        .await
        .map_err(|error| QdError::Runtime(format!("could not read the clipboard: {error}")))?;
    let snapshot: SnapshotResponse =
        parse_response(response, "could not read the clipboard.").await?;
    Ok(latest_content(snapshot))
}

fn latest_content(snapshot: SnapshotResponse) -> String {
    snapshot
        .drops
        .into_iter()
        .max_by(|left, right| {
            left.created_at
                .cmp(&right.created_at)
                .then_with(|| left.id.cmp(&right.id))
        })
        .map(|drop| drop.content)
        .unwrap_or(snapshot.text)
}

pub(crate) fn http_client() -> Result<Client, QdError> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| QdError::Runtime(format!("could not configure the HTTP client: {error}")))
}

async fn publish_drop(
    server: &Url,
    code: &str,
    content: &str,
    access_cookie: Option<&str>,
) -> Result<(), QdError> {
    let mut websocket_url = endpoint(server, &format!("api/text/{code}/ws"))?;
    websocket_url
        .set_scheme(if server.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| QdError::Runtime("could not prepare the WebSocket URL.".to_owned()))?;
    let mut request = websocket_url
        .as_str()
        .into_client_request()
        .map_err(|error| QdError::Runtime(format!("could not prepare the connection: {error}")))?;
    if let Some(cookie) = access_cookie {
        request.headers_mut().insert(
            COOKIE,
            HeaderValue::from_str(cookie)
                .map_err(|_| QdError::Runtime("the room access cookie is invalid.".to_owned()))?,
        );
    }
    let (mut socket, _) = connect_async(request).await.map_err(|error| {
        QdError::Runtime(format!("could not connect to the clipboard: {error}"))
    })?;
    let mut client_id = None;

    let confirmation = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(message) = socket.next().await {
            let message = message.map_err(|error| {
                QdError::Runtime(format!("the clipboard connection failed: {error}"))
            })?;
            let Message::Text(text) = message else {
                continue;
            };
            let payload: Value = serde_json::from_str(&text).map_err(|error| {
                QdError::Runtime(format!("the server sent an invalid message: {error}"))
            })?;
            match payload.get("type").and_then(Value::as_str) {
                Some("snapshot") => {
                    let id = payload
                        .get("clientId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            QdError::Runtime(
                                "the server did not identify this connection.".to_owned(),
                            )
                        })?;
                    client_id = Some(id.to_owned());
                    socket
                        .send(Message::Text(
                            json!({ "type": "drop_add", "content": content })
                                .to_string()
                                .into(),
                        ))
                        .await
                        .map_err(|error| {
                            QdError::Runtime(format!("could not publish the text: {error}"))
                        })?;
                }
                Some("drop_added")
                    if client_id.as_deref() == payload.get("by").and_then(Value::as_str) =>
                {
                    return Ok(());
                }
                Some("error") => {
                    let code = payload.get("error").and_then(Value::as_str);
                    let fallback = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("the server rejected the text.");
                    return Err(QdError::Runtime(remote_error_message(code, fallback)));
                }
                _ => {}
            }
        }

        Err(QdError::Runtime(
            "the clipboard connection closed before confirmation.".to_owned(),
        ))
    })
    .await
    .map_err(|_| QdError::Runtime("timed out waiting for publish confirmation.".to_owned()))?;

    confirmation
}

async fn parse_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
    fallback: &str,
) -> Result<T, QdError> {
    let status = response.status();
    let payload: Value = response.json().await.map_err(|error| {
        QdError::Runtime(format!("the server returned an invalid response: {error}"))
    })?;
    if !status.is_success() {
        let code = payload
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let fallback = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(fallback);
        let message = remote_error_message(code.as_deref(), fallback);
        return Err(QdError::Remote { code, message });
    }
    serde_json::from_value(payload).map_err(|error| {
        QdError::Runtime(format!("the server returned an invalid response: {error}"))
    })
}

fn remote_error_message(code: Option<&str>, fallback: &str) -> String {
    match code {
        Some("pin_required") => "Clipboard is protected by a PIN.".to_owned(),
        Some("pin_invalid") => "Invalid PIN.".to_owned(),
        Some("invalid_code") => {
            "Use 1–16 letters, numbers, hyphens, or underscores in the room name.".to_owned()
        }
        Some("invalid_token") => "Room access expired. Enter the PIN again.".to_owned(),
        Some("not_found") => "Clipboard not found.".to_owned(),
        Some("room_full") => "Clipboard is full.".to_owned(),
        Some("session_limit") => "Clipboard limit reached. Try again later.".to_owned(),
        Some("code_exhausted") => "Could not reserve a clipboard name.".to_owned(),
        Some("create_failed") => "Could not open the clipboard.".to_owned(),
        Some("too_large") => "The message is too large.".to_owned(),
        Some("empty_drop") => "Enter a message before sending.".to_owned(),
        Some("drop_not_found") => "Message not found.".to_owned(),
        Some("operation_failed") => "Could not complete the operation.".to_owned(),
        _ => fallback.to_owned(),
    }
}

pub(crate) fn endpoint(server: &Url, path: &str) -> Result<Url, QdError> {
    let mut url = server.clone();
    let prefix = server.path().trim_end_matches('/');
    url.set_path(&format!("{prefix}/{path}"));
    Ok(url)
}

fn read_piped_stdin() -> Result<String, QdError> {
    let mut content = String::new();
    io::stdin()
        .read_to_string(&mut content)
        .map_err(|error| QdError::Runtime(format!("could not read standard input: {error}")))?;
    Ok(content)
}

fn prepare_received_content<C>(content: String, copy: C) -> Result<Option<String>, QdError>
where
    C: FnOnce(&str) -> Result<(), QdError>,
{
    if content.is_empty() {
        return Ok(None);
    }
    copy(&content)?;
    Ok(Some(content))
}

fn copy_to_system_clipboard(content: &str) -> Result<(), QdError> {
    #[cfg(target_os = "windows")]
    let commands: &[(&str, &[&str])] = &[(
        "powershell.exe",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
        ],
    )];
    #[cfg(not(target_os = "windows"))]
    let commands: &[(&str, &[&str])] = &[
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
        ("xsel", &["--clipboard", "--input"]),
    ];

    for (program, arguments) in commands {
        let mut child = match ProcessCommand::new(program)
            .args(*arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(_) => continue,
        };
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(content.as_bytes()).map_err(|error| {
                QdError::Runtime(format!("could not write to the clipboard command: {error}"))
            })?;
        }
        if child
            .wait()
            .map_err(|error| QdError::Runtime(format!("could not copy the text: {error}")))?
            .success()
        {
            return Ok(());
        }
    }

    #[cfg(target_os = "windows")]
    let message = "could not copy: PowerShell is not available.";
    #[cfg(not(target_os = "windows"))]
    let message = "could not copy: install wl-clipboard, xclip, or xsel.";
    Err(QdError::Runtime(message.to_owned()))
}

pub(crate) fn open_in_browser(url: &Url) -> Result<(), QdError> {
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = ProcessCommand::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", url.as_str()]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = ProcessCommand::new("open");
        command.arg(url.as_str());
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = ProcessCommand::new("xdg-open");
        command.arg(url.as_str());
        command
    };
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| {
            QdError::Runtime(format!("could not open the room in a browser: {error}"))
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(QdError::Runtime(format!(
            "could not open the room in a browser: opener exited with {status}"
        )))
    }
}

#[derive(Debug)]
pub(crate) enum QdError {
    Runtime(String),
    Remote {
        code: Option<String>,
        message: String,
    },
    Usage(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_the_tui_when_qd_has_no_arguments_in_a_terminal() {
        assert!(should_launch_tui(&[], true));
        assert!(should_launch_tui(&["--tui".to_owned()], true));
        assert!(!should_launch_tui(&[], false));
        assert!(!should_launch_tui(&["DEV".to_owned()], true));
    }

    #[test]
    fn parses_and_normalizes_a_code() {
        let command = parse_command(
            vec![
                "dev_1".to_owned(),
                "--server".to_owned(),
                "https://quickdrop.example/".to_owned(),
            ],
            false,
        )
        .unwrap();
        assert_eq!(command.code, "DEV_1");
        assert_eq!(command.server.as_str(), "https://quickdrop.example/");
    }

    #[test]
    fn rejects_an_invalid_code() {
        let error = parse_command(vec!["invalid code".to_owned()], false).unwrap_err();
        assert!(matches!(error, QdError::Usage(message) if message.contains("1–16")));
    }

    #[test]
    fn parses_positional_publish_and_piped_pin_forms() {
        let positional = parse_command(
            vec!["hello".to_owned(), "dev".to_owned(), "1234".to_owned()],
            false,
        )
        .unwrap();
        assert_eq!(positional.content.as_deref(), Some("hello"));
        assert_eq!(positional.code, "DEV");
        assert_eq!(positional.pin.as_deref(), Some("1234"));

        let piped = parse_command(vec!["dev".to_owned(), "1234".to_owned()], true).unwrap();
        assert!(piped.content.is_none());
        assert_eq!(piped.code, "DEV");
        assert_eq!(piped.pin.as_deref(), Some("1234"));
    }

    #[test]
    fn builds_an_endpoint_below_a_server_path() {
        let server = Url::parse("https://quickdrop.example/base").unwrap();
        assert_eq!(
            endpoint(&server, "api/text/A").unwrap().as_str(),
            "https://quickdrop.example/base/api/text/A"
        );
    }

    #[test]
    fn rejects_credentials_in_server_urls() {
        let error = parse_server_url("https://user:secret@quickdrop.example").unwrap_err();
        assert!(matches!(error, QdError::Usage(message) if message.contains("credentials")));
    }

    #[test]
    fn reads_the_newest_drop_before_the_legacy_text() {
        let content = latest_content(SnapshotResponse {
            text: "legacy".to_owned(),
            drops: vec![
                TextDrop {
                    id: "older".to_owned(),
                    content: "older item".to_owned(),
                    created_at: "2026-08-13T10:00:00.000Z".to_owned(),
                },
                TextDrop {
                    id: "newer".to_owned(),
                    content: "newer item".to_owned(),
                    created_at: "2026-08-13T11:00:00.000Z".to_owned(),
                },
            ],
        });
        assert_eq!(content, "newer item");
    }
    #[test]
    fn translates_known_server_errors_to_english() {
        assert_eq!(
            remote_error_message(Some("pin_invalid"), "PIN inválido."),
            "Invalid PIN."
        );
        assert_eq!(
            remote_error_message(Some("room_full"), "Sala cheia."),
            "Clipboard is full."
        );
    }

    #[test]
    fn empty_room_does_not_invoke_the_clipboard_writer() {
        let mut copied = false;
        let result = prepare_received_content(String::new(), |_| {
            copied = true;
            Ok(())
        })
        .unwrap();
        assert!(result.is_none());
        assert!(!copied);
    }
}
