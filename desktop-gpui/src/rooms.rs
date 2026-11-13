use std::{sync::mpsc::Sender, time::Duration};

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{net::TcpStream, sync::mpsc::UnboundedReceiver};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, http::header, Message},
    MaybeTlsStream, WebSocketStream,
};
use url::Url;

const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Drop {
    pub id: String,
    pub content: String,
    pub created_at: String,
    pub expires_at: String,
}

pub enum Command {
    Add(String),
    Delete(String),
    Close,
}

#[derive(Debug)]
pub enum Event {
    Connected { code: String },
    Snapshot { drops: Vec<Drop>, presence: u64, expires_at: Option<String> },
    Added { drop: Drop, remote: bool },
    Updated(Drop),
    Removed(Vec<String>),
    Cleared,
    Presence(u64),
    Lifecycle(Option<String>),
    Sent,
    Error(String),
    Closed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenResponse {
    code: String,
    protected: bool,
    created: bool,
    access_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum WireMessage {
    Snapshot { client_id: String, drops: Vec<Drop>, presence: u64, expires_at: Option<String> },
    DropAdded { drop: Drop, by: String },
    DropUpdated { drop: Drop, by: String },
    DropsRemoved { drop_ids: Vec<String> },
    DropDeleted { drop_id: String },
    DropsCleared,
    Presence { count: u64 },
    Lifecycle { expires_at: Option<String>, presence: u64 },
    Error { error: Option<String>, message: Option<String> },
    #[serde(other)]
    Ignored,
}

#[derive(Default)]
struct RoomState {
    client_id: Option<String>,
}

impl RoomState {
    fn receive(&mut self, wire: WireMessage, code: &str, events: &Sender<Event>) -> Result<(), String> {
        let event = match wire {
            WireMessage::Snapshot { client_id, drops, presence, expires_at } => {
                if client_id.is_empty() {
                    return Err("The server did not identify this connection.".to_owned());
                }
                for drop in &drops {
                    validate_drop(drop)?;
                }
                if self.client_id.is_none() {
                    let _ = events.send(Event::Connected { code: code.to_owned() });
                }
                self.client_id = Some(client_id);
                Event::Snapshot { drops, presence, expires_at }
            }
            WireMessage::DropAdded { drop, by } => {
                validate_drop(&drop)?;
                let client_id = self.client_id.as_deref()
                    .ok_or("The server sent an item before the initial snapshot.")?;
                if by.is_empty() {
                    return Err("The server sent an item without its sender.".to_owned());
                }
                let remote = by != client_id;
                let _ = events.send(Event::Added { drop, remote });
                if !remote {
                    let _ = events.send(Event::Sent);
                }
                return Ok(());
            }
            WireMessage::DropUpdated { drop, by } => {
                validate_drop(&drop)?;
                if by.is_empty() {
                    return Err("The server sent an item without its sender.".to_owned());
                }
                Event::Updated(drop)
            }
            WireMessage::DropsRemoved { drop_ids } => {
                if drop_ids.iter().any(String::is_empty) {
                    return Err("The server sent an invalid item identifier.".to_owned());
                }
                Event::Removed(drop_ids)
            }
            WireMessage::DropDeleted { drop_id } => {
                if drop_id.is_empty() {
                    return Err("The server sent an invalid item identifier.".to_owned());
                }
                Event::Removed(vec![drop_id])
            }
            WireMessage::DropsCleared => Event::Cleared,
            WireMessage::Presence { count } => Event::Presence(count),
            WireMessage::Lifecycle { expires_at, presence } => {
                let _ = events.send(Event::Presence(presence));
                Event::Lifecycle(expires_at)
            }
            WireMessage::Error { error, message } => {
                let text = remote_error(error.as_deref(), message.as_deref().unwrap_or("Room error."));
                if matches!(error.as_deref(), Some("pin_required" | "pin_invalid" | "invalid_token" | "not_found")) {
                    return Err(text);
                }
                Event::Error(text)
            }
            WireMessage::Ignored => return Ok(()),
        };
        let _ = events.send(event);
        Ok(())
    }
}

pub async fn connect(
    base: String,
    code: String,
    pin: Option<String>,
    mut commands: UnboundedReceiver<Command>,
    events: Sender<Event>,
) -> Result<(), String> {
    let result = run(&base, &code, pin.as_deref(), &mut commands, &events).await;
    if let Err(error) = &result {
        let _ = events.send(Event::Error(error.clone()));
    }
    let _ = events.send(Event::Closed);
    result
}

async fn run(
    base: &str,
    code: &str,
    pin: Option<&str>,
    commands: &mut UnboundedReceiver<Command>,
    events: &Sender<Event>,
) -> Result<(), String> {
    let code = normalize_code(code)?;
    let pin = normalize_pin(pin)?;
    let opening = open(base, &code, pin);
    tokio::pin!(opening);
    let mut socket = loop {
        tokio::select! {
            biased;
            command = commands.recv() => match command {
                None | Some(Command::Close) => return Ok(()),
                Some(_) => { let _ = events.send(Event::Error("Wait for the clipboard to connect before changing items.".to_owned())); }
            },
            result = &mut opening => break result?,
        }
    };
    let mut state = RoomState::default();
    let snapshot_deadline = tokio::time::sleep(NETWORK_TIMEOUT);
    tokio::pin!(snapshot_deadline);
    let result = loop {
        tokio::select! {
            biased;
            command = commands.recv() => {
                let command = match command {
                    None | Some(Command::Close) => break Ok(()),
                    Some(command) => command,
                };
                if state.client_id.is_none() {
                    let _ = events.send(Event::Error("Wait for the clipboard snapshot before changing items.".to_owned()));
                    continue;
                }
                let payload = match command {
                    Command::Add(content) => {
                        if content.trim().is_empty() {
                            let _ = events.send(Event::Error("Enter a message before sending.".to_owned()));
                            continue;
                        }
                        json!({ "type": "drop_add", "content": content })
                    }
                    Command::Delete(drop_id) => {
                        if drop_id.trim().is_empty() {
                            let _ = events.send(Event::Error("Select an item to delete.".to_owned()));
                            continue;
                        }
                        json!({ "type": "drop_delete", "dropId": drop_id })
                    }
                    Command::Close => unreachable!(),
                };
                if let Err(error) = send(&mut socket, Message::Text(payload.to_string().into())).await {
                    break Err(error);
                }
            },
            _ = &mut snapshot_deadline, if state.client_id.is_none() => {
                break Err("Timed out waiting for the clipboard snapshot.".to_owned());
            },
            message = socket.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        let wire = match serde_json::from_str(&text) {
                            Ok(wire) => wire,
                            Err(error) => break Err(format!("The server sent an invalid message: {error}")),
                        };
                        if let Err(error) = state.receive(wire, &code, events) {
                            break Err(error);
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        if let Err(error) = send(&mut socket, Message::Pong(data)).await {
                            break Err(error);
                        }
                    }
                    Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(frame))) => {
                        let reason = frame.map(|frame| format!(" ({}: {})", frame.code, frame.reason)).unwrap_or_default();
                        break Err(format!("The clipboard connection closed{reason}. No pending changes will be retried."));
                    }
                    Some(Ok(_)) => break Err("The server sent an unsupported WebSocket message.".to_owned()),
                    Some(Err(error)) => break Err(format!("The clipboard connection failed: {error}. No pending changes will be retried.")),
                    None => break Err("The clipboard connection closed. No pending changes will be retried.".to_owned()),
                }
            }
        }
    };
    // Shutdown stays bounded even when the peer stops reading.
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.close(None)).await;
    result
}

