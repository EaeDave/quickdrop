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
  qd [<room> [pin]] [--server <url>]
  qd <room> [pin] --msg <text> [--server <url>]
  qd <room> [pin] --msg - [--server <url>]
  qd <room> [pin] --copy [--server <url>]
  qd update [--check] [--server <url>]

Options:
  --msg <text>           Publish text without opening the TUI. Use - to read standard input.
  --copy                 Print and copy the newest item without opening the TUI.
  update                 Download and install the latest qd binary.
  --check                Report whether a qd update is available.
  --server <url>         QuickDrop URL (default: QUICKDROP_API_BASE_URL or https://quickdrop.eaedave.xyz).
  -V, --version          Show the installed qd version.
  -h, --help             Show this help.";

#[derive(Debug, PartialEq, Eq)]
struct QdCommand {
    operation: Operation,
    server: Url,
}

#[derive(Debug, PartialEq, Eq)]
enum Operation {
    Tui {
        initial_code: Option<String>,
        initial_pin: Option<String>,
    },
    Message {
        code: String,
        pin: Option<String>,
        source: MessageSource,
    },
    Copy {
        code: String,
        pin: Option<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum MessageSource {
    Text(String),
    Stdin,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenPayload {
    code: String,
    protected: bool,
    #[serde(default)]
    created: bool,
}

#[derive(Debug)]
struct OpenResponse {
    code: String,
    protected: bool,
    created: bool,
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
    if matches!(args.as_slice(), [argument] if argument == "--help" || argument == "-h") {
        println!("{USAGE}");
        return Ok(());
    }
    if matches!(args.as_slice(), [argument] if argument == "--version" || argument == "-V") {
        println!("qd {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    if args.first().is_some_and(|argument| argument == "update") {
        return update::run_update(args.into_iter().skip(1).collect()).await;
    }

    let command = parse_command(args)?;
    match command.operation {
        Operation::Tui {
            initial_code,
            initial_pin,
        } => {
            require_interactive_terminal(io::stdin().is_terminal(), io::stdout().is_terminal())?;
            let restart = update::capture_restart_command()?;
            if tui::run_tui(command.server, initial_code, initial_pin).await? {
                restart.execute()?;
            }
            Ok(())
        }
        Operation::Message { code, pin, source } => {
            let content = match source {
                MessageSource::Text(content) => content,
                MessageSource::Stdin => read_stdin()?,
            };
            validate_message_content(&content)?;
            let client = http_client()?;
            let room = add_missing_pin_guidance(
                open_room(&client, &command.server, &code, pin.as_deref()).await,
                pin.as_deref(),
                &format!("qd {code} <pin> --msg <message>"),
            )?;
            publish_drop(
                &command.server,
                &room.code,
                &content,
                room.access_cookie.as_deref(),
            )
            .await?;
            eprintln!("{}", publish_feedback(&room));
            Ok(())
        }
        Operation::Copy { code, pin } => {
            let client = http_client()?;
            let room = add_missing_pin_guidance(
                access_existing_room(&client, &command.server, &code, pin.as_deref()).await,
                pin.as_deref(),
                &format!("qd {code} <pin> --copy"),
            )?;
            let content = latest_drop(
                &client,
                &command.server,
                &room.code,
                room.access_cookie.as_deref(),
            )
            .await?;
            let Some(content) = prepare_received_content(content, copy_to_system_clipboard)? else {
                return Err(QdError::Runtime("No messages found.".to_owned()));
            };
            let mut stdout = io::stdout();
            if !write_received_content(&mut stdout, &content)? {
                return Ok(());
            }
            eprintln!("Copied the latest message.");
            Ok(())
        }
    }
}
fn add_missing_pin_guidance(
    result: Result<OpenResponse, QdError>,
    pin: Option<&str>,
    usage: &str,
) -> Result<OpenResponse, QdError> {
    match result {
        Err(QdError::Remote {
            code: Some(code), ..
        }) if code == "pin_required" && pin.is_none() => Err(QdError::Runtime(format!(
            "This room is PIN-protected.\nUse: {usage}"
        ))),
        result => result,
    }
}

fn publish_feedback(room: &OpenResponse) -> &'static str {
    match (room.created, room.protected) {
        (true, true) => "Created a new PIN-protected room and sent the message.",
        (true, false) => "Created a new room and sent the message.",
        (false, _) => "Message sent.",
    }
}
fn validate_message_content(content: &str) -> Result<(), QdError> {
    if content.trim().is_empty() {
        Err(QdError::Usage("enter a message before sending.".to_owned()))
    } else {
        Ok(())
    }
}

fn write_received_content<W: Write>(writer: &mut W, content: &str) -> Result<bool, QdError> {
    match writer
        .write_all(content.as_bytes())
        .and_then(|()| writer.flush())
    {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(false),
        Err(error) => Err(QdError::Runtime(format!(
            "could not write the message: {error}"
        ))),
    }
}

fn require_interactive_terminal(
    stdin_is_terminal: bool,
    stdout_is_terminal: bool,
) -> Result<(), QdError> {
    if !stdin_is_terminal || !stdout_is_terminal {
        return Err(QdError::Usage(
            "interactive mode requires a terminal; use --msg <text> or --copy instead.".to_owned(),
        ));
    }
    Ok(())
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

fn parse_command(args: Vec<String>) -> Result<QdCommand, QdError> {
    let mut positional = Vec::new();
    let mut message = None;
    let mut copy = false;
    let mut server =
        env::var("QUICKDROP_API_BASE_URL").unwrap_or_else(|_| DEFAULT_API_BASE_URL.to_owned());
    let mut server_was_set = false;
    let mut arguments = args.into_iter();

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--msg" => {
                if message.is_some() {
                    return Err(QdError::Usage("provide --msg only once.".to_owned()));
                }
                if copy {
                    return Err(QdError::Usage(
                        "--msg and --copy cannot be combined.".to_owned(),
                    ));
                }
                let content = arguments
                    .next()
                    .ok_or_else(|| QdError::Usage("--msg requires text.".to_owned()))?;
                message = Some(if content == "-" {
                    MessageSource::Stdin
                } else {
                    MessageSource::Text(content)
                });
            }
            "--copy" => {
                if copy {
                    return Err(QdError::Usage("provide --copy only once.".to_owned()));
                }
                if message.is_some() {
                    return Err(QdError::Usage(
                        "--msg and --copy cannot be combined.".to_owned(),
                    ));
                }
                copy = true;
            }
            "--server" => {
                if server_was_set {
                    return Err(QdError::Usage("provide --server only once.".to_owned()));
                }
                server = arguments
                    .next()
                    .filter(|value| !value.starts_with('-'))
                    .ok_or_else(|| QdError::Usage("--server requires a URL.".to_owned()))?;
                server_was_set = true;
            }
            _ if argument.starts_with('-') => {
                return Err(QdError::Usage(format!("unknown option: {argument}")));
            }
            _ => positional.push(argument),
        }
    }

    if positional.len() > 2 {
        return Err(QdError::Usage(
            "provide only a room and optional PIN.".to_owned(),
        ));
    }
    let code = positional
        .first()
        .map(|code| validate_code(code))
        .transpose()?;
    let pin = positional
        .get(1)
        .map(|pin| {
            let length = pin.chars().count();
            if !(4..=64).contains(&length) {
                Err(QdError::Usage("use a PIN with 4–64 characters.".to_owned()))
            } else {
                Ok(pin.to_owned())
            }
        })
        .transpose()?;
    let operation = if let Some(source) = message {
        Operation::Message {
            code: code.ok_or_else(|| QdError::Usage("--msg requires a room.".to_owned()))?,
            pin,
            source,
        }
    } else if copy {
        Operation::Copy {
            code: code.ok_or_else(|| QdError::Usage("--copy requires a room.".to_owned()))?,
            pin,
        }
    } else {
        Operation::Tui {
            initial_code: code,
            initial_pin: pin,
        }
    };
    Ok(QdCommand {
        operation,
        server: parse_server_url(&server)?,
    })
}

async fn open_room(
    client: &Client,
    server: &Url,
    code: &str,
    pin: Option<&str>,
) -> Result<OpenResponse, QdError> {
    request_room_access(
        client,
        server,
        code,
        pin,
        "open",
        "open",
        "qd <room> --msg <text>",
    )
    .await
}

async fn access_existing_room(
    client: &Client,
    server: &Url,
    code: &str,
    pin: Option<&str>,
) -> Result<OpenResponse, QdError> {
    request_room_access(
        client,
        server,
        code,
        pin,
        "access",
        "access",
        "qd <room> --copy",
    )
    .await
}

async fn request_room_access(
    client: &Client,
    server: &Url,
    code: &str,
    pin: Option<&str>,
    route: &str,
    action: &str,
    pinless_usage: &str,
) -> Result<OpenResponse, QdError> {
    let url = endpoint(server, &format!("api/text/{code}/{route}"))?;
    let payload = pin.map_or_else(|| json!({}), |pin| json!({ "pin": pin }));
    let response = client
        .post(url)
        .json(&payload)
        .send()
        .await
        .map_err(|error| QdError::Runtime(format!("could not {action} the clipboard: {error}")))?;
    let access_cookie = response
        .headers()
        .get_all(SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find_map(|value| value.split(';').next().map(str::to_owned));
    let opened: OpenPayload =
        parse_response(response, &format!("could not {action} the clipboard.")).await?;
    let room = OpenResponse {
        code: opened.code,
        protected: opened.protected,
        created: opened.created,
        access_cookie,
    };
    reject_pin_for_existing_public_room(&room, pin, pinless_usage)?;
    Ok(room)
}

fn reject_pin_for_existing_public_room(
    room: &OpenResponse,
    pin: Option<&str>,
    pinless_usage: &str,
) -> Result<(), QdError> {
    if pin.is_some() && !room.created && !room.protected {
        return Err(QdError::Runtime(format!(
            "This room already exists without a PIN.\nUse: {pinless_usage}"
        )));
    }
    Ok(())
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

fn read_stdin() -> Result<String, QdError> {
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
    fn parses_tui_chooser_room_and_pin_forms() {
        let chooser = parse_command(Vec::new()).unwrap();
        assert_eq!(
            chooser.operation,
            Operation::Tui {
                initial_code: None,
                initial_pin: None,
            }
        );

        let room = parse_command(vec![
            "dev_1".to_owned(),
            "1234".to_owned(),
            "--server".to_owned(),
            "https://quickdrop.example/".to_owned(),
        ])
        .unwrap();
        assert_eq!(
            room.operation,
            Operation::Tui {
                initial_code: Some("DEV_1".to_owned()),
                initial_pin: Some("1234".to_owned()),
            }
        );
        assert_eq!(room.server.as_str(), "https://quickdrop.example/");
    }

    #[test]
    fn parses_literal_and_stdin_message_forms() {
        let literal = parse_command(vec![
            "dev".to_owned(),
            "1234".to_owned(),
            "--msg".to_owned(),
            "hello there".to_owned(),
        ])
        .unwrap();
        assert_eq!(
            literal.operation,
            Operation::Message {
                code: "DEV".to_owned(),
                pin: Some("1234".to_owned()),
                source: MessageSource::Text("hello there".to_owned()),
            }
        );

        let stdin =
            parse_command(vec!["dev".to_owned(), "--msg".to_owned(), "-".to_owned()]).unwrap();
        assert_eq!(
            stdin.operation,
            Operation::Message {
                code: "DEV".to_owned(),
                pin: None,
                source: MessageSource::Stdin,
            }
        );

        let hyphen_text = parse_command(vec![
            "dev".to_owned(),
            "--msg".to_owned(),
            "-literal".to_owned(),
        ])
        .unwrap();
        assert!(matches!(
            hyphen_text.operation,
            Operation::Message {
                source: MessageSource::Text(content),
                ..
            } if content == "-literal"
        ));
        for option_like_text in [
            "--help",
            "-h",
            "--version",
            "-V",
            "--copy",
            "--msg",
            "--server",
        ] {
            let parsed = parse_command(vec![
                "dev".to_owned(),
                "--msg".to_owned(),
                option_like_text.to_owned(),
            ])
            .unwrap();
            assert!(matches!(
                parsed.operation,
                Operation::Message {
                    source: MessageSource::Text(content),
                    ..
                } if content == option_like_text
            ));
        }
    }

    #[test]
    fn parses_copy_without_inventing_a_message() {
        let copy = parse_command(vec![
            "dev".to_owned(),
            "1234".to_owned(),
            "--copy".to_owned(),
        ])
        .unwrap();
        assert_eq!(
            copy.operation,
            Operation::Copy {
                code: "DEV".to_owned(),
                pin: Some("1234".to_owned()),
            }
        );

        let tui = parse_command(vec!["hello".to_owned(), "1234".to_owned()]).unwrap();
        assert!(matches!(tui.operation, Operation::Tui { .. }));
    }

    #[test]
    fn rejects_invalid_combinations_before_execution() {
        let cases = [
            vec!["dev", "--msg", "hello", "--copy"],
            vec!["dev", "--copy", "--copy"],
            vec!["dev", "--msg", "one", "--msg", "two"],
            vec!["dev", "1234", "extra", "--copy"],
            vec!["--msg", "hello"],
            vec!["dev", "--tui"],
            vec![
                "dev",
                "--server",
                "https://one.example",
                "--server",
                "https://two.example",
            ],
            vec!["dev", ""],
        ];
        for args in cases {
            let error = parse_command(args.into_iter().map(str::to_owned).collect()).unwrap_err();
            assert!(matches!(error, QdError::Usage(_)));
        }
    }

    #[test]
    fn rejects_an_invalid_code() {
        let error = parse_command(vec!["invalid code".to_owned()]).unwrap_err();
        assert!(matches!(error, QdError::Usage(message) if message.contains("1–16")));
    }

    #[test]
    fn noninteractive_tui_reports_actionable_guidance() {
        let error = require_interactive_terminal(false, true).unwrap_err();
        assert!(matches!(
            error,
            QdError::Usage(message)
                if message == "interactive mode requires a terminal; use --msg <text> or --copy instead."
        ));
        assert!(require_interactive_terminal(true, false).is_err());
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
    fn parses_created_and_rejects_a_pin_for_an_existing_public_room() {
        let opened: OpenPayload = serde_json::from_value(json!({
            "code": "DEV",
            "protected": false,
            "created": true
        }))
        .unwrap();
        assert!(opened.created);

        let access_payload: OpenPayload = serde_json::from_value(json!({
            "code": "DEV",
            "protected": false
        }))
        .unwrap();
        assert!(!access_payload.created);

        let room = OpenResponse {
            code: "DEV".to_owned(),
            protected: false,
            created: false,
            access_cookie: None,
        };
        let error = reject_pin_for_existing_public_room(&room, Some("1234"), "qd <room> --copy")
            .unwrap_err();
        assert!(matches!(
            error,
            QdError::Runtime(message)
                if message == "This room already exists without a PIN.\nUse: qd <room> --copy"
        ));
        assert!(reject_pin_for_existing_public_room(&room, None, "qd <room> --copy").is_ok());
    }
    #[test]
    fn missing_pin_errors_include_the_correct_command() {
        let error = add_missing_pin_guidance(
            Err(QdError::Remote {
                code: Some("pin_required".to_owned()),
                message: "Clipboard is protected by a PIN.".to_owned(),
            }),
            None,
            "qd SECRET <pin> --copy",
        )
        .unwrap_err();
        assert!(matches!(
            error,
            QdError::Runtime(message)
                if message == "This room is PIN-protected.\nUse: qd SECRET <pin> --copy"
        ));
    }

    #[test]
    fn publish_feedback_uses_authoritative_room_metadata() {
        let mut room = OpenResponse {
            code: "DEV".to_owned(),
            protected: false,
            created: false,
            access_cookie: None,
        };
        assert_eq!(publish_feedback(&room), "Message sent.");

        room.created = true;
        assert_eq!(
            publish_feedback(&room),
            "Created a new room and sent the message."
        );

        room.protected = true;
        assert_eq!(
            publish_feedback(&room),
            "Created a new PIN-protected room and sent the message."
        );
    }
    #[test]
    fn rejects_empty_messages_before_network_work() {
        assert!(validate_message_content("message").is_ok());
        let error = validate_message_content(" \n\t").unwrap_err();
        assert!(matches!(
            error,
            QdError::Usage(message) if message == "enter a message before sending."
        ));
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
    #[test]
    fn closed_stdout_is_a_successful_pipe_termination() {
        struct BrokenPipe;
        impl Write for BrokenPipe {
            fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }

        assert!(!write_received_content(&mut BrokenPipe, "message").unwrap());
        let mut output = Vec::new();
        assert!(write_received_content(&mut output, "message").unwrap());
        assert_eq!(output, b"message");
    }

    #[test]
    fn positional_pin_uses_the_server_length_contract() {
        for pin in ["123", &"x".repeat(65)] {
            let error = parse_command(vec!["DEV".to_owned(), pin.to_owned(), "--copy".to_owned()])
                .unwrap_err();
            assert!(matches!(
                error,
                QdError::Usage(message) if message == "use a PIN with 4–64 characters."
            ));
        }
    }
}
