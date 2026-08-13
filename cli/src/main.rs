use std::{
    env,
    io::{self, IsTerminal, Read, Write},
    process::{Command as ProcessCommand, Stdio},
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use reqwest::{header::SET_COOKIE, Client, Url};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::{connect_async, tungstenite::Message};
mod tui;

const DEFAULT_API_BASE_URL: &str = "https://quickdrop.eaedave.xyz";
const USAGE: &str = "Usage:
  qd
  qd --tui [code] [--server <url>]
  echo \"text\" | qd <code> [--server <url>] [--copy]
  qd <code> [--server <url>] [--copy]

Options:
  --tui                  Open the interactive terminal interface.
  --copy                 Copy sent or received text to the local clipboard.
  --server <url>         QuickDrop URL (default: QUICKDROP_API_BASE_URL or https://quickdrop.eaedave.xyz).
  -h, --help             Show this help.";

#[derive(Debug, PartialEq, Eq)]
struct QdCommand {
    code: String,
    copy: bool,
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

    if should_launch_tui(&args, io::stdin().is_terminal()) {
        let tui_args = if args.first().is_some_and(|arg| arg == "--tui") {
            args.into_iter().skip(1).collect()
        } else {
            args
        };
        let (server, code) = parse_tui_command(tui_args)?;
        return tui::run_tui(server, code).await;
    }
    if args.first().is_some_and(|argument| argument == "--tui") {
        return Err(QdError::Usage(
            "--tui requires an interactive terminal.".to_owned(),
        ));
    }

    let command = parse_command(args)?;
    let piped_content = if io::stdin().is_terminal() {
        None
    } else {
        Some(read_piped_stdin()?)
    };
    let client = http_client()?;
    let room = open_room(&client, &command, None).await?;
    if room.protected {
        return Err(QdError::Runtime(
            "this clipboard requires a PIN and is not yet supported by qd.".to_owned(),
        ));
    }

    if let Some(content) = piped_content.filter(|content| !content.is_empty()) {
        publish_drop(&command.server, &room.code, &content).await?;
        if command.copy {
            copy_to_system_clipboard(&content)?;
        }
        return Ok(());
    }

    let content = latest_drop(&client, &command.server, &room.code).await?;
    if command.copy {
        copy_to_system_clipboard(&content)?;
    }
    print!("{content}");
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
            "--copy" => {
                return Err(QdError::Usage(
                    "--copy is only available in non-interactive mode.".to_owned(),
                ));
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

fn parse_server_url(server: &str) -> Result<Url, QdError> {
    let mut server = Url::parse(server).map_err(|_| {
        QdError::Usage("the server URL must start with http:// or https://.".to_owned())
    })?;
    if !matches!(server.scheme(), "http" | "https") {
        return Err(QdError::Usage(
            "the server URL must start with http:// or https://.".to_owned(),
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

fn parse_command(args: Vec<String>) -> Result<QdCommand, QdError> {
    let mut code = None;
    let mut copy = false;
    let mut server =
        env::var("QUICKDROP_API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_owned());
    let mut arguments = args.into_iter();

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--copy" => copy = true,
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
            _ => code = Some(argument),
        }
    }

    let code = validate_code(
        &code.ok_or_else(|| QdError::Usage("provide a clipboard code.".to_owned()))?,
    )?;

    let server = parse_server_url(&server)?;

    Ok(QdCommand { code, copy, server })
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

async fn latest_drop(client: &Client, server: &Url, code: &str) -> Result<String, QdError> {
    let url = endpoint(server, &format!("api/text/{code}"))?;
    let response = client
        .get(url)
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

fn http_client() -> Result<Client, QdError> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| QdError::Runtime(format!("could not configure the HTTP client: {error}")))
}

async fn publish_drop(server: &Url, code: &str, content: &str) -> Result<(), QdError> {
    let mut websocket_url = endpoint(server, &format!("api/text/{code}/ws"))?;
    websocket_url
        .set_scheme(if server.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|_| QdError::Runtime("could not prepare the WebSocket URL.".to_owned()))?;
    let (mut socket, _) = connect_async(websocket_url.as_str())
        .await
        .map_err(|error| {
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
                    let message = payload
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("the server rejected the text.");
                    return Err(QdError::Runtime(message.to_owned()));
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
        let message = payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_owned();
        let code = payload
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned);
        return Err(QdError::Remote { code, message });
    }
    serde_json::from_value(payload).map_err(|error| {
        QdError::Runtime(format!("the server returned an invalid response: {error}"))
    })
}

fn endpoint(server: &Url, path: &str) -> Result<Url, QdError> {
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

#[derive(Debug)]
enum QdError {
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
        let command = parse_command(vec![
            "dev_1".to_owned(),
            "--server".to_owned(),
            "https://quickdrop.example/".to_owned(),
        ])
        .unwrap();
        assert_eq!(command.code, "DEV_1");
        assert_eq!(command.server.as_str(), "https://quickdrop.example/");
    }

    #[test]
    fn rejects_an_invalid_code() {
        let error = parse_command(vec!["invalid code".to_owned()]).unwrap_err();
        assert!(matches!(error, QdError::Usage(message) if message.contains("1–16")));
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
}