async fn send(socket: &mut Socket, message: Message) -> Result<(), String> {
    tokio::time::timeout(NETWORK_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| "Timed out sending to the clipboard. The change may not be confirmed; it will not be retried.".to_owned())?
        .map_err(|error| format!("Could not send to the clipboard: {error}. The change will not be retried."))
}

async fn open(base: &str, code: &str, pin: Option<&str>) -> Result<Socket, String> {
    let mut url = room_endpoint(base, code, "open")?;
    let client = reqwest::Client::builder()
        .timeout(NETWORK_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not configure the HTTP client: {error}"))?;
    let response = client.post(url.clone())
        .json(&pin.map_or_else(|| json!({}), |pin| json!({ "pin": pin })))
        .send().await
        .map_err(|error| format!("Could not open the clipboard: {error}"))?;
    let cookie_name = format!("qd_text_access_{code}=");
    let cookie = response.headers().get_all(reqwest::header::SET_COOKIE).iter()
        .filter_map(|value| value.to_str().ok())
        .filter_map(|value| value.split(';').next())
        .find(|value| value.starts_with(&cookie_name))
        .map(str::to_owned);
    let status = response.status();
    let payload: Value = response.json().await
        .map_err(|error| format!("The server returned an invalid open response ({status}): {error}"))?;
    if !status.is_success() {
        return Err(remote_error(
            payload.get("error").and_then(Value::as_str),
            payload.get("message").and_then(Value::as_str).unwrap_or("Could not open the clipboard."),
        ));
    }
    let opened: OpenResponse = serde_json::from_value(payload)
        .map_err(|error| format!("The server returned an invalid open response: {error}"))?;
    validate_open(&opened, code, pin)?;
    if opened.protected && opened.access_token.as_deref().filter(|token| !token.is_empty()).is_none() && cookie.is_none() {
        return Err("The server did not grant access to this protected clipboard.".to_owned());
    }
    let path = url.path().strip_suffix("/open").ok_or("Invalid clipboard endpoint.")?;
    let path = format!("{path}/ws");
    url.set_path(&path);
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| "Could not prepare the WebSocket URL.".to_owned())?;
    let mut request = url.as_str().into_client_request()
        .map_err(|error| format!("Could not prepare the clipboard connection: {error}"))?;
    if let Some(token) = opened.access_token.filter(|token| !token.is_empty()) {
        request.headers_mut().insert(header::SEC_WEBSOCKET_PROTOCOL,
            format!("quickdrop-access.{token}").parse()
                .map_err(|_| "The room access token is invalid.".to_owned())?);
    } else if let Some(cookie) = cookie {
        request.headers_mut().insert(header::COOKIE,
            cookie.parse().map_err(|_| "The room access cookie is invalid.".to_owned())?);
    }
    tokio::time::timeout(NETWORK_TIMEOUT, connect_async(request)).await
        .map_err(|_| "Timed out connecting to the clipboard.".to_owned())?
        .map(|(socket, _)| socket)
        .map_err(|error| format!("Could not connect to the clipboard: {error}"))
}

