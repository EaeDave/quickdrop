use std::{collections::VecDeque, env, io, time::Duration};

use crossterm::{
    event::{
        Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers,
        KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use futures_util::{SinkExt, StreamExt};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap},
    Frame, Terminal,
};
use reqwest::Url;
use serde_json::{json, Value};
use tokio::{
    sync::mpsc,
    time::{interval, sleep, Instant, MissedTickBehavior},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        client::IntoClientRequest,
        http::{header::COOKIE, HeaderValue},
        Message,
    },
};
use tui_textarea::TextArea;

use crate::{
    copy_to_system_clipboard, endpoint, http_client, open_room, update, QdCommand, QdError,
    TextDrop,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Screen {
    Code,
    Pin,
    Timeline,
    Help,
    ConfirmDelete,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PinPurpose {
    Unlock,
    Create,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Focus {
    Timeline,
    Composer,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
}
#[derive(Debug)]
enum Action {
    Publish(String),
    Update(String, String),
    Delete(String),
}
#[derive(Debug)]
enum NetEvent {
    State(ConnectionState),
    Snapshot(Vec<TextDrop>),
    Removed(Vec<String>),
    Added(TextDrop, bool),
    Updated(TextDrop, bool),
    Deleted(String),
    PublishFailed(Vec<String>),
    Cleared,
    Error {
        code: Option<String>,
        message: String,
    },
}

#[derive(Debug)]
enum UpdateEvent {
    Check(Result<Option<update::AvailableUpdate>, QdError>),
    Applied(Result<String, QdError>),
}
pub async fn run_tui(server: Url, initial_code: Option<String>) -> Result<(), QdError> {
    let mut terminal = TerminalGuard::enter()?;
    let mut events = EventStream::new();
    let mut app = App::new(server, initial_code);
    let mut connection = None;
    let (update_tx, mut update_rx) = mpsc::channel(2);
    tokio::spawn({
        let server = app.server.clone();
        let update_tx = update_tx.clone();
        async move {
            let _ = update_tx
                .send(UpdateEvent::Check(update::check_for_update(&server).await))
                .await;
        }
    });

    loop {
        terminal
            .draw(|frame| render(frame, &mut app))
            .map_err(terminal_error)?;
        if app.update_requested {
            app.update_requested = false;
            if let Some(available) = app.available_update.clone() {
                let server = app.server.clone();
                let update_tx = update_tx.clone();
                tokio::spawn(async move {
                    let _ = update_tx
                        .send(UpdateEvent::Applied(
                            update::apply_update(&server, Some(&available)).await,
                        ))
                        .await;
                });
            }
        }
        if app.quit {
            if app.restart_after_update {
                drop(terminal);
                return update::restart_current_process();
            }
            return Ok(());
        }

        if app.screen == Screen::Timeline && connection.is_none() {
            let command = QdCommand {
                code: app.code.clone(),
                copy: false,
                server: app.server.clone(),
            };
            let pin = (!app.pin_input.trim().is_empty()).then(|| app.pin_input.trim().to_owned());
            let room = match http_client() {
                Ok(client) => open_room(&client, &command, pin.as_deref()).await,
                Err(error) => Err(error),
            };
            let room = match room {
                Ok(room) => room,
                Err(QdError::Remote {
                    code: Some(code),
                    message,
                }) if code == "pin_required"
                    || code == "pin_invalid"
                    || code == "invalid_token" =>
                {
                    if code == "pin_required" || code == "invalid_token" {
                        app.pin_purpose = PinPurpose::Unlock;
                    }
                    app.screen = Screen::Pin;
                    app.pin_input.clear();
                    app.status = Some(message);
                    continue;
                }
                Err(error) => {
                    app.screen = Screen::Code;
                    app.code_input = app.code.clone();
                    app.status = Some(error_message(error));
                    app.code.clear();
                    app.pin_input.clear();
                    continue;
                }
            };
            let creating_protected = app.pin_purpose == PinPurpose::Create;
            if creating_protected && !room.protected {
                app.screen = Screen::Code;
                app.code_input = app.code.clone();
                app.status = Some("This clipboard already exists without a PIN".to_owned());
                app.code.clear();
                app.pin_input.clear();
                continue;
            }
            app.pin_purpose = PinPurpose::Unlock;
            app.pin_input.clear();
            app.code = room.code;
            let (actions_tx, actions_rx) = mpsc::channel(32);
            let (network_tx, network_rx) = mpsc::channel(64);
            tokio::spawn(realtime_client(
                app.server.clone(),
                app.code.clone(),
                room.access_cookie,
                actions_rx,
                network_tx,
            ));
            connection = Some((actions_tx, network_rx));
        }

        if let Some((actions, network)) = connection.as_mut() {
            let reset_connection = tokio::select! {
                terminal_event = events.next() => {
                    match terminal_event {
                        Some(Ok(Event::Key(key))) => handle_key(&mut app, key, Some(actions)).await?,
                        Some(Ok(_)) => {}
                        Some(Err(error)) => return Err(terminal_error(error)),
                        None => return Ok(()),
                    }
                    false
                },
                update_event = update_rx.recv() => {
                    apply_update_event(&mut app, update_event);
                    false
                },
                network_event = network.recv() => match network_event {
                    Some(event) => apply_network_event(&mut app, event),
                    None => {
                        app.connection = ConnectionState::Reconnecting;
                        false
                    }
                }
            };
            if reset_connection {
                connection = None;
            }
        } else {
            tokio::select! {
                terminal_event = events.next() => match terminal_event {
                    Some(Ok(Event::Key(key))) => handle_key(&mut app, key, None).await?,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(terminal_error(error)),
                    None => return Ok(()),
                },
                update_event = update_rx.recv() => apply_update_event(&mut app, update_event),
            }
        }
    }
}

struct App<'a> {
    screen: Screen,
    focus: Focus,
    code_input: String,
    pin_input: String,
    pin_purpose: PinPurpose,
    code: String,
    drops: Vec<TextDrop>,
    selected: usize,
    composer: TextArea<'a>,
    composer_draft_before_edit: Option<String>,
    editing_drop_id: Option<String>,
    edit_saving: bool,
    connection: ConnectionState,
    status: Option<String>,
    available_update: Option<update::AvailableUpdate>,
    update_busy: bool,
    update_requested: bool,
    restart_after_update: bool,
    no_color: bool,
    server: Url,
    quit: bool,
}

impl<'a> App<'a> {
    fn new(server: Url, code: Option<String>) -> Self {
        let mut composer = TextArea::default();
        composer.set_placeholder_text("Write or paste a new drop…");
        composer.set_cursor_line_style(Style::default());
        Self {
            screen: if code.is_some() {
                Screen::Timeline
            } else {
                Screen::Code
            },
            focus: Focus::Timeline,
            code_input: String::new(),
            pin_input: String::new(),
            pin_purpose: PinPurpose::Unlock,
            code: code.unwrap_or_default(),
            drops: Vec::new(),
            selected: 0,
            composer,
            connection: ConnectionState::Connecting,
            composer_draft_before_edit: None,
            editing_drop_id: None,
            edit_saving: false,
            status: None,
            available_update: None,
            update_busy: false,
            update_requested: false,
            restart_after_update: false,
            no_color: env::var_os("NO_COLOR").is_some(),
            server,
            quit: false,
        }
    }
    fn submit_code(&mut self, pin_purpose: Option<PinPurpose>) {
        if self.code_input.is_empty() {
            if pin_purpose == Some(PinPurpose::Create) {
                self.pin_purpose = PinPurpose::Create;
                self.status = Some("Choose a code, then Enter to set the PIN".to_owned());
            } else {
                self.status = Some("Use 1–16 letters, numbers, hyphens, or underscores".to_owned());
            }
            return;
        }
        match normalize_code(&self.code_input) {
            Ok(code) => {
                self.code = code;
                self.status = None;
                if pin_purpose == Some(PinPurpose::Create) || self.pin_purpose == PinPurpose::Create
                {
                    self.pin_purpose = PinPurpose::Create;
                    self.pin_input.clear();
                    self.screen = Screen::Pin;
                } else {
                    self.pin_purpose = PinPurpose::Unlock;
                    self.screen = Screen::Timeline;
                }
            }
            Err(message) => self.status = Some(message),
        }
    }
    fn color(&self, color: Color) -> Color {
        if self.no_color {
            Color::Reset
        } else {
            color
        }
    }
    fn selected_drop(&self) -> Option<&TextDrop> {
        self.drops.get(self.selected)
    }
    fn select_next(&mut self) {
        if !self.drops.is_empty() {
            self.selected = (self.selected + 1).min(self.drops.len() - 1);
        }
    }
    fn replace_drops(&mut self, mut drops: Vec<TextDrop>) {
        let selected_id = self.selected_drop().map(|drop| drop.id.clone());
        let fallback = self.selected;
        sort_drops(&mut drops);
        self.drops = drops;
        self.selected = selected_id
            .and_then(|id| self.drops.iter().position(|drop| drop.id == id))
            .unwrap_or_else(|| fallback.min(self.drops.len().saturating_sub(1)));
    }
    fn add_drop(&mut self, drop: TextDrop, local: bool) {
        let selected_id = self.selected_drop().map(|item| item.id.clone());
        let added_id = drop.id.clone();
        self.drops.retain(|item| item.id != drop.id);
        self.drops.push(drop);
        sort_drops(&mut self.drops);
        if local {
            self.selected = self
                .drops
                .iter()
                .position(|item| item.id == added_id)
                .unwrap_or_default();
            self.status = Some("Sent".to_owned());
        } else if let Some(selected_id) = selected_id {
            self.selected = self
                .drops
                .iter()
                .position(|item| item.id == selected_id)
                .unwrap_or_else(|| self.selected.min(self.drops.len().saturating_sub(1)));
        }
    }
    fn remove_drop(&mut self, id: &str) {
        self.drops.retain(|drop| drop.id != id);
        self.selected = self.selected.min(self.drops.len().saturating_sub(1));
    }
    fn composer_content(&self) -> String {
        self.composer.lines().join("\n")
    }
    fn clear_composer(&mut self) {
        self.composer = TextArea::default();
        self.composer
            .set_placeholder_text("Write or paste a new drop…");
        self.composer.set_cursor_line_style(Style::default());
    }
    fn restore_composer(&mut self, contents: Vec<String>) {
        let content = contents.join("\n\n");
        self.composer = TextArea::from(content.split('\n').map(str::to_owned).collect::<Vec<_>>());
        self.composer
            .set_placeholder_text("Write or paste a new drop…");
        self.composer.set_cursor_line_style(Style::default());
        self.focus = Focus::Composer;
    }
    fn begin_edit(&mut self) {
        let Some(drop) = self.selected_drop() else {
            return;
        };
        let drop_id = drop.id.clone();
        let content = drop.content.clone();
        self.composer_draft_before_edit = Some(self.composer_content());
        self.composer = TextArea::from(content.split('\n').map(str::to_owned).collect::<Vec<_>>());
        self.composer.set_cursor_line_style(Style::default());
        self.editing_drop_id = Some(drop_id);
        self.edit_saving = false;
        self.focus = Focus::Composer;
    }
    fn finish_edit(&mut self) {
        let draft = self.composer_draft_before_edit.take().unwrap_or_default();
        self.composer = TextArea::from(draft.split('\n').map(str::to_owned).collect::<Vec<_>>());
        self.composer
            .set_placeholder_text("Write or paste a new drop…");
        self.composer.set_cursor_line_style(Style::default());
        self.editing_drop_id = None;
        self.edit_saving = false;
        self.focus = Focus::Timeline;
    }
    fn update_drop(&mut self, drop: TextDrop, local: bool) {
        let selected_id = self.selected_drop().map(|item| item.id.clone());
        if let Some(existing) = self.drops.iter_mut().find(|item| item.id == drop.id) {
            *existing = drop;
            sort_drops(&mut self.drops);
            if let Some(selected_id) = selected_id {
                self.selected = self
                    .drops
                    .iter()
                    .position(|item| item.id == selected_id)
                    .unwrap_or_else(|| self.selected.min(self.drops.len().saturating_sub(1)));
            }
            if local {
                self.finish_edit();
                self.status = Some("Edited".to_owned());
            } else {
                self.status = Some("Edited on another device".to_owned());
            }
        }
    }
}

async fn handle_key(
    app: &mut App<'_>,
    key: KeyEvent,
    actions: Option<&mpsc::Sender<Action>>,
) -> Result<(), QdError> {
    if key.kind != KeyEventKind::Press && key.kind != KeyEventKind::Repeat {
        return Ok(());
    }
    if app.screen == Screen::Timeline {
        app.status = None;
    }
    match app.screen {
        Screen::Code => match key.code {
            KeyCode::Esc => app.quit = true,
            KeyCode::Char('p') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if app.pin_purpose == PinPurpose::Create && app.code_input.is_empty() {
                    app.pin_purpose = PinPurpose::Unlock;
                    app.status = None;
                } else {
                    app.submit_code(Some(PinPurpose::Create));
                }
            }
            KeyCode::Enter => app.submit_code(None),
            KeyCode::Backspace => {
                app.code_input.pop();
            }
            KeyCode::Char(character) if app.code_input.len() < 16 && valid_code_char(character) => {
                app.code_input.push(character.to_ascii_uppercase())
            }
            _ => {}
        },
        Screen::Pin => match key.code {
            KeyCode::Esc => {
                app.screen = Screen::Code;
                app.code_input = app.code.clone();
                app.pin_input.clear();
                app.pin_purpose = PinPurpose::Unlock;
                app.status = None;
            }
            KeyCode::Enter => {
                let pin_length = app.pin_input.trim().chars().count();
                if (4..=64).contains(&pin_length) {
                    app.screen = Screen::Timeline;
                    app.status = None;
                } else {
                    app.status = Some("Use a PIN with 4–64 characters".to_owned());
                }
            }
            KeyCode::Backspace => {
                app.pin_input.pop();
            }
            KeyCode::Char(character)
                if !character.is_control() && app.pin_input.chars().count() < 64 =>
            {
                app.pin_input.push(character);
            }
            _ => {}
        },
        Screen::Help => match key.code {
            KeyCode::Char('q') => app.quit = true,
            KeyCode::Esc | KeyCode::Char('?') => app.screen = Screen::Timeline,
            _ => {}
        },
        Screen::ConfirmDelete => match key.code {
            KeyCode::Char('y') | KeyCode::Enter => {
                if app.connection != ConnectionState::Connected {
                    app.status = Some("Wait for the connection before deleting".to_owned());
                } else if let (Some(sender), Some(drop)) = (actions, app.selected_drop()) {
                    sender
                        .send(Action::Delete(drop.id.clone()))
                        .await
                        .map_err(channel_error)?;
                    app.status = Some("Deleting…".to_owned());
                }
                app.screen = Screen::Timeline;
            }
            KeyCode::Esc | KeyCode::Char('n') => app.screen = Screen::Timeline,
            _ => {}
        },
        Screen::Timeline => handle_timeline_key(app, key, actions).await?,
    }
    Ok(())
}

async fn handle_timeline_key(
    app: &mut App<'_>,
    key: KeyEvent,
    actions: Option<&mpsc::Sender<Action>>,
) -> Result<(), QdError> {
    if app.focus == Focus::Composer {
        if key.code == KeyCode::Esc {
            if app.editing_drop_id.is_some() {
                app.finish_edit();
            } else {
                app.focus = Focus::Timeline;
            }
        } else if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Enter | KeyCode::Char('s'))
        {
            let content = app.composer_content();
            let verb = if app.editing_drop_id.is_some() {
                "saving"
            } else {
                "sending"
            };
            if content.trim().is_empty() {
                app.status = Some(format!("Write something before {verb}"));
            } else if app.connection != ConnectionState::Connected {
                app.status = Some(format!("Wait for the connection before {verb}"));
            } else if app.edit_saving {
                app.status = Some("Wait for edit confirmation".to_owned());
            } else if let Some(sender) = actions {
                if let Some(drop_id) = app.editing_drop_id.clone() {
                    sender
                        .send(Action::Update(drop_id, content))
                        .await
                        .map_err(channel_error)?;
                    app.edit_saving = true;
                    app.status = Some("Saving…".to_owned());
                } else {
                    sender
                        .send(Action::Publish(content))
                        .await
                        .map_err(channel_error)?;
                    app.clear_composer();
                    app.focus = Focus::Timeline;
                    app.status = Some("Sending…".to_owned());
                }
            }
        } else if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('u') {
            app.clear_composer();
        } else if !app.edit_saving {
            app.composer.input(key);
        }
        return Ok(());
    }
    match key.code {
        KeyCode::Char('q') => app.quit = true,
        KeyCode::Char('?') => app.screen = Screen::Help,
        KeyCode::Char('j') | KeyCode::Down => app.select_next(),
        KeyCode::Char('k') | KeyCode::Up => app.selected = app.selected.saturating_sub(1),
        KeyCode::Char('g') | KeyCode::Home => app.selected = 0,
        KeyCode::Char('G') | KeyCode::End => app.selected = app.drops.len().saturating_sub(1),
        KeyCode::Enter | KeyCode::Char('i') | KeyCode::Tab => app.focus = Focus::Composer,
        KeyCode::Char('e') if app.selected_drop().is_some() => app.begin_edit(),
        KeyCode::Char('y') => {
            if let Some(content) = app.selected_drop().map(|drop| drop.content.clone()) {
                match copy_to_system_clipboard(&content) {
                    Ok(()) => app.status = Some("Copied".to_owned()),
                    Err(error) => app.status = Some(error_message(error)),
                }
            }
        }
        KeyCode::Char('r') => {
            if app.connection != ConnectionState::Connected {
                app.status = Some("Wait for the connection before resending".to_owned());
            } else if let (Some(sender), Some(content)) = (
                actions,
                app.selected_drop().map(|drop| drop.content.clone()),
            ) {
                sender
                    .send(Action::Publish(content))
                    .await
                    .map_err(channel_error)?;
                app.status = Some("Resending…".to_owned());
            }
        }
        KeyCode::Char('d') if app.selected_drop().is_some() => app.screen = Screen::ConfirmDelete,
        KeyCode::Char('u') if app.available_update.is_some() => {
            if app.update_busy {
                app.status = Some("Updating qd…".to_owned());
            } else {
                app.update_busy = true;
                app.update_requested = true;
                app.status = Some(format!(
                    "Updating to qd {}…",
                    app.available_update
                        .as_ref()
                        .map(|item| item.version.as_str())
                        .unwrap_or_default()
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn apply_network_event(app: &mut App<'_>, event: NetEvent) -> bool {
    match event {
        NetEvent::State(state) => {
            app.connection = state;
            if state == ConnectionState::Reconnecting {
                app.edit_saving = false;
            }
        }
        NetEvent::Snapshot(drops) => {
            app.edit_saving = false;
            app.replace_drops(drops);
        }
        NetEvent::Added(drop, local) => app.add_drop(drop, local),
        NetEvent::Updated(drop, local) => app.update_drop(drop, local),
        NetEvent::Deleted(id) => {
            app.remove_drop(&id);
            app.status = Some("Deleted".to_owned());
        }
        NetEvent::Removed(ids) => {
            for id in ids {
                app.remove_drop(&id);
            }
        }
        NetEvent::Cleared => {
            app.drops.clear();
            app.selected = 0;
            app.status = Some("Cleared".to_owned());
        }
        NetEvent::PublishFailed(contents) => {
            app.restore_composer(contents);
            app.status = Some("Unconfirmed text was restored to the composer".to_owned());
        }
        NetEvent::Error { code, message } => {
            app.edit_saving = false;
            app.status = Some(message);
            if code.as_deref().is_some_and(remote_error_requires_pin) {
                app.screen = Screen::Pin;
                app.pin_purpose = PinPurpose::Unlock;
                app.pin_input.clear();
                app.connection = ConnectionState::Connecting;
                return true;
            }
        }
    }
    false
}

fn apply_update_event(app: &mut App<'_>, event: Option<UpdateEvent>) {
    match event {
        Some(UpdateEvent::Check(Ok(Some(available)))) => {
            app.available_update = Some(available);
            if app.status.is_none() {
                if let Some(update) = &app.available_update {
                    app.status = Some(format!(
                        "qd {} available · press u to update",
                        update.version
                    ));
                }
            }
        }
        Some(UpdateEvent::Check(Ok(None))) | None => {}
        Some(UpdateEvent::Check(Err(error))) => {
            if app.status.is_none() {
                app.status = Some(error_message(error));
            }
        }
        Some(UpdateEvent::Applied(Ok(_))) => {
            app.restart_after_update = true;
            app.quit = true;
        }
        Some(UpdateEvent::Applied(Err(error))) => {
            app.update_busy = false;
            app.status = Some(error_message(error));
        }
    }
}

async fn realtime_client(
    server: Url,
    code: String,
    access_cookie: Option<String>,
    mut actions: mpsc::Receiver<Action>,
    events: mpsc::Sender<NetEvent>,
) {
    let mut first_attempt = true;
    loop {
        let state = if first_attempt {
            ConnectionState::Connecting
        } else {
            ConnectionState::Reconnecting
        };
        first_attempt = false;
        if events.send(NetEvent::State(state)).await.is_err() {
            return;
        }
        let Ok(mut url) = endpoint(&server, &format!("api/text/{code}/ws")) else {
            return;
        };
        let _ = url.set_scheme(if server.scheme() == "https" {
            "wss"
        } else {
            "ws"
        });
        let Ok(mut request) = url.as_str().into_client_request() else {
            return;
        };
        if let Some(cookie) = access_cookie.as_deref() {
            let Ok(cookie) = HeaderValue::from_str(cookie) else {
                let _ = events
                    .send(NetEvent::Error {
                        code: None,
                        message: "The room access cookie is invalid".to_owned(),
                    })
                    .await;
                return;
            };
            request.headers_mut().insert(COOKIE, cookie);
        }
        let Ok((mut socket, _)) = connect_async(request).await else {
            sleep(Duration::from_secs(2)).await;
            continue;
        };
        if events
            .send(NetEvent::State(ConnectionState::Connected))
            .await
            .is_err()
        {
            return;
        }

        let mut client_id = None;
        let mut pending_publishes = VecDeque::new();
        let mut confirmation_tick = interval(Duration::from_secs(1));
        confirmation_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                action = actions.recv() => match action {
                    Some(Action::Publish(content)) => {
                        let message = Message::Text(
                            json!({ "type": "drop_add", "content": content }).to_string().into(),
                        );
                        if socket.send(message).await.is_err() {
                            let mut unresolved = pending_publishes
                                .drain(..)
                                .map(|(content, _)| content)
                                .collect::<Vec<_>>();
                            unresolved.push(content);
                            if events.send(NetEvent::PublishFailed(unresolved)).await.is_err() {
                                return;
                            }
                            break;
                        }
                        pending_publishes.push_back((content, Instant::now()));
                    }
                    Some(Action::Update(drop_id, content)) => {
                        let message = Message::Text(
                            json!({
                                "type": "drop_update",
                                "dropId": drop_id,
                                "content": content,
                            })
                            .to_string()
                            .into(),
                        );
                        if socket.send(message).await.is_err() {
                            if events
                                .send(NetEvent::Error {
                                    code: None,
                                    message: "Edit was not sent; reconnecting".to_owned(),
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            break;
                        }
                    }
                    Some(Action::Delete(drop_id)) => {
                        let message = Message::Text(
                            json!({ "type": "drop_delete", "dropId": drop_id }).to_string().into(),
                        );
                        if socket.send(message).await.is_err() {
                            if events
                                .send(NetEvent::Error {
                                    code: None,
                                    message: "Delete was not sent; reconnecting".to_owned(),
                                })
                                .await
                                .is_err()
                            {
                                return;
                            }
                            break;
                        }
                    }
                    None => return,
                },
                message = socket.next() => match message {
                    Some(Ok(Message::Text(text))) => {
                        if let Some(event) = parse_server_event(&text, &mut client_id) {
                            let auth_failed = matches!(
                                &event,
                                NetEvent::Error { code: Some(code), .. }
                                    if remote_error_requires_pin(code)
                            );
                            if matches!(event, NetEvent::Added(_, true)) {
                                pending_publishes.pop_front();
                            } else if matches!(event, NetEvent::Error { .. })
                                && !pending_publishes.is_empty()
                            {
                                let unresolved = pending_publishes
                                    .drain(..)
                                    .map(|(content, _)| content)
                                    .collect();
                                if events.send(NetEvent::PublishFailed(unresolved)).await.is_err() {
                                    return;
                                }
                            }
                            if events.send(event).await.is_err() {
                                return;
                            }
                            if auth_failed {
                                return;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                },
                _ = confirmation_tick.tick(), if !pending_publishes.is_empty() => {
                    let timed_out = pending_publishes
                        .front()
                        .is_some_and(|(_, sent_at)| sent_at.elapsed() >= Duration::from_secs(15));
                    if timed_out {
                        let unresolved = pending_publishes
                            .drain(..)
                            .map(|(content, _)| content)
                            .collect();
                        if events.send(NetEvent::PublishFailed(unresolved)).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
        if !pending_publishes.is_empty() {
            let unresolved = pending_publishes
                .drain(..)
                .map(|(content, _)| content)
                .collect();
            if events
                .send(NetEvent::PublishFailed(unresolved))
                .await
                .is_err()
            {
                return;
            }
        }
        sleep(Duration::from_secs(2)).await;
    }
}

fn parse_server_event(text: &str, client_id: &mut Option<String>) -> Option<NetEvent> {
    let payload: Value = serde_json::from_str(text).ok()?;
    match payload.get("type")?.as_str()? {
        "snapshot" => {
            *client_id = payload
                .get("clientId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            serde_json::from_value(payload.get("drops")?.clone())
                .ok()
                .map(NetEvent::Snapshot)
        }
        "drop_added" => {
            let local = client_id.as_deref() == payload.get("by").and_then(Value::as_str);
            serde_json::from_value(payload.get("drop")?.clone())
                .ok()
                .map(|drop| NetEvent::Added(drop, local))
        }
        "drop_updated" => {
            let local = client_id.as_deref() == payload.get("by").and_then(Value::as_str);
            serde_json::from_value(payload.get("drop")?.clone())
                .ok()
                .map(|drop| NetEvent::Updated(drop, local))
        }
        "drop_deleted" => payload
            .get("dropId")?
            .as_str()
            .map(|id| NetEvent::Deleted(id.to_owned())),
        "drops_removed" => serde_json::from_value(payload.get("dropIds")?.clone())
            .ok()
            .map(NetEvent::Removed),
        "drops_cleared" => Some(NetEvent::Cleared),
        "error" => Some(NetEvent::Error {
            code: payload
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
            message: payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The server rejected the action")
                .to_owned(),
        }),
        _ => None,
    }
}

fn remote_error_requires_pin(code: &str) -> bool {
    matches!(code, "pin_required" | "pin_invalid" | "invalid_token")
}

fn sort_drops(drops: &mut [TextDrop]) {
    drops.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.id.cmp(&left.id))
    });
}
fn normalize_code(code: &str) -> Result<String, String> {
    if code.is_empty() || code.len() > 16 || !code.chars().all(valid_code_char) {
        Err("Use 1–16 letters, numbers, hyphens, or underscores".to_owned())
    } else {
        Ok(code.to_ascii_uppercase())
    }
}
fn valid_code_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_' || character == '-'
}

fn render(frame: &mut Frame<'_>, app: &mut App<'_>) {
    match app.screen {
        Screen::Code => render_code(frame, app),
        Screen::Pin => render_pin(frame, app),
        _ => render_timeline(frame, app),
    }
    match app.screen {
        Screen::Help => render_help(frame, app),
        Screen::ConfirmDelete => render_confirmation(frame, app),
        _ => {}
    }
}

fn render_code(frame: &mut Frame<'_>, app: &App<'_>) {
    let area = centered_rect(52, 9, frame.area());
    frame.render_widget(Clear, area);
    let creating_protected = app.pin_purpose == PinPurpose::Create;
    let block = Block::default()
        .title(if creating_protected {
            " Create a protected clipboard "
        } else {
            " Open a clipboard "
        })
        .borders(Borders::ALL)
        .border_style(Style::default().fg(app.color(Color::Cyan)));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(3),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(inner);
    frame.render_widget(Paragraph::new("Code"), rows[0]);
    frame.render_widget(
        Paragraph::new(format!("> {}_", app.code_input))
            .block(Block::default().borders(Borders::ALL)),
        rows[1],
    );
    frame.render_widget(
        Paragraph::new(app.status.as_deref().unwrap_or(if creating_protected {
            "Enter set PIN · Ctrl+P cancel protected create · Esc quit"
        } else {
            "Enter open/public create · Ctrl+P create with PIN · Esc quit"
        }))
        .style(Style::default().fg(if app.status.is_some() {
            app.color(Color::Red)
        } else {
            Color::Reset
        })),
        rows[3],
    );
}

fn render_pin(frame: &mut Frame<'_>, app: &App<'_>) {
    let area = centered_rect(52, 9, frame.area());
    frame.render_widget(Clear, area);
    let title = match app.pin_purpose {
        PinPurpose::Unlock => format!(" Unlock {} ", app.code),
        PinPurpose::Create => format!(" Create protected {} ", app.code),
    };
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(app.color(Color::Cyan)));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(3),
            Constraint::Length(1),
            Constraint::Length(1),
        ])
        .split(inner);
    frame.render_widget(Paragraph::new("PIN"), rows[0]);
    let masked = "•".repeat(app.pin_input.chars().count());
    frame.render_widget(
        Paragraph::new(format!("> {masked}_")).block(Block::default().borders(Borders::ALL)),
        rows[1],
    );
    frame.render_widget(
        Paragraph::new(app.status.as_deref().unwrap_or(match app.pin_purpose {
            PinPurpose::Unlock => "Enter unlock · Esc back",
            PinPurpose::Create => "Enter create protected clipboard · Esc back",
        }))
        .style(Style::default().fg(if app.status.is_some() {
            app.color(Color::Red)
        } else {
            Color::Reset
        })),
        rows[3],
    );
}

fn render_timeline(frame: &mut Frame<'_>, app: &mut App<'_>) {
    let compact = frame.area().width < 70 || frame.area().height < 20;
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(if compact { 4 } else { 6 }),
            Constraint::Length(1),
        ])
        .split(frame.area());
    let (connection_label, connection_color) = match app.connection {
        ConnectionState::Connected => ("● Connected", app.color(Color::Green)),
        ConnectionState::Connecting => ("◌ Connecting", app.color(Color::Yellow)),
        ConnectionState::Reconnecting => ("◌ Reconnecting", app.color(Color::Yellow)),
    };
    let title = if compact {
        format!(" QuickDrop · {}  ", app.code)
    } else {
        format!(" QuickDrop · {} · {}  ", app.code, app.server)
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(title, Style::default().add_modifier(Modifier::BOLD)),
            Span::styled(connection_label, Style::default().fg(connection_color)),
        ]))
        .block(Block::default().borders(Borders::ALL)),
        rows[0],
    );
    let items: Vec<ListItem<'_>> = app
        .drops
        .iter()
        .map(|drop| {
            let content = if compact {
                truncate(
                    &drop.content.replace('\n', " "),
                    rows[1].width.saturating_sub(8) as usize,
                )
            } else {
                drop.content.clone()
            };
            ListItem::new(Text::from(vec![
                Line::styled(
                    format!(
                        "{}  {}",
                        content_kind(&drop.content),
                        short_time(&drop.created_at)
                    ),
                    Style::default().add_modifier(Modifier::BOLD),
                ),
                Line::raw(content),
                Line::raw(""),
            ]))
        })
        .collect();
    let mut state =
        ListState::default().with_selected((!app.drops.is_empty()).then_some(app.selected));
    let timeline = List::new(items)
        .highlight_symbol("› ")
        .highlight_style(
            Style::default()
                .fg(app.color(Color::Cyan))
                .add_modifier(Modifier::BOLD),
        )
        .block(Block::default().title(" Timeline ").borders(Borders::ALL));
    frame.render_stateful_widget(timeline, rows[1], &mut state);
    let composer_title = if app.editing_drop_id.is_some() {
        " Edit drop "
    } else {
        " New drop "
    };
    app.composer.set_block(
        Block::default()
            .title(composer_title)
            .borders(Borders::ALL)
            .border_style(Style::default().fg(if app.focus == Focus::Composer {
                app.color(Color::Cyan)
            } else {
                Color::Reset
            })),
    );
    frame.render_widget(&app.composer, rows[2]);
    let default_footer = if app.focus == Focus::Composer {
        if app.editing_drop_id.is_some() {
            "Ctrl+S/Ctrl+Enter save · Esc cancel · Ctrl+U clear".to_owned()
        } else {
            "Ctrl+S/Ctrl+Enter send · Esc timeline · Ctrl+U clear".to_owned()
        }
    } else if let Some(update) = &app.available_update {
        format!(
            "u update to {} · e edit selected · Enter compose · y copy · r resend · d delete · ? help · q quit",
            update.version
        )
    } else {
        "e edit selected · Enter compose · y copy · r resend · d delete · ? help · q quit"
            .to_owned()
    };
    let footer = app.status.as_deref().unwrap_or(default_footer.as_str());
    frame.render_widget(Paragraph::new(footer).alignment(Alignment::Center), rows[3]);
}

fn render_help(frame: &mut Frame<'_>, app: &App<'_>) {
    let area = centered_rect(58, 18, frame.area());
    frame.render_widget(Clear, area);
    let help = "Navigation\n  j/↓, k/↑       Select a drop\n  g/Home, G/End   First or last drop\n  Enter/i/Tab     Edit composer\n\nActions\n  e edit selected · y copy · r resend · d delete · u update qd\n\nComposer / editor\n  Ctrl+S/Ctrl+Enter send or save · Ctrl+U clear · Esc cancel\n\n? or Esc close · q quit";
    frame.render_widget(
        Paragraph::new(help).wrap(Wrap { trim: false }).block(
            Block::default()
                .title(" Help ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(app.color(Color::Cyan))),
        ),
        area,
    );
}

fn render_confirmation(frame: &mut Frame<'_>, app: &App<'_>) {
    let area = centered_rect(48, 7, frame.area());
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new(
            "Delete the selected drop for every connected device?\n\nEnter/y delete · n/Esc cancel",
        )
        .alignment(Alignment::Center)
        .wrap(Wrap { trim: true })
        .block(
            Block::default()
                .title(" Confirm delete ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(app.color(Color::Red))),
        ),
        area,
    );
}

fn centered_rect(width: u16, height: u16, area: Rect) -> Rect {
    let width = width.min(area.width.saturating_sub(2));
    let height = height.min(area.height.saturating_sub(2));
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}
fn content_kind(content: &str) -> &'static str {
    let text = content.trim();
    if (text.starts_with('{') || text.starts_with('['))
        && serde_json::from_str::<Value>(text).is_ok()
    {
        "JSON"
    } else if text.starts_with("http://") || text.starts_with("https://") {
        "URL"
    } else if text.starts_with('$')
        || text.starts_with("sudo ")
        || text.starts_with("docker ")
        || text.starts_with("git ")
    {
        "Command"
    } else {
        "Text"
    }
}
fn short_time(timestamp: &str) -> &str {
    timestamp.get(11..16).unwrap_or(timestamp)
}
fn truncate(content: &str, width: usize) -> String {
    if content.chars().count() <= width {
        content.to_owned()
    } else {
        content
            .chars()
            .take(width.saturating_sub(1))
            .chain(std::iter::once('…'))
            .collect()
    }
}

struct TerminalGuard {
    terminal: Terminal<CrosstermBackend<io::Stdout>>,
    keyboard_enhancement_enabled: bool,
}
impl TerminalGuard {
    fn enter() -> Result<Self, QdError> {
        enable_raw_mode().map_err(terminal_error)?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(terminal_error(error));
        }
        let keyboard_enhancement_enabled = match execute!(
            stdout,
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES),
        ) {
            Ok(()) => true,
            Err(error) if keyboard_enhancement_is_optional(&error) => false,
            Err(error) => {
                let _ = execute!(io::stdout(), LeaveAlternateScreen);
                let _ = disable_raw_mode();
                return Err(terminal_error(error));
            }
        };
        match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(terminal) => Ok(Self {
                terminal,
                keyboard_enhancement_enabled,
            }),
            Err(error) => {
                if keyboard_enhancement_enabled {
                    let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
                }
                let _ = execute!(io::stdout(), LeaveAlternateScreen);
                let _ = disable_raw_mode();
                Err(terminal_error(error))
            }
        }
    }
    fn draw<F>(&mut self, render: F) -> io::Result<ratatui::CompletedFrame<'_>>
    where
        F: FnOnce(&mut Frame<'_>),
    {
        self.terminal.draw(render)
    }
}
impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if self.keyboard_enhancement_enabled {
            let _ = execute!(self.terminal.backend_mut(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = disable_raw_mode();
        let _ = self.terminal.show_cursor();
    }
}

fn keyboard_enhancement_is_optional(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported
}
fn terminal_error(error: io::Error) -> QdError {
    QdError::Runtime(format!("terminal error: {error}"))
}
fn channel_error<T>(_: mpsc::error::SendError<T>) -> QdError {
    QdError::Runtime("the realtime connection stopped unexpectedly".to_owned())
}
fn error_message(error: QdError) -> String {
    match error {
        QdError::Runtime(message) | QdError::Usage(message) | QdError::Remote { message, .. } => {
            message
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};
    fn drop(id: &str, content: &str, created_at: &str) -> TextDrop {
        TextDrop {
            id: id.to_owned(),
            content: content.to_owned(),
            created_at: created_at.to_owned(),
        }
    }
    #[test]
    fn normalizes_valid_codes_and_rejects_invalid_ones() {
        assert_eq!(normalize_code("dev_1").unwrap(), "DEV_1");
        assert!(normalize_code("bad code").is_err());
        assert!(normalize_code("abcdefghijklmnopq").is_err());
    }
    #[test]
    fn keeps_newest_drops_first_and_selection_valid() {
        let server = Url::parse("https://quickdrop.example").unwrap();

        let mut app = App::new(server, Some("DEV".to_owned()));
        app.replace_drops(vec![
            drop("old", "old", "2026-01-01T10:00:00Z"),
            drop("new", "new", "2026-01-01T11:00:00Z"),
        ]);
        assert_eq!(app.drops[0].content, "new");
        app.selected = 1;
        app.remove_drop("old");
        assert_eq!(app.selected, 0);
    }
    #[test]
    fn unsupported_keyboard_enhancement_keeps_terminal_available() {
        let unsupported = io::Error::new(io::ErrorKind::Unsupported, "not supported");
        let denied = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert!(keyboard_enhancement_is_optional(&unsupported));
        assert!(!keyboard_enhancement_is_optional(&denied));
    }
    #[test]
    fn parses_realtime_drop_events() {
        let mut client_id = Some("local-client".to_owned());
        let event = parse_server_event(
            r#"{"type":"drop_added","by":"remote-client","drop":{"id":"1","content":"hello","createdAt":"2026-01-01T11:00:00Z"}}"#,
            &mut client_id,
        )
        .unwrap();
        let NetEvent::Added(drop, false) = event else {
            panic!("expected remote added event")
        };
        assert_eq!(drop.content, "hello");
        let event = parse_server_event(
            r#"{"type":"drop_updated","by":"local-client","drop":{"id":"1","content":"edited","createdAt":"2026-01-01T11:00:00Z"}}"#,
            &mut client_id,
        )
        .unwrap();
        let NetEvent::Updated(drop, true) = event else {
            panic!("expected local updated event")
        };
        assert_eq!(drop.content, "edited");
    }

    #[test]
    fn expired_access_returns_to_pin_and_reconnect_releases_the_editor() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("SECRET".to_owned()));
        app.screen = Screen::Timeline;
        app.editing_drop_id = Some("drop-1".to_owned());
        app.edit_saving = true;

        assert!(!apply_network_event(
            &mut app,
            NetEvent::State(ConnectionState::Reconnecting),
        ));
        assert!(!app.edit_saving);

        let mut client_id = Some("local-client".to_owned());
        let event = parse_server_event(
            r#"{"type":"error","error":"invalid_token","message":"Access expired"}"#,
            &mut client_id,
        )
        .unwrap();
        assert!(apply_network_event(&mut app, event));
        assert_eq!(app.screen, Screen::Pin);
        assert!(app.pin_input.is_empty());
        assert_eq!(app.status.as_deref(), Some("Access expired"));
    }

    #[test]
    fn remote_additions_preserve_selection_and_clear_events_empty_the_timeline() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()));
        app.replace_drops(vec![
            drop("selected", "selected", "2026-01-01T10:00:00Z"),
            drop("older", "older", "2026-01-01T09:00:00Z"),
        ]);
        app.selected = 0;
        app.add_drop(drop("remote", "remote", "2026-01-01T11:00:00Z"), false);
        assert_eq!(
            app.selected_drop().map(|drop| drop.id.as_str()),
            Some("selected")
        );
        assert!(app.status.is_none());
        app.replace_drops(vec![
            drop("newest", "newest", "2026-01-01T12:00:00Z"),
            drop("selected", "selected", "2026-01-01T10:00:00Z"),
            drop("older", "older", "2026-01-01T09:00:00Z"),
        ]);
        assert_eq!(
            app.selected_drop().map(|drop| drop.id.as_str()),
            Some("selected")
        );

        apply_network_event(&mut app, NetEvent::Cleared);
        assert!(app.drops.is_empty());
        assert_eq!(app.selected, 0);
    }
    #[tokio::test]
    async fn ctrl_s_publishes_and_clears_the_composer() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()));
        app.screen = Screen::Timeline;
        app.focus = Focus::Composer;
        app.connection = ConnectionState::Connected;
        app.composer.insert_str("hello");
        let (actions, mut received) = mpsc::channel(1);

        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL),
            Some(&actions),
        )
        .await
        .unwrap();

        let Some(Action::Publish(content)) = received.recv().await else {
            panic!("expected publish action")
        };
        assert_eq!(content, "hello");
        assert!(app.composer_content().is_empty());
        assert_eq!(app.focus, Focus::Timeline);
    }

    #[tokio::test]
    async fn ctrl_enter_publishes_and_clears_the_composer() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()));
        app.screen = Screen::Timeline;
        app.focus = Focus::Composer;
        app.connection = ConnectionState::Connected;
        app.composer.insert_str("hello with ctrl enter");
        let (actions, mut received) = mpsc::channel(1);

        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL),
            Some(&actions),
        )
        .await
        .unwrap();

        let Some(Action::Publish(content)) = received.recv().await else {
            panic!("expected publish action")
        };
        assert_eq!(content, "hello with ctrl enter");
        assert!(app.composer_content().is_empty());
        assert_eq!(app.focus, Focus::Timeline);
    }

    #[tokio::test]
    async fn e_edits_the_selected_drop_and_restores_the_composer_draft() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()));
        app.screen = Screen::Timeline;
        app.connection = ConnectionState::Connected;

        app.composer.insert_str("existing draft");
        app.replace_drops(vec![drop("selected", "original", "2026-01-01T11:00:00Z")]);
        let (actions, mut received) = mpsc::channel(1);

        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('e'), KeyModifiers::NONE),
            Some(&actions),
        )
        .await
        .unwrap();
        assert_eq!(app.editing_drop_id.as_deref(), Some("selected"));
        assert_eq!(app.composer_content(), "original");

        app.composer = TextArea::default();
        app.composer.insert_str("edited");
        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL),
            Some(&actions),
        )
        .await
        .unwrap();
        let Some(Action::Update(drop_id, content)) = received.recv().await else {
            panic!("expected update action")
        };
        assert_eq!(drop_id, "selected");
        assert_eq!(content, "edited");
        assert!(app.edit_saving);

        apply_network_event(
            &mut app,
            NetEvent::Updated(drop("selected", "edited", "2026-01-01T11:00:00Z"), true),
        );
        assert_eq!(
            app.selected_drop().map(|drop| drop.content.as_str()),
            Some("edited")
        );
        assert_eq!(app.composer_content(), "existing draft");
        assert!(app.editing_drop_id.is_none());
        assert_eq!(app.focus, Focus::Timeline);
    }
    #[tokio::test]
    async fn ctrl_p_with_empty_code_enters_protected_create_then_asks_for_pin() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, None);

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Code);
        assert_eq!(app.pin_purpose, PinPurpose::Create);
        assert_eq!(
            app.status.as_deref(),
            Some("Choose a code, then Enter to set the PIN")
        );

        for character in "teste".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE),
                None,
            )
            .await
            .unwrap();
        }
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Pin);
        assert_eq!(app.pin_purpose, PinPurpose::Create);
        assert_eq!(app.code, "TESTE");
    }

    #[tokio::test]
    async fn ctrl_p_requests_a_pin_before_creating_a_protected_room() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, None);
        for character in "secure".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE),
                None,
            )
            .await
            .unwrap();
        }

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Pin);
        assert_eq!(app.pin_purpose, PinPurpose::Create);
        assert_eq!(app.code, "SECURE");

        for character in "1234".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE),
                None,
            )
            .await
            .unwrap();
        }
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Timeline);
        assert_eq!(app.pin_purpose, PinPurpose::Create);
        assert_eq!(app.pin_input, "1234");
        app.screen = Screen::Code;
        app.pin_purpose = PinPurpose::Unlock;
        app.code_input = "PUBLIC".to_owned();
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Timeline);
        assert_eq!(app.pin_purpose, PinPurpose::Unlock);
    }

    #[tokio::test]
    async fn pin_prompt_accepts_a_valid_pin_and_returns_to_the_code_screen() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("SECRET".to_owned()));
        app.screen = Screen::Pin;
        for character in "1234".chars() {
            handle_key(
                &mut app,
                KeyEvent::new(KeyCode::Char(character), KeyModifiers::NONE),
                None,
            )
            .await
            .unwrap();
        }
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Timeline);
        assert_eq!(app.pin_input, "1234");

        app.screen = Screen::Pin;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Code);
        assert_eq!(app.code_input, "SECRET");
        assert!(app.pin_input.is_empty());
    }

    #[tokio::test]
    async fn u_requests_an_available_qd_update() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()));
        app.screen = Screen::Timeline;
        apply_update_event(
            &mut app,
            Some(UpdateEvent::Check(Ok(Some(update::AvailableUpdate {
                version: "9.9.9".to_owned(),
                checksum: "aa".repeat(32),
            })))),
        );
        assert!(app
            .status
            .as_deref()
            .is_some_and(|status| status.contains("press u to update")));

        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('u'), KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert!(app.update_requested);
        assert!(app.update_busy);
        assert_eq!(app.status.as_deref(), Some("Updating to qd 9.9.9…"));
    }

    #[tokio::test]
    async fn q_quits_from_help_and_failed_publish_restores_the_composer() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()));
        app.screen = Screen::Help;
        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('q'), KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert!(app.quit);

        apply_network_event(
            &mut app,
            NetEvent::PublishFailed(vec!["first unsent".to_owned(), "second unsent".to_owned()]),
        );
        assert_eq!(app.composer_content(), "first unsent\n\nsecond unsent");
        assert_eq!(app.focus, Focus::Composer);
        assert!(app
            .status
            .as_deref()
            .is_some_and(|status| status.contains("restored")));
    }

    #[test]
    fn renders_regular_and_compact_timelines() {
        for (width, height) in [(100, 30), (60, 16)] {
            let backend = TestBackend::new(width, height);
            let mut terminal = Terminal::new(backend).unwrap();
            let server = Url::parse("https://quickdrop.example").unwrap();
            let mut app = App::new(server, Some("DEV".to_owned()));
            app.connection = ConnectionState::Connected;
            app.replace_drops(vec![drop(
                "1",
                "hello from QuickDrop",
                "2026-01-01T11:00:00Z",
            )]);
            terminal.draw(|frame| render(frame, &mut app)).unwrap();
            let rendered: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(rendered.contains("QuickDrop"));
            assert!(rendered.contains("hello from QuickDrop"));
        }
    }
}