fn normalize_code(code: &str) -> Result<String, String> {
    let code = code.trim().to_ascii_uppercase();
    if code.is_empty() || code.len() > 16 || !code.bytes().all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')) {
        return Err("Use 1–16 letters, numbers, hyphens, or underscores in the room name.".to_owned());
    }
    Ok(code)
}

fn normalize_pin(pin: Option<&str>) -> Result<Option<&str>, String> {
    let pin = pin.map(str::trim).filter(|pin| !pin.is_empty());
    // The server measures JavaScript string length, including two units per astral character.
    if pin.is_some_and(|pin| !(4..=64).contains(&pin.encode_utf16().count())) {
        return Err("Use a PIN with 4–64 characters.".to_owned());
    }
    Ok(pin)
}

fn room_endpoint(base: &str, code: &str, action: &str) -> Result<Url, String> {
    let mut url = Url::parse(base.trim()).map_err(|error| format!("Invalid server URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none()
        || !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("Use an HTTP or HTTPS server URL without credentials, a query, or a fragment.".to_owned());
    }
    let prefix = url.path().trim_end_matches('/');
    let path = format!("{prefix}/api/text/{code}/{action}");
    url.set_path(&path);
    Ok(url)
}

fn validate_open(opened: &OpenResponse, code: &str, pin: Option<&str>) -> Result<(), String> {
    if opened.code != code {
        return Err("The server returned a different clipboard name.".to_owned());
    }
    if pin.is_some() && !opened.created && !opened.protected {
        return Err("This clipboard already exists without a PIN. Connect again without a PIN.".to_owned());
    }
    Ok(())
}

fn validate_drop(drop: &Drop) -> Result<(), String> {
    if drop.id.is_empty() || drop.created_at.is_empty() || drop.expires_at.is_empty() {
        return Err("The server sent an invalid item.".to_owned());
    }
    Ok(())
}

fn remote_error(code: Option<&str>, fallback: &str) -> String {
    match code {
        Some("pin_required") => "Clipboard is protected by a PIN.",
        Some("pin_invalid") => "Invalid PIN.",
        Some("invalid_code") => "Use 1–16 letters, numbers, hyphens, or underscores in the room name.",
        Some("invalid_token") => "Room access expired. Enter the PIN again.",
        Some("not_found") => "Clipboard not found.",
        Some("room_full") => "Clipboard is full.",
        Some("session_limit") => "Clipboard limit reached. Try again later.",
        Some("code_exhausted") => "Could not reserve a clipboard name.",
        Some("create_failed") => "Could not open the clipboard.",
        Some("too_large") => "The message is too large.",
        Some("empty_drop") => "Enter a message before sending.",
        Some("drop_not_found") => "Message not found.",
        Some("operation_failed") => "Could not complete the operation.",
        _ => fallback,
    }.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receive(state: &mut RoomState, payload: Value) -> Vec<Event> {
        let (sender, receiver) = std::sync::mpsc::channel();
        state.receive(serde_json::from_value(payload).unwrap(), "DEV", &sender).unwrap();
        receiver.try_iter().collect()
    }

    fn drop_payload() -> Value {
        json!({ "id": "item-1", "content": "hello", "createdAt": "2026-11-12T10:00:00Z", "expiresAt": "2026-11-13T10:00:00Z" })
    }

    #[test]
    fn validates_room_codes_without_silently_stripping_characters() {
        assert_eq!(normalize_code(" dev_1-x ").unwrap(), "DEV_1-X");
        assert_eq!(normalize_code("1234567890123456").unwrap(), "1234567890123456");
        for code in ["", " ", "12345678901234567", "dev/1", "a b", "é", "../a"] {
            assert!(normalize_code(code).is_err(), "{code}");
        }
    }

    #[test]
    fn validates_trimmed_pin_using_server_string_length() {
        assert_eq!(normalize_pin(Some("  1234  ")).unwrap(), Some("1234"));
        assert_eq!(normalize_pin(Some("  ")).unwrap(), None);
        assert!(normalize_pin(Some("123")).is_err());
        assert!(normalize_pin(Some(&"x".repeat(65))).is_err());
        assert!(normalize_pin(Some(&"x".repeat(64))).is_ok());
        assert!(normalize_pin(Some("🔒🔒")).is_ok());
        assert!(normalize_pin(Some(&"🔒".repeat(33))).is_err());
    }

    #[test]
    fn keeps_server_prefix_and_rejects_url_credentials() {
        assert_eq!(room_endpoint("https://example.com/base/", "DEV", "open").unwrap().as_str(), "https://example.com/base/api/text/DEV/open");
        for base in ["file:///tmp/room", "https://user:secret@example.com", "https://example.com/?token=secret", "https://example.com/#room"] {
            assert!(room_endpoint(base, "DEV", "open").is_err());
        }
    }

    #[test]
    fn rejects_a_pin_for_an_existing_public_room() {
        let mut opened = OpenResponse { code: "DEV".to_owned(), protected: false, created: false, access_token: None };
        assert!(validate_open(&opened, "DEV", Some("1234")).is_err());
        assert!(validate_open(&opened, "DEV", None).is_ok());
        opened.created = true;
        assert!(validate_open(&opened, "DEV", Some("1234")).is_ok());
        assert!(validate_open(&opened, "OTHER", None).is_err());
    }

    #[test]
    fn confirms_only_own_add_and_reports_remote_drops() {
        let mut state = RoomState::default();
        let events = receive(&mut state, json!({ "type": "snapshot", "clientId": "self", "drops": [drop_payload()], "presence": 2, "expiresAt": null }));
        assert!(matches!(events.as_slice(), [Event::Connected { code }, Event::Snapshot { drops, presence: 2, expires_at: None }] if code == "DEV" && drops.len() == 1));
        let events = receive(&mut state, json!({ "type": "drop_added", "by": "peer", "drop": drop_payload() }));
        assert!(matches!(events.as_slice(), [Event::Added { remote: true, .. }]));
        let events = receive(&mut state, json!({ "type": "drop_added", "by": "self", "drop": drop_payload() }));
        assert!(matches!(events.as_slice(), [Event::Added { remote: false, .. }, Event::Sent]));
        let events = receive(&mut state, json!({ "type": "ack", "version": 1 }));
        assert!(events.is_empty());
        let events = receive(&mut state, json!({ "type": "error", "error": "too_large" }));
        assert!(matches!(events.as_slice(), [Event::Error(_)]));
    }

    #[test]
    fn handles_item_changes_and_lifecycle_messages() {
        let mut state = RoomState::default();
        assert!(matches!(receive(&mut state, json!({ "type": "drop_updated", "by": "peer", "drop": drop_payload() })).as_slice(), [Event::Updated(_)]));
        assert!(matches!(receive(&mut state, json!({ "type": "drop_deleted", "dropId": "a" })).as_slice(), [Event::Removed(ids)] if ids == &["a"]));
        assert!(matches!(receive(&mut state, json!({ "type": "drops_removed", "dropIds": ["a", "b"] })).as_slice(), [Event::Removed(ids)] if ids.len() == 2));
        assert!(matches!(receive(&mut state, json!({ "type": "drops_cleared" })).as_slice(), [Event::Cleared]));
        assert!(matches!(receive(&mut state, json!({ "type": "presence", "count": 3 })).as_slice(), [Event::Presence(3)]));
        assert!(matches!(receive(&mut state, json!({ "type": "lifecycle", "presence": 0, "expiresAt": "later" })).as_slice(), [Event::Presence(0), Event::Lifecycle(Some(expiry))] if expiry == "later"));
    }

    #[test]
    fn rejects_invalid_wire_data_and_unidentified_adds() {
        assert!(serde_json::from_value::<WireMessage>(json!({ "type": "snapshot", "drops": [], "presence": 1 })).is_err());
        assert!(serde_json::from_value::<WireMessage>(json!({ "type": "presence", "count": -1 })).is_err());
        assert!(serde_json::from_value::<WireMessage>(json!({ "type": "drop_added", "drop": drop_payload(), "by": null })).is_err());
        let (sender, _) = std::sync::mpsc::channel();
        let wire = serde_json::from_value(json!({ "type": "drop_added", "drop": drop_payload(), "by": "self" })).unwrap();
        assert!(RoomState::default().receive(wire, "DEV", &sender).is_err());
    }

    async fn loopback_room(access_token: bool) {
        use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/prefix", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut http, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                assert!(http.read_buf(&mut request).await.unwrap() > 0);
                let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
                    continue;
                };
                let headers = std::str::from_utf8(&request[..header_end]).unwrap();
                let length: usize = headers.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse().unwrap())
                }).unwrap();
                if request.len() < header_end + 4 + length {
                    continue;
                }
                assert!(headers.starts_with("POST /prefix/api/text/DEV/open HTTP/1.1\r\n"));
                let body: Value = serde_json::from_slice(&request[header_end + 4..]).unwrap();
                assert_eq!(body, json!({ "pin": "1234" }));
                break;
            }
            let mut opened = json!({ "code": "DEV", "protected": true, "created": false });
            if access_token {
                opened["accessToken"] = json!("test-token");
            }
            let body = opened.to_string();
            http.write_all(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nSet-Cookie: unrelated=ignore\r\nSet-Cookie: qd_text_access_DEV=test-cookie; HttpOnly; Path=/\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ).as_bytes()).await.unwrap();
            drop(http);
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_hdr_async(stream, move |request: &Request, mut response: Response| {
                assert_eq!(request.uri().path(), "/prefix/api/text/DEV/ws");
                if access_token {
                    assert_eq!(request.headers().get(header::SEC_WEBSOCKET_PROTOCOL).unwrap(), "quickdrop-access.test-token");
                    assert!(request.headers().get(header::COOKIE).is_none());
                    response.headers_mut().insert(header::SEC_WEBSOCKET_PROTOCOL, "quickdrop-access.test-token".parse().unwrap());
                } else {
                    assert!(request.headers().get(header::SEC_WEBSOCKET_PROTOCOL).is_none());
                    assert_eq!(request.headers().get(header::COOKIE).unwrap(), "qd_text_access_DEV=test-cookie");
                }
                Ok(response)
            }).await.unwrap();
            socket.send(Message::Ping(vec![1, 2].into())).await.unwrap();
            for payload in [
                json!({ "type": "snapshot", "clientId": "self", "drops": [], "presence": 1, "expiresAt": null }),
                json!({ "type": "presence", "count": 2 }),
                json!({ "type": "lifecycle", "presence": 2, "expiresAt": null }),
                json!({ "type": "drop_added", "by": "peer", "drop": drop_payload() }),
            ] {
                socket.send(Message::Text(payload.to_string().into())).await.unwrap();
            }
            assert!(matches!(socket.next().await.unwrap().unwrap(), Message::Pong(data) if data.as_ref() == [1, 2]));
            let add = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&add).unwrap(), json!({ "type": "drop_add", "content": "hello" }));
            socket.send(Message::Text(json!({ "type": "drop_added", "by": "self", "drop": drop_payload() }).to_string().into())).await.unwrap();
            socket.send(Message::Text(json!({ "type": "drop_updated", "by": "peer", "drop": drop_payload() }).to_string().into())).await.unwrap();
            let delete = socket.next().await.unwrap().unwrap().into_text().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&delete).unwrap(), json!({ "type": "drop_delete", "dropId": "item-1" }));
            socket.send(Message::Text(json!({ "type": "drop_deleted", "dropId": "item-1" }).to_string().into())).await.unwrap();
            socket.send(Message::Text(json!({ "type": "drops_removed", "dropIds": ["evicted"] }).to_string().into())).await.unwrap();
            socket.send(Message::Text(json!({ "type": "drops_cleared" }).to_string().into())).await.unwrap();
            assert!(matches!(socket.next().await.unwrap().unwrap(), Message::Close(_)));
            socket.flush().await.unwrap();
        });
        let (commands, receiver) = tokio::sync::mpsc::unbounded_channel();
        let (sender, events) = std::sync::mpsc::channel();
        let connection = tokio::spawn(connect(base, "dev".to_owned(), Some(" 1234 ".to_owned()), receiver, sender));
        let consumer = tokio::task::spawn_blocking(move || {
            let mut observed = Vec::new();
            loop {
                let event = events.recv_timeout(Duration::from_secs(5)).unwrap();
                match &event {
                    Event::Snapshot { .. } => commands.send(Command::Add("hello".to_owned())).unwrap(),
                    Event::Sent => commands.send(Command::Delete("item-1".to_owned())).unwrap(),
                    Event::Cleared => commands.send(Command::Close).unwrap(),
                    Event::Error(error) => panic!("{error}"),
                    _ => {}
                }
                let closed = matches!(&event, Event::Closed);
                observed.push(event);
                if closed {
                    break;
                }
            }
            assert_eq!(observed.iter().filter(|event| matches!(event, Event::Sent)).count(), 1);
            assert!(observed.iter().any(|event| matches!(event, Event::Added { remote: true, .. })));
            assert!(observed.iter().any(|event| matches!(event, Event::Updated(_))));
            assert!(observed.iter().any(|event| matches!(event, Event::Lifecycle(None))));
            assert!(observed.iter().any(|event| matches!(event, Event::Presence(2))));
            assert!(observed.iter().any(|event| matches!(event, Event::Removed(ids) if ids == &["evicted"])));
        });
        tokio::time::timeout(Duration::from_secs(10), async {
            let (server, connection, consumer) = tokio::join!(server, connection, consumer);
            server.unwrap();
            connection.unwrap().unwrap();
            consumer.unwrap();
        }).await.unwrap();
    }

    #[tokio::test]
    async fn connects_with_token_and_handles_live_room_commands() {
        loopback_room(true).await;
    }

    #[tokio::test]
    async fn connects_with_cli_cookie_fallback() {
        loopback_room(false).await;
    }

    #[tokio::test]
    async fn dropping_commands_cancels_an_in_progress_open() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (commands, receiver) = tokio::sync::mpsc::unbounded_channel();
        let (sender, events) = std::sync::mpsc::channel();
        let connection = tokio::spawn(connect(base, "DEV".to_owned(), None, receiver, sender));
        let (_unanswered_request, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept()).await.unwrap().unwrap();
        drop(commands);
        tokio::time::timeout(Duration::from_secs(2), connection).await.unwrap().unwrap().unwrap();
        assert!(matches!(events.try_iter().collect::<Vec<_>>().as_slice(), [Event::Closed]));
    }
}
