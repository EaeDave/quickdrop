use std::{
    collections::{HashMap, VecDeque},
    env, io,
    time::Duration,
};

use chrono::{DateTime, Local};
use crossterm::{
    event::{
        DisableMouseCapture, EnableMouseCapture, Event, EventStream, KeyCode, KeyEvent,
        KeyEventKind, KeyModifiers, KeyboardEnhancementFlags, MouseButton, MouseEvent,
        MouseEventKind, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
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
    copy_to_system_clipboard, endpoint, http_client, open_in_browser, open_room, update, QdError,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DropOrigin {
    Unknown,
    Self_,
    Remote,
}

const NEW_MARKER_DURATION: Duration = Duration::from_secs(8);
const STATUS_FEEDBACK_DURATION: Duration = Duration::from_secs(4);
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
    Lifecycle {
        idle_ttl_minutes: u64,
        expires_at: Option<String>,
        presence: u64,
    },
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MouseAction {
    Submit,
    Newline,
    Clear,
    Cancel,
    Edit,
    Copy,
    Resend,
    Delete,
    Update,
    SwitchRoom,
    OpenRoom,
    Help,
    Quit,
    ConfirmDelete,
    Close,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HoverTarget {
    Action(MouseAction),
    TimelineItem(usize),
    Composer,
}

#[derive(Debug, Clone, Copy)]
struct ActionRegion {
    area: Rect,
    action: MouseAction,
}

#[derive(Debug, Clone, Copy)]
struct TimelineItemRegion {
    area: Rect,
    index: usize,
}

#[derive(Debug, Default)]
struct UiRegions {
    timeline: Rect,
    composer: Rect,
    timeline_items: Vec<TimelineItemRegion>,
    actions: Vec<ActionRegion>,
}
pub async fn run_tui(
    server: Url,
    initial_code: Option<String>,
    initial_pin: Option<String>,
) -> Result<bool, QdError> {
    let mut terminal = TerminalGuard::enter()?;
    let mut events = EventStream::new();
    let mut app = App::new(server, initial_code, initial_pin);
    let mut connection = None;
    let (update_tx, mut update_rx) = mpsc::channel(2);
    let mut expiry_tick = interval(Duration::from_secs(1));
    expiry_tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
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
        app.expire_new_marker(Instant::now());
        app.expire_status_feedback(Instant::now());
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
            return Ok(app.restart_after_update);
        }
        if app.switch_room_requested {
            app.switch_room_requested = false;
            connection = None;
        }

        if app.screen == Screen::Timeline && connection.is_none() {
            let pin = (!app.pin_input.trim().is_empty()).then(|| app.pin_input.trim().to_owned());
            let room = match http_client() {
                Ok(client) => open_room(&client, &app.server, &app.code, pin.as_deref()).await,
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
                    app.pin_purpose = PinPurpose::Unlock;
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
            if app.pin_purpose == PinPurpose::Create && !room.protected {
                app.screen = Screen::Code;
                app.code_input = app.code.clone();
                app.status = Some("This room already exists without a PIN".to_owned());
                app.code.clear();
                app.pin_input.clear();
                continue;
            }
            app.status = Some(open_feedback(room.created, room.protected).to_owned());
            app.status_expires_at = Some(Instant::now() + STATUS_FEEDBACK_DURATION);
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
                        Some(Ok(Event::Key(key))) => {
                            handle_key(&mut app, key, Some(actions)).await?
                        }
                        Some(Ok(Event::Mouse(mouse))) => {
                            handle_mouse(&mut app, mouse, Some(actions)).await?
                        }
                        Some(Ok(_)) => {}
                        Some(Err(error)) => return Err(terminal_error(error)),
                        None => return Ok(false),
                    }
                    false
                },
                update_event = update_rx.recv() => {
                    apply_update_event(&mut app, update_event);
                    false
                },
                _ = expiry_tick.tick() => false,
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
                    Some(Ok(Event::Mouse(mouse))) => handle_mouse(&mut app, mouse, None).await?,
                    Some(Ok(_)) => {}
                    Some(Err(error)) => return Err(terminal_error(error)),
                    None => return Ok(false),
                },
                update_event = update_rx.recv() => apply_update_event(&mut app, update_event),
                _ = expiry_tick.tick() => {}
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
    drop_origins: HashMap<String, DropOrigin>,
    latest_remote_id: Option<String>,
    new_remote_marker: Option<(String, Instant)>,
    selected: usize,
    composer: TextArea<'a>,
    composer_draft_before_edit: Option<String>,
    editing_drop_id: Option<String>,
    edit_saving: bool,
    connection: ConnectionState,
    status: Option<String>,
    status_expires_at: Option<Instant>,
    idle_ttl_minutes: Option<u64>,
    room_expires_at: Option<String>,
    presence: u64,
    available_update: Option<update::AvailableUpdate>,
    update_checked: bool,
    update_check_error: Option<String>,
    update_busy: bool,
    update_requested: bool,
    switch_room_requested: bool,
    restart_after_update: bool,
    ui: UiRegions,
    hover: Option<HoverTarget>,
    no_color: bool,
    server: Url,
    quit: bool,
}

impl<'a> App<'a> {
    fn new(server: Url, code: Option<String>, pin: Option<String>) -> Self {
        let mut composer = TextArea::default();
        composer.set_placeholder_text("Write or paste a new drop…");
        composer.set_cursor_line_style(Style::default());
        let direct_pin = pin.is_some();
        Self {
            screen: if code.is_some() {
                Screen::Timeline
            } else {
                Screen::Code
            },
            focus: Focus::Timeline,
            code_input: String::new(),
            pin_input: pin.unwrap_or_default(),
            pin_purpose: if direct_pin {
                PinPurpose::Create
            } else {
                PinPurpose::Unlock
            },
            code: code.unwrap_or_default(),
            drops: Vec::new(),
            drop_origins: HashMap::new(),
            latest_remote_id: None,
            new_remote_marker: None,
            selected: 0,
            composer,
            connection: ConnectionState::Connecting,
            composer_draft_before_edit: None,
            editing_drop_id: None,
            edit_saving: false,
            status: None,
            status_expires_at: None,
            idle_ttl_minutes: None,
            room_expires_at: None,
            presence: 0,
            available_update: None,
            update_checked: false,
            update_check_error: None,
            update_busy: false,
            update_requested: false,
            switch_room_requested: false,
            restart_after_update: false,
            hover: None,
            ui: UiRegions::default(),
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
    fn switch_room(&mut self) {
        self.screen = Screen::Code;
        self.focus = Focus::Timeline;
        self.code_input.clear();
        self.pin_input.clear();
        self.pin_purpose = PinPurpose::Unlock;
        self.code.clear();
        self.drops.clear();
        self.drop_origins.clear();
        self.latest_remote_id = None;
        self.new_remote_marker = None;
        self.selected = 0;
        self.clear_composer();
        self.composer_draft_before_edit = None;
        self.editing_drop_id = None;
        self.edit_saving = false;
        self.connection = ConnectionState::Connecting;
        self.status = None;
        self.status_expires_at = None;
        self.idle_ttl_minutes = None;
        self.room_expires_at = None;
        self.presence = 0;
        self.switch_room_requested = true;
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
        self.drop_origins
            .retain(|id, _| self.drops.iter().any(|drop| drop.id == *id));
        for drop in &self.drops {
            self.drop_origins
                .entry(drop.id.clone())
                .or_insert(DropOrigin::Unknown);
        }
        if self
            .new_remote_marker
            .as_ref()
            .is_some_and(|(id, _)| !self.drop_origins.contains_key(id))
        {
            self.new_remote_marker = None;
        }
        self.ensure_latest_remote();
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
            self.drop_origins
                .insert(added_id.clone(), DropOrigin::Self_);
            if self
                .new_remote_marker
                .as_ref()
                .is_some_and(|(id, _)| id == &added_id)
            {
                self.new_remote_marker = None;
            }
            self.selected = self
                .drops
                .iter()
                .position(|item| item.id == added_id)
                .unwrap_or_default();
            self.status = Some("Sent".to_owned());
        } else {
            self.drop_origins
                .insert(added_id.clone(), DropOrigin::Remote);
            self.new_remote_marker = Some((added_id, Instant::now() + NEW_MARKER_DURATION));
            self.status = Some("New drop received".to_owned());
            if let Some(selected_id) = selected_id {
                self.selected = self
                    .drops
                    .iter()
                    .position(|item| item.id == selected_id)
                    .unwrap_or_else(|| self.selected.min(self.drops.len().saturating_sub(1)));
            }
        }
        self.ensure_latest_remote();
    }
    fn remove_drop(&mut self, id: &str) {
        self.drops.retain(|drop| drop.id != id);
        self.drop_origins.remove(id);
        if self.latest_remote_id.as_deref() == Some(id) {
            self.latest_remote_id = None;
            self.ensure_latest_remote();
        }
        if self
            .new_remote_marker
            .as_ref()
            .is_some_and(|(marker_id, _)| marker_id == id)
        {
            self.new_remote_marker = None;
        }
        self.selected = self.selected.min(self.drops.len().saturating_sub(1));
    }
    fn ensure_latest_remote(&mut self) {
        self.latest_remote_id = self
            .drops
            .iter()
            .find(|drop| self.drop_origins.get(&drop.id) == Some(&DropOrigin::Remote))
            .map(|drop| drop.id.clone());
    }
    fn expire_new_marker(&mut self, now: Instant) {
        if self
            .new_remote_marker
            .as_ref()
            .is_some_and(|(_, expires_at)| now >= *expires_at)
        {
            self.new_remote_marker = None;
        }
    }
    fn expire_status_feedback(&mut self, now: Instant) {
        if self
            .status_expires_at
            .is_some_and(|expires_at| now >= expires_at)
        {
            if self.status.as_deref().is_some_and(is_open_feedback_message) {
                self.status = None;
            }
            self.status_expires_at = None;
        }
    }
    fn origin_label_at(&self, id: &str, now: Instant) -> &'static str {
        match self
            .drop_origins
            .get(id)
            .copied()
            .unwrap_or(DropOrigin::Unknown)
        {
            DropOrigin::Unknown => "",
            DropOrigin::Self_ => "YOU",
            DropOrigin::Remote
                if self
                    .new_remote_marker
                    .as_ref()
                    .is_some_and(|(marker_id, expires_at)| {
                        marker_id == id && now < *expires_at
                    }) =>
            {
                "REMOTE NEW"
            }
            DropOrigin::Remote => "REMOTE",
        }
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
        let drop_id = drop.id.clone();
        if let Some(existing) = self.drops.iter_mut().find(|item| item.id == drop.id) {
            *existing = drop;
            sort_drops(&mut self.drops);
            if local {
                self.drop_origins.insert(drop_id.clone(), DropOrigin::Self_);
                if self
                    .new_remote_marker
                    .as_ref()
                    .is_some_and(|(marker_id, _)| marker_id == &drop_id)
                {
                    self.new_remote_marker = None;
                }
            } else {
                self.drop_origins
                    .insert(drop_id.clone(), DropOrigin::Remote);
                self.new_remote_marker = Some((drop_id, Instant::now() + NEW_MARKER_DURATION));
            }
            self.ensure_latest_remote();
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
    let command_code = normalized_command_code(&key.code);
    if key.modifiers.contains(KeyModifiers::CONTROL) && command_code == KeyCode::Char('u') {
        app.status = None;
        request_update(app);
        return Ok(());
    }
    if key.modifiers.contains(KeyModifiers::CONTROL) && command_code == KeyCode::Char('o') {
        app.switch_room();
        return Ok(());
    }
    if app.screen == Screen::Timeline {
        app.status = None;
    }
    match app.screen {
        Screen::Code => {
            if key.modifiers.contains(KeyModifiers::CONTROL) && command_code == KeyCode::Char('p') {
                if app.pin_purpose == PinPurpose::Create && app.code_input.is_empty() {
                    app.pin_purpose = PinPurpose::Unlock;
                    app.status = None;
                } else {
                    app.submit_code(Some(PinPurpose::Create));
                }
            } else {
                match key.code {
                    KeyCode::Esc => app.quit = true,
                    KeyCode::Enter => app.submit_code(None),
                    KeyCode::Backspace => {
                        app.code_input.pop();
                    }
                    KeyCode::Char(character)
                        if app.code_input.len() < 16 && valid_code_char(character) =>
                    {
                        app.code_input.push(character.to_ascii_uppercase())
                    }
                    _ => {}
                }
            }
        }
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
        Screen::Help => match command_code {
            KeyCode::Char('q') => app.quit = true,
            KeyCode::Esc | KeyCode::Char('?') => app.screen = Screen::Timeline,
            _ => {}
        },
        Screen::ConfirmDelete => match command_code {
            KeyCode::Char('y') | KeyCode::Enter => confirm_delete(app, actions).await?,
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
    let command_code = normalized_command_code(&key.code);
    if app.focus == Focus::Composer {
        if key.code == KeyCode::Esc {
            cancel_composer(app);
        } else if key.code == KeyCode::Enter
            && key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::SHIFT)
        {
            if !app.edit_saving {
                app.composer.insert_newline();
            }
        } else if key.code == KeyCode::Enter {
            submit_composer(app, actions).await?;
        } else if !app.edit_saving {
            app.composer.input(key);
        }
        return Ok(());
    }
    if key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
    {
        return Ok(());
    }
    match command_code {
        KeyCode::Char('q') => app.quit = true,
        KeyCode::Char('?') => app.screen = Screen::Help,
        KeyCode::Char('j') | KeyCode::Down => app.select_next(),
        KeyCode::Char('k') | KeyCode::Up => app.selected = app.selected.saturating_sub(1),
        KeyCode::Char('g') | KeyCode::Home => app.selected = 0,
        KeyCode::End => app.selected = app.drops.len().saturating_sub(1),
        KeyCode::Enter | KeyCode::Char('i') | KeyCode::Tab => app.focus = Focus::Composer,
        KeyCode::Char('e') if app.selected_drop().is_some() => app.begin_edit(),
        KeyCode::Char('c') => copy_selected(app),
        KeyCode::Char('r') => resend_selected(app, actions).await?,
        KeyCode::Char('d') if app.selected_drop().is_some() => app.screen = Screen::ConfirmDelete,
        KeyCode::Char('u') => {}
        _ => {}
    }
    Ok(())
}

async fn handle_mouse(
    app: &mut App<'_>,
    mouse: MouseEvent,
    actions: Option<&mpsc::Sender<Action>>,
) -> Result<(), QdError> {
    update_hover(app, mouse.column, mouse.row);
    if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
        if let Some(action) = app
            .ui
            .actions
            .iter()
            .find(|region| point_in_rect(mouse.column, mouse.row, region.area))
            .map(|region| region.action)
        {
            return run_mouse_action(app, action, actions).await;
        }
    }
    if app.screen != Screen::Timeline {
        return Ok(());
    }
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            if point_in_rect(mouse.column, mouse.row, app.ui.composer) {
                app.focus = Focus::Composer;
                app.status = None;
            } else if let Some(index) = app
                .ui
                .timeline_items
                .iter()
                .find(|region| point_in_rect(mouse.column, mouse.row, region.area))
                .map(|region| region.index)
            {
                app.selected = index;
                app.focus = Focus::Timeline;
                app.status = None;
            }
        }
        MouseEventKind::ScrollDown => {
            if point_in_rect(mouse.column, mouse.row, app.ui.composer) {
                app.composer.input(mouse);
            } else if point_in_rect(mouse.column, mouse.row, app.ui.timeline) {
                app.select_next();
                app.focus = Focus::Timeline;
            }
        }
        MouseEventKind::ScrollUp => {
            if point_in_rect(mouse.column, mouse.row, app.ui.composer) {
                app.composer.input(mouse);
            } else if point_in_rect(mouse.column, mouse.row, app.ui.timeline) {
                app.selected = app.selected.saturating_sub(1);
                app.focus = Focus::Timeline;
            }
        }
        _ => {}
    }
    Ok(())
}

fn update_hover(app: &mut App<'_>, column: u16, row: u16) {
    if let Some(action) = app
        .ui
        .actions
        .iter()
        .find(|region| point_in_rect(column, row, region.area))
        .map(|region| region.action)
    {
        app.hover = Some(HoverTarget::Action(action));
        return;
    }
    if app.screen != Screen::Timeline {
        app.hover = None;
        return;
    }
    app.hover = app
        .ui
        .timeline_items
        .iter()
        .find(|region| point_in_rect(column, row, region.area))
        .map(|region| HoverTarget::TimelineItem(region.index))
        .or_else(|| point_in_rect(column, row, app.ui.composer).then_some(HoverTarget::Composer));
}

async fn run_mouse_action(
    app: &mut App<'_>,
    action: MouseAction,
    actions: Option<&mpsc::Sender<Action>>,
) -> Result<(), QdError> {
    app.status = None;
    match action {
        MouseAction::Submit => submit_composer(app, actions).await?,
        MouseAction::Newline => {
            if !app.edit_saving {
                app.composer.insert_newline();
            }
        }
        MouseAction::Clear => {
            app.clear_composer();
            app.status = Some("Composer cleared".to_owned());
        }
        MouseAction::Cancel => cancel_composer(app),
        MouseAction::Edit => app.begin_edit(),
        MouseAction::Copy => copy_selected(app),
        MouseAction::Resend => resend_selected(app, actions).await?,
        MouseAction::Delete => {
            if app.selected_drop().is_some() {
                app.screen = Screen::ConfirmDelete;
            }
        }
        MouseAction::Update => request_update(app),
        MouseAction::OpenRoom => open_room_link(app),
        MouseAction::SwitchRoom => app.switch_room(),
        MouseAction::Help => app.screen = Screen::Help,
        MouseAction::Quit => app.quit = true,
        MouseAction::ConfirmDelete => confirm_delete(app, actions).await?,
        MouseAction::Close => app.screen = Screen::Timeline,
    }
    Ok(())
}

async fn submit_composer(
    app: &mut App<'_>,
    actions: Option<&mpsc::Sender<Action>>,
) -> Result<(), QdError> {
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
    Ok(())
}

fn cancel_composer(app: &mut App<'_>) {
    if app.editing_drop_id.is_some() {
        app.finish_edit();
        app.status = Some("Edit cancelled".to_owned());
    } else {
        app.focus = Focus::Timeline;
        app.status = Some("Composer closed".to_owned());
    }
}

fn copy_selected(app: &mut App<'_>) {
    if let Some(content) = app.selected_drop().map(|drop| drop.content.clone()) {
        match copy_to_system_clipboard(&content) {
            Ok(()) => app.status = Some("Copied".to_owned()),
            Err(error) => app.status = Some(error_message(error)),
        }
    }
}

fn room_url(app: &App<'_>) -> Url {
    endpoint(&app.server, &app.code).expect("room URLs use an already validated server URL")
}

fn open_room_link(app: &mut App<'_>) {
    share_room_link(app, copy_to_system_clipboard, open_in_browser);
}

fn share_room_link<C, O>(app: &mut App<'_>, copy: C, open: O)
where
    C: FnOnce(&str) -> Result<(), QdError>,
    O: FnOnce(&Url) -> Result<(), QdError>,
{
    let url = room_url(app);
    let copied = copy(url.as_str());
    let opened = open(&url);
    app.status = Some(match (copied, opened) {
        (Ok(()), Ok(())) => "Room link copied and opened".to_owned(),
        (Err(copy_error), Ok(())) => {
            format!("Browser opened, but {}", error_message(copy_error))
        }
        (Ok(()), Err(open_error)) => {
            format!("Link copied, but {}", error_message(open_error))
        }
        (Err(copy_error), Err(open_error)) => format!(
            "{}; {}",
            error_message(copy_error),
            error_message(open_error)
        ),
    });
}
async fn resend_selected(
    app: &mut App<'_>,
    actions: Option<&mpsc::Sender<Action>>,
) -> Result<(), QdError> {
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
    Ok(())
}

fn request_update(app: &mut App<'_>) {
    if app.update_busy {
        app.status = Some("Updating qd…".to_owned());
    } else if let Some(update) = &app.available_update {
        app.update_busy = true;
        app.update_requested = true;
        app.status = Some(format!("Updating to qd {}…", update.version));
    } else if !app.update_checked {
        app.status = Some("Checking for qd updates…".to_owned());
    } else if let Some(error) = &app.update_check_error {
        app.status = Some(error.clone());
    } else {
        app.status = Some("qd is already up to date".to_owned());
    }
}

async fn confirm_delete(
    app: &mut App<'_>,
    actions: Option<&mpsc::Sender<Action>>,
) -> Result<(), QdError> {
    if app.connection != ConnectionState::Connected {
        app.status = Some("Wait for the connection before deleting".to_owned());
    } else if let (Some(sender), Some(drop_id)) =
        (actions, app.selected_drop().map(|drop| drop.id.clone()))
    {
        sender
            .send(Action::Delete(drop_id))
            .await
            .map_err(channel_error)?;
        app.status = Some("Deleting…".to_owned());
    }
    app.screen = Screen::Timeline;
    Ok(())
}

fn normalized_command_code(code: &KeyCode) -> KeyCode {
    match code {
        KeyCode::Char(character) => KeyCode::Char(character.to_ascii_lowercase()),
        _ => *code,
    }
}

fn point_in_rect(column: u16, row: u16, area: Rect) -> bool {
    column >= area.x
        && column < area.x.saturating_add(area.width)
        && row >= area.y
        && row < area.y.saturating_add(area.height)
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
            app.drop_origins.clear();
            app.latest_remote_id = None;
            app.new_remote_marker = None;
            app.selected = 0;
            app.status = Some("Cleared".to_owned());
        }
        NetEvent::Lifecycle {
            idle_ttl_minutes,
            expires_at,
            presence,
        } => {
            app.idle_ttl_minutes = Some(idle_ttl_minutes);
            app.room_expires_at = expires_at;
            app.presence = presence;
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
            app.update_checked = true;
            app.update_check_error = None;
            app.available_update = Some(available);
            if app.status.is_none() || app.status.as_deref() == Some("Checking for qd updates…") {
                if let Some(update) = &app.available_update {
                    app.status = Some(format!(
                        "qd {} available · press Ctrl+U to update",
                        update.version
                    ));
                }
            }
        }
        Some(UpdateEvent::Check(Ok(None))) => {
            app.update_checked = true;
            app.update_check_error = None;
            if app.status.as_deref() == Some("Checking for qd updates…") {
                app.status = Some("qd is already up to date".to_owned());
            }
        }
        Some(UpdateEvent::Check(Err(error))) => {
            app.update_checked = true;
            let message = error_message(error);
            app.update_check_error = Some(message.clone());
            if app.status.is_none() || app.status.as_deref() == Some("Checking for qd updates…") {
                app.status = Some(message);
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
        None => {}
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
                        if let Some(lifecycle) = parse_lifecycle_event(&text) {
                            if events.send(lifecycle).await.is_err() {
                                return;
                            }
                        }
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
            let local = client_id.as_deref().is_some_and(|client_id| {
                payload.get("by").and_then(Value::as_str) == Some(client_id)
            });
            serde_json::from_value(payload.get("drop")?.clone())
                .ok()
                .map(|drop| NetEvent::Added(drop, local))
        }
        "drop_updated" => {
            let local = client_id.as_deref().is_some_and(|client_id| {
                payload.get("by").and_then(Value::as_str) == Some(client_id)
            });
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

fn parse_lifecycle_event(text: &str) -> Option<NetEvent> {
    let payload: Value = serde_json::from_str(text).ok()?;
    match payload.get("type")?.as_str()? {
        "snapshot" | "lifecycle" => Some(NetEvent::Lifecycle {
            idle_ttl_minutes: payload.get("expiresAfterMinutes")?.as_u64()?,
            expires_at: match payload.get("expiresAt") {
                Some(Value::String(value)) => Some(value.clone()),
                Some(Value::Null) | None => None,
                _ => return None,
            },
            presence: payload.get("presence")?.as_u64()?,
        }),
        _ => None,
    }
}

fn format_room_expiry(
    idle_ttl_minutes: Option<u64>,
    expires_at: Option<&str>,
    presence: u64,
    compact: bool,
) -> Option<String> {
    let idle = idle_ttl_minutes?;
    if presence > 0 || expires_at.is_none() {
        return Some(if compact {
            "held".to_owned()
        } else {
            format!("held open · {idle}m idle")
        });
    }
    let expires_at = expires_at?;
    let remaining_ms = remaining_expiry_ms(expires_at)?;
    if remaining_ms == 0 {
        return Some("expiring".to_owned());
    }
    Some(if compact {
        format!("{} left", format_compact_remaining(remaining_ms))
    } else {
        format!("{} left", format_remaining_clock(remaining_ms))
    })
}

fn remaining_expiry_ms(expires_at: &str) -> Option<u64> {
    let expires = parse_rfc3339_unix_ms(expires_at)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(expires.saturating_sub(now))
}

fn parse_rfc3339_unix_ms(value: &str) -> Option<u64> {
    let value = value.trim().strip_suffix('Z')?;
    let (date, clock) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: u32 = date_parts.next()?.parse().ok()?;
    let day: u32 = date_parts.next()?.parse().ok()?;
    if !(1970..=2100).contains(&year) {
        return None;
    }
    let (hms, fraction) = clock
        .split_once('.')
        .map_or((clock, "0"), |(hours, rest)| (hours, rest));
    let mut time_parts = hms.split(':');
    let hour: u32 = time_parts.next()?.parse().ok()?;
    let minute: u32 = time_parts.next()?.parse().ok()?;
    let second: u32 = time_parts.next()?.parse().ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let millis: u32 = fraction.chars().take(3).collect::<String>().parse().ok()?;
    let days = days_from_civil(year, month, day)?;
    let seconds = i64::from(days)
        .checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3600)?
        .checked_add(i64::from(minute) * 60)?
        .checked_add(i64::from(second))?;
    u64::try_from(seconds)
        .ok()?
        .checked_mul(1000)?
        .checked_add(u64::from(millis))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i32> {
    const MONTH_DAYS: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if !(1..=12).contains(&month) {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let max_day = if month == 2 && leap {
        29
    } else {
        MONTH_DAYS[(month - 1) as usize]
    };
    if !(1..=max_day).contains(&day) {
        return None;
    }
    let year = if month <= 2 {
        year.checked_sub(1)?
    } else {
        year
    };
    let era = if year >= 0 {
        year
    } else {
        year.checked_sub(399)?
    } / 400;
    let year_of_era = year.checked_sub(era.checked_mul(400)?)?;
    let month_shift = i32::try_from(month).ok()? + if month > 2 { -3 } else { 9 };
    let day_of_year =
        month_shift.checked_mul(153)?.checked_add(2)? / 5 + i32::try_from(day).ok()? - 1;
    let day_of_era = year_of_era
        .checked_mul(365)?
        .checked_add(year_of_era / 4)?
        .checked_sub(year_of_era / 100)?
        .checked_add(day_of_year)?;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
}

fn format_remaining_clock(ms: u64) -> String {
    let total_seconds = ms.div_ceil(1000);
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

fn format_compact_remaining(ms: u64) -> String {
    let total_seconds = ms.div_ceil(1000);
    if total_seconds >= 3600 {
        format!("{}h", total_seconds / 3600)
    } else if total_seconds >= 60 {
        format!("{}m", total_seconds / 60)
    } else {
        format!("{total_seconds}s")
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
fn open_feedback(created: bool, protected: bool) -> &'static str {
    match (created, protected) {
        (true, false) => "Created a new room.",
        (true, true) => "Created a new PIN-protected room.",
        (false, false) => "Entered an existing room.",
        (false, true) => "Entered an existing PIN-protected room.",
    }
}
fn is_open_feedback_message(message: &str) -> bool {
    [
        open_feedback(true, false),
        open_feedback(true, true),
        open_feedback(false, false),
        open_feedback(false, true),
    ]
    .contains(&message)
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
    app.ui.actions.clear();
    app.ui.timeline_items.clear();
    app.ui.timeline = Rect::default();
    app.ui.composer = Rect::default();
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
    app.ui.timeline = rows[1];
    app.ui.composer = rows[2];
    let (connection_label, connection_color) = match (app.connection, compact) {
        (ConnectionState::Connected, false) => ("● Connected", app.color(Color::Green)),
        (ConnectionState::Connecting, false) => ("◌ Connecting", app.color(Color::Yellow)),
        (ConnectionState::Reconnecting, false) => ("◌ Reconnecting", app.color(Color::Yellow)),
        (ConnectionState::Connected, true) => ("●", app.color(Color::Green)),
        (ConnectionState::Connecting | ConnectionState::Reconnecting, true) => {
            ("◌", app.color(Color::Yellow))
        }
    };
    let expiry_label = (!compact)
        .then(|| {
            format_room_expiry(
                app.idle_ttl_minutes,
                app.room_expires_at.as_deref(),
                app.presence,
                false,
            )
        })
        .flatten();
    let room_url = room_url(app).to_string();
    let prefix = if compact {
        format!(" qd v{} · ", env!("CARGO_PKG_VERSION"))
    } else {
        format!(" QuickDrop v{} · ", env!("CARGO_PKG_VERSION"))
    };
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                prefix.as_str(),
                Style::default().add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                room_url.as_str(),
                Style::default()
                    .fg(app.color(Color::Cyan))
                    .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
                    .add_modifier(
                        if app.hover == Some(HoverTarget::Action(MouseAction::OpenRoom)) {
                            Modifier::REVERSED
                        } else {
                            Modifier::empty()
                        },
                    ),
            ),
            Span::styled(
                format!("  {connection_label}"),
                Style::default().fg(connection_color),
            ),
            Span::styled(
                format!("  {} online", app.presence),
                Style::default().fg(app.color(Color::Magenta)),
            ),
            Span::raw(
                expiry_label
                    .map(|label| format!("  {label}"))
                    .unwrap_or_default(),
            ),
        ]))
        .block(Block::default().borders(Borders::ALL)),
        rows[0],
    );
    let link_x = rows[0]
        .x
        .saturating_add(1)
        .saturating_add(prefix.chars().count() as u16);
    let available_width = rows[0].right().saturating_sub(1).saturating_sub(link_x);
    app.ui.actions.push(ActionRegion {
        area: Rect::new(
            link_x,
            rows[0].y.saturating_add(1),
            (room_url.chars().count() as u16).min(available_width),
            1,
        ),
        action: MouseAction::OpenRoom,
    });
    let now = Instant::now();
    let items: Vec<ListItem<'_>> = app
        .drops
        .iter()
        .enumerate()
        .map(|(index, drop)| {
            let mut lines = Vec::with_capacity(timeline_item_height(drop, compact));
            let origin_label = app.origin_label_at(&drop.id, now);
            let item_color = if app.latest_remote_id.as_deref() == Some(&drop.id) {
                app.color(Color::Cyan)
            } else {
                Color::Reset
            };
            let origin_color = match origin_label {
                "YOU" => app.color(Color::Magenta),
                label if label.contains("NEW") => app.color(Color::Green),
                "REMOTE" => app.color(Color::Cyan),
                _ => Color::Reset,
            };
            lines.push(Line::from(vec![
                Span::styled(
                    format!(
                        "{}  {}",
                        content_kind(&drop.content),
                        short_time(&drop.created_at)
                    ),
                    Style::default().fg(item_color).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    if origin_label.is_empty() {
                        String::new()
                    } else {
                        format!("  {origin_label}")
                    },
                    Style::default()
                        .fg(origin_color)
                        .add_modifier(Modifier::BOLD),
                ),
            ]));
            if compact {
                lines.push(Line::styled(
                    truncate(
                        &drop.content.replace('\n', " "),
                        rows[1].width.saturating_sub(8) as usize,
                    ),
                    Style::default().fg(item_color),
                ));
            } else {
                lines.extend(
                    drop.content
                        .split('\n')
                        .map(|line| Line::styled(line, Style::default().fg(item_color))),
                );
            }
            lines.push(Line::raw(""));
            ListItem::new(Text::from(lines)).style(Style::default().fg(item_color).add_modifier(
                if app.hover == Some(HoverTarget::TimelineItem(index)) {
                    Modifier::REVERSED
                } else {
                    Modifier::empty()
                },
            ))
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
    let mut item_y = rows[1].y.saturating_add(1);
    let items_bottom = rows[1].bottom().saturating_sub(1);
    for (index, drop) in app.drops.iter().enumerate().skip(state.offset()) {
        if item_y >= items_bottom {
            break;
        }
        let height = u16::try_from(timeline_item_height(drop, compact))
            .unwrap_or(u16::MAX)
            .min(items_bottom.saturating_sub(item_y));
        app.ui.timeline_items.push(TimelineItemRegion {
            area: Rect::new(
                rows[1].x.saturating_add(1),
                item_y,
                rows[1].width.saturating_sub(2),
                height,
            ),
            index,
        });
        item_y = item_y.saturating_add(height);
    }
    let composer_title = if app.editing_drop_id.is_some() {
        " Edit drop "
    } else {
        " New drop "
    };
    app.composer.set_block(
        Block::default()
            .title(composer_title)
            .borders(Borders::ALL)
            .border_style(
                Style::default()
                    .fg(
                        if app.focus == Focus::Composer || app.hover == Some(HoverTarget::Composer)
                        {
                            app.color(Color::Cyan)
                        } else {
                            Color::Reset
                        },
                    )
                    .add_modifier(if app.hover == Some(HoverTarget::Composer) {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            ),
    );
    frame.render_widget(&app.composer, rows[2]);
    let (default_footer, actions) = if app.focus == Focus::Composer {
        let submit_label = if app.editing_drop_id.is_some() {
            "[Enter Save]"
        } else {
            "[Enter Send]"
        };
        (
            if compact {
                format!(
                    "{} · Ctrl/Shift+Enter newline · Esc {}",
                    submit_label.trim_matches(['[', ']']),
                    if app.editing_drop_id.is_some() {
                        "cancel"
                    } else {
                        "back"
                    }
                )
            } else {
                format!(
                    "{} · Ctrl/Shift+Enter new line · Esc {}",
                    submit_label.trim_matches(['[', ']']),
                    if app.editing_drop_id.is_some() {
                        "cancel"
                    } else {
                        "timeline"
                    }
                )
            },
            vec![
                (submit_label.to_owned(), MouseAction::Submit),
                ("[New line]".to_owned(), MouseAction::Newline),
                ("[Clear]".to_owned(), MouseAction::Clear),
                ("[Cancel]".to_owned(), MouseAction::Cancel),
            ],
        )
    } else {
        let mut actions = vec![
            ("[e Edit]".to_owned(), MouseAction::Edit),
            ("[c Copy]".to_owned(), MouseAction::Copy),
            ("[r Resend]".to_owned(), MouseAction::Resend),
            ("[d Delete]".to_owned(), MouseAction::Delete),
            ("[Ctrl+O Switch]".to_owned(), MouseAction::SwitchRoom),
            ("[? Help]".to_owned(), MouseAction::Help),
            ("[q Quit]".to_owned(), MouseAction::Quit),
        ];
        let fallback = if let Some(update) = &app.available_update {
            actions.insert(0, ("[Ctrl+U Update]".to_owned(), MouseAction::Update));
            format!(
                "Ctrl+O switch · Ctrl+U update to {} · e edit · c copy · r resend · d delete · ? help · q quit",
                update.version
            )
        } else {
            "Ctrl+O switch · e edit · c copy · r resend · d delete · ? help · q quit".to_owned()
        };
        (fallback, actions)
    };
    render_action_footer(frame, app, rows[3], &default_footer, actions);
}

fn render_help(frame: &mut Frame<'_>, app: &mut App<'_>) {
    app.ui.actions.clear();
    let area = centered_rect(62, 19, frame.area());
    frame.render_widget(Clear, area);
    let help = "Navigation\n  j/J/↓, k/K/↑    Select a drop\n  g/G/Home         First drop\n  End              Last drop\n  Enter/i/I/Tab    Focus composer\n  Click/scroll     Select and navigate\n  Hover            Highlight interactive regions\n\nActions\n  e/E edit · c/C copy · r/R resend · d/D delete\n  Ctrl+O switch room · Ctrl+U update\n\nComposer / editor\n  Enter send/save · Ctrl+Enter or Shift+Enter new line · Esc cancel\n\nShift+drag selects terminal text";
    frame.render_widget(
        Paragraph::new(help).wrap(Wrap { trim: false }).block(
            Block::default()
                .title(" Help ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(app.color(Color::Cyan))),
        ),
        area,
    );
    let actions = vec![
        ("[Close]".to_owned(), MouseAction::Close),
        ("[Quit]".to_owned(), MouseAction::Quit),
    ];
    let action_area = Rect::new(area.x, area.bottom().saturating_sub(2), area.width, 1);
    render_centered_actions(frame, app, action_area, &actions);
}

fn render_confirmation(frame: &mut Frame<'_>, app: &mut App<'_>) {
    app.ui.actions.clear();
    let area = centered_rect(48, 7, frame.area());
    frame.render_widget(Clear, area);
    frame.render_widget(
        Paragraph::new("Delete the selected drop for every connected device?")
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
    render_centered_actions(
        frame,
        app,
        Rect::new(area.x, area.y.saturating_add(4), area.width, 1),
        &[
            ("[Yes, delete]".to_owned(), MouseAction::ConfirmDelete),
            ("[Cancel]".to_owned(), MouseAction::Close),
        ],
    );
}

fn render_action_footer(
    frame: &mut Frame<'_>,
    app: &mut App<'_>,
    area: Rect,
    fallback: &str,
    actions: Vec<(String, MouseAction)>,
) {
    if let Some(status) = app.status.as_deref() {
        frame.render_widget(
            Paragraph::new(status)
                .alignment(Alignment::Center)
                .style(Style::default().add_modifier(Modifier::BOLD)),
            area,
        );
        return;
    }
    let action_text = actions
        .iter()
        .map(|(label, _)| label.as_str())
        .collect::<Vec<_>>()
        .join(" · ");
    if action_text.chars().count() <= usize::from(area.width) {
        render_centered_actions(frame, app, area, &actions);
    } else {
        frame.render_widget(Paragraph::new(fallback).alignment(Alignment::Center), area);
    }
}

fn render_centered_actions(
    frame: &mut Frame<'_>,
    app: &mut App<'_>,
    area: Rect,
    actions: &[(String, MouseAction)],
) {
    let mut spans = Vec::with_capacity(actions.len().saturating_mul(2).saturating_sub(1));
    for (index, (label, action)) in actions.iter().enumerate() {
        if index > 0 {
            spans.push(Span::raw(" · "));
        }
        spans.push(Span::styled(
            label.as_str(),
            Style::default().add_modifier(if app.hover == Some(HoverTarget::Action(*action)) {
                Modifier::REVERSED
            } else {
                Modifier::empty()
            }),
        ));
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).alignment(Alignment::Center),
        area,
    );
    register_centered_actions(app, area, actions);
}

fn register_centered_actions(app: &mut App<'_>, area: Rect, actions: &[(String, MouseAction)]) {
    let total_width = actions
        .iter()
        .map(|(label, _)| label.chars().count())
        .sum::<usize>()
        .saturating_add(actions.len().saturating_sub(1) * 3);
    let mut x = area
        .x
        .saturating_add(area.width.saturating_sub(total_width as u16) / 2);
    for (label, action) in actions {
        let width = label.chars().count() as u16;
        app.ui.actions.push(ActionRegion {
            area: Rect::new(x, area.y, width, area.height),
            action: *action,
        });
        x = x.saturating_add(width).saturating_add(3);
    }
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
fn timeline_item_height(drop: &TextDrop, compact: bool) -> usize {
    if compact {
        3
    } else {
        drop.content.split('\n').count().saturating_add(2)
    }
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
fn short_time(timestamp: &str) -> String {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|value| value.with_timezone(&Local).format("%H:%M").to_string())
        .unwrap_or_else(|_| timestamp.get(11..16).unwrap_or(timestamp).to_owned())
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
        if let Err(error) = execute!(stdout, EnterAlternateScreen, EnableMouseCapture) {
            let _ = execute!(io::stdout(), DisableMouseCapture, LeaveAlternateScreen);
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
                let _ = execute!(io::stdout(), DisableMouseCapture, LeaveAlternateScreen);
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
                let _ = execute!(io::stdout(), DisableMouseCapture, LeaveAlternateScreen);
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
        let _ = disable_raw_mode();
        if self.keyboard_enhancement_enabled {
            let _ = execute!(self.terminal.backend_mut(), PopKeyboardEnhancementFlags);
        }
        let _ = execute!(
            self.terminal.backend_mut(),
            DisableMouseCapture,
            LeaveAlternateScreen
        );
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
    fn mouse_event(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
        MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }
    #[test]
    fn normalizes_valid_codes_and_rejects_invalid_ones() {
        assert_eq!(normalize_code("dev_1").unwrap(), "DEV_1");
        assert!(normalize_code("bad code").is_err());
        assert!(normalize_code("abcdefghijklmnopq").is_err());
    }
    #[test]
    fn direct_entry_seeds_pin_and_authoritative_feedback() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let app = App::new(
            server,
            Some("SECRET".to_owned()),
            Some("correct horse".to_owned()),
        );

        assert_eq!(app.screen, Screen::Timeline);
        assert_eq!(app.pin_input, "correct horse");
        assert_eq!(app.pin_purpose, PinPurpose::Create);
        assert_eq!(open_feedback(true, false), "Created a new room.");
        assert_eq!(
            open_feedback(true, true),
            "Created a new PIN-protected room."
        );
        assert_eq!(open_feedback(false, false), "Entered an existing room.");
        assert_eq!(
            open_feedback(false, true),
            "Entered an existing PIN-protected room."
        );
    }
    #[test]
    fn entry_feedback_expires_without_clearing_newer_status() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let now = Instant::now();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.status = Some(open_feedback(true, false).to_owned());
        app.status_expires_at = Some(now + STATUS_FEEDBACK_DURATION);

        app.expire_status_feedback(now + STATUS_FEEDBACK_DURATION);
        assert!(app.status.is_none());

        app.status = Some("New drop received".to_owned());
        app.status_expires_at = Some(now + STATUS_FEEDBACK_DURATION);
        app.expire_status_feedback(now + STATUS_FEEDBACK_DURATION);
        assert_eq!(app.status.as_deref(), Some("New drop received"));
        assert!(app.status_expires_at.is_none());
    }

    #[test]
    fn keeps_newest_drops_first_and_selection_valid() {
        let server = Url::parse("https://quickdrop.example").unwrap();

        let mut app = App::new(server, Some("DEV".to_owned()), None);
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
        let mut unknown_client_id = None;
        let event = parse_server_event(
            r#"{"type":"drop_added","drop":{"id":"2","content":"remote","createdAt":"2026-01-01T12:00:00Z"}}"#,
            &mut unknown_client_id,
        )
        .unwrap();
        assert!(
            matches!(event, NetEvent::Added(_, false)),
            "missing identities must not classify a drop as self-authored"
        );
    }

    #[test]
    fn expired_access_returns_to_pin_and_reconnect_releases_the_editor() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("SECRET".to_owned()), None);
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
    fn origin_expiry_snapshot_preservation_and_remote_fallback_are_independent() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.replace_drops(vec![
            drop("selected", "selected", "2026-01-01T10:00:00Z"),
            drop("older", "older", "2026-01-01T09:00:00Z"),
        ]);
        assert_eq!(app.drop_origins.get("selected"), Some(&DropOrigin::Unknown));
        assert_eq!(app.origin_label_at("selected", Instant::now()), "");

        app.selected = 0;
        app.add_drop(
            drop("remote-1", "remote one", "2026-01-01T11:00:00Z"),
            false,
        );
        assert_eq!(
            app.selected_drop().map(|drop| drop.id.as_str()),
            Some("selected")
        );
        assert_eq!(app.latest_remote_id.as_deref(), Some("remote-1"));
        let remote_expiry = app
            .new_remote_marker
            .as_ref()
            .map(|(_, expires_at)| *expires_at)
            .unwrap();
        assert_eq!(
            app.origin_label_at("remote-1", remote_expiry - Duration::from_millis(1)),
            "REMOTE NEW"
        );

        app.expire_new_marker(remote_expiry);
        assert_eq!(app.origin_label_at("remote-1", remote_expiry), "REMOTE");
        assert_eq!(app.latest_remote_id.as_deref(), Some("remote-1"));

        app.add_drop(drop("self", "mine", "2026-01-01T12:00:00Z"), true);
        assert_eq!(app.origin_label_at("self", remote_expiry), "YOU");
        assert_eq!(app.latest_remote_id.as_deref(), Some("remote-1"));

        app.replace_drops(vec![
            drop("snapshot-new", "historical", "2026-01-01T13:00:00Z"),
            drop("self", "mine", "2026-01-01T12:00:00Z"),
            drop("remote-1", "remote one", "2026-01-01T11:00:00Z"),
        ]);
        assert_eq!(
            app.drop_origins.get("snapshot-new"),
            Some(&DropOrigin::Unknown)
        );
        assert_eq!(app.drop_origins.get("self"), Some(&DropOrigin::Self_));
        assert_eq!(app.drop_origins.get("remote-1"), Some(&DropOrigin::Remote));

        app.add_drop(
            drop("remote-2", "remote two", "2026-01-01T14:00:00Z"),
            false,
        );
        assert_eq!(app.latest_remote_id.as_deref(), Some("remote-2"));
        app.update_drop(
            drop("remote-1", "remote one edited", "2026-01-01T11:00:00Z"),
            false,
        );
        assert_eq!(
            app.latest_remote_id.as_deref(),
            Some("remote-2"),
            "updating an older remote must not steal the newest-remote highlight"
        );
        let update_expiry = app
            .new_remote_marker
            .as_ref()
            .map(|(_, expires_at)| *expires_at)
            .unwrap();
        assert_eq!(
            app.origin_label_at("remote-1", update_expiry - Duration::from_millis(1)),
            "REMOTE NEW"
        );
        app.expire_new_marker(update_expiry);
        assert_eq!(app.origin_label_at("remote-1", update_expiry), "REMOTE");

        app.remove_drop("remote-2");
        assert_eq!(app.latest_remote_id.as_deref(), Some("remote-1"));

        apply_network_event(&mut app, NetEvent::Cleared);
        assert!(app.drops.is_empty());
        assert!(app.drop_origins.is_empty());
        assert!(app.latest_remote_id.is_none());
        assert!(app.new_remote_marker.is_none());
    }
    #[test]
    fn timeline_renders_origin_labels_and_persistent_remote_highlight() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.no_color = false;
        app.replace_drops(vec![drop("snapshot", "historical", "2026-01-01T09:00:00Z")]);
        app.add_drop(
            drop("remote-1", "remote one", "2026-01-01T10:00:00Z"),
            false,
        );
        let marker_expiry = app
            .new_remote_marker
            .as_ref()
            .map(|(_, expires_at)| *expires_at)
            .unwrap();
        app.add_drop(drop("self", "mine", "2026-01-01T11:00:00Z"), true);

        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        let rendered = (0..30)
            .map(|y| {
                (0..100)
                    .filter_map(|x| {
                        terminal
                            .backend()
                            .buffer()
                            .cell((x, y))
                            .map(|cell| cell.symbol())
                    })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("YOU"));
        assert!(rendered.contains("REMOTE NEW"));

        app.expire_new_marker(marker_expiry);
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        let rendered = (0..30)
            .map(|y| {
                (0..100)
                    .filter_map(|x| {
                        terminal
                            .backend()
                            .buffer()
                            .cell((x, y))
                            .map(|cell| cell.symbol())
                    })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(rendered.contains("REMOTE"));
        assert!(!rendered.contains("NEW"));
        assert_eq!(app.latest_remote_id.as_deref(), Some("remote-1"));

        let remote_is_cyan = (0..30).any(|y| {
            let row = (0..100)
                .filter_map(|x| {
                    terminal
                        .backend()
                        .buffer()
                        .cell((x, y))
                        .map(|cell| cell.symbol())
                })
                .collect::<String>();
            row.find("remote one").is_some_and(|byte_start| {
                let start = row[..byte_start].chars().count();
                (start..start + "remote one".len()).all(|x| {
                    terminal
                        .backend()
                        .buffer()
                        .cell((x as u16, y))
                        .is_some_and(|cell| cell.fg == Color::Cyan)
                })
            })
        });
        assert!(
            remote_is_cyan,
            "latest remote content should remain cyan after NEW expires"
        );
    }

    #[tokio::test]
    async fn enter_publishes_and_clears_the_composer() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.screen = Screen::Timeline;
        app.focus = Focus::Composer;
        app.connection = ConnectionState::Connected;
        app.composer.insert_str("hello");
        let (actions, mut received) = mpsc::channel(1);

        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
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
    async fn ctrl_or_shift_enter_inserts_a_newline_without_publishing() {
        for modifiers in [KeyModifiers::CONTROL, KeyModifiers::SHIFT] {
            let server = Url::parse("https://quickdrop.example").unwrap();
            let mut app = App::new(server, Some("DEV".to_owned()), None);
            app.screen = Screen::Timeline;
            app.focus = Focus::Composer;
            app.connection = ConnectionState::Connected;
            app.composer.insert_str("first");
            let (actions, mut received) = mpsc::channel(1);

            handle_timeline_key(
                &mut app,
                KeyEvent::new(KeyCode::Enter, modifiers),
                Some(&actions),
            )
            .await
            .unwrap();
            app.composer.insert_str("second");

            assert_eq!(app.composer_content(), "first\nsecond");
            assert!(received.try_recv().is_err());
            assert_eq!(app.focus, Focus::Composer);
        }
    }

    #[tokio::test]
    async fn e_edits_the_selected_drop_and_restores_the_composer_draft() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
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
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
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
        let mut app = App::new(server, None, None);

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
        let mut app = App::new(server, None, None);
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
    async fn uppercase_shortcuts_work_without_changing_typed_text() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.screen = Screen::Timeline;
        app.replace_drops(vec![
            drop("new", "new", "2026-01-01T11:00:00Z"),
            drop("old", "old", "2026-01-01T10:00:00Z"),
        ]);

        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('J'), KeyModifiers::SHIFT),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.selected, 1);
        handle_timeline_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('D'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Timeline);
        assert!(!app.quit);
        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.selected, 0);
        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('E'), KeyModifiers::SHIFT),
            None,
        )
        .await
        .unwrap();
        assert!(app.editing_drop_id.is_some());

        app.finish_edit();
        app.focus = Focus::Composer;
        handle_timeline_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('A'), KeyModifiers::SHIFT),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.composer_content(), "A");

        app.screen = Screen::Code;
        app.code_input = "SECRET".to_owned();
        handle_key(
            &mut app,
            KeyEvent::new(
                KeyCode::Char('P'),
                KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            ),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Pin);
        assert_eq!(app.pin_purpose, PinPurpose::Create);
    }

    #[tokio::test]
    async fn mouse_selects_drops_focuses_composer_and_runs_visible_actions() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.screen = Screen::Timeline;
        app.replace_drops(vec![
            drop("new", "new\nsecond line", "2026-01-01T11:00:00Z"),
            drop("old", "old", "2026-01-01T10:00:00Z"),
        ]);
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &mut app)).unwrap();

        let timeline = app.ui.timeline;
        handle_mouse(
            &mut app,
            mouse_event(
                MouseEventKind::Down(MouseButton::Left),
                timeline.x + 2,
                timeline.y + 5,
            ),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.selected, 1);

        let composer = app.ui.composer;
        handle_mouse(
            &mut app,
            mouse_event(
                MouseEventKind::Down(MouseButton::Left),
                composer.x + 2,
                composer.y + 1,
            ),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.focus, Focus::Composer);

        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        let newline = app
            .ui
            .actions
            .iter()
            .find(|region| region.action == MouseAction::Newline)
            .copied()
            .expect("newline action should be visible");
        handle_mouse(
            &mut app,
            mouse_event(
                MouseEventKind::Down(MouseButton::Left),
                newline.area.x,
                newline.area.y,
            ),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.composer_content(), "\n");

        app.focus = Focus::Timeline;
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        let help = app
            .ui
            .actions
            .iter()
            .find(|region| region.action == MouseAction::Help)
            .copied()
            .expect("help action should be visible");
        handle_mouse(
            &mut app,
            mouse_event(
                MouseEventKind::Down(MouseButton::Left),
                help.area.x,
                help.area.y,
            ),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.screen, Screen::Help);
    }

    #[tokio::test]
    async fn mouse_hover_visually_tracks_every_interactive_region() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.screen = Screen::Timeline;
        app.replace_drops(vec![drop("new", "hover me", "2026-01-01T11:00:00Z")]);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &mut app)).unwrap();

        let room_link = app
            .ui
            .actions
            .iter()
            .find(|region| region.action == MouseAction::OpenRoom)
            .copied()
            .unwrap();
        handle_mouse(
            &mut app,
            mouse_event(MouseEventKind::Moved, room_link.area.x, room_link.area.y),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.hover, Some(HoverTarget::Action(MouseAction::OpenRoom)));
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        assert!(terminal
            .backend()
            .buffer()
            .cell((room_link.area.x, room_link.area.y))
            .unwrap()
            .modifier
            .contains(Modifier::REVERSED));

        let item = app.ui.timeline_items[0];
        handle_mouse(
            &mut app,
            mouse_event(MouseEventKind::Moved, item.area.x, item.area.y),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.hover, Some(HoverTarget::TimelineItem(0)));
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        assert!(terminal
            .backend()
            .buffer()
            .cell((item.area.x, item.area.y))
            .unwrap()
            .modifier
            .contains(Modifier::REVERSED));

        let composer = app.ui.composer;
        handle_mouse(
            &mut app,
            mouse_event(MouseEventKind::Moved, composer.x, composer.y),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.hover, Some(HoverTarget::Composer));
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        assert!(terminal
            .backend()
            .buffer()
            .cell((composer.x, composer.y))
            .unwrap()
            .modifier
            .contains(Modifier::BOLD));

        let copy = app
            .ui
            .actions
            .iter()
            .find(|region| region.action == MouseAction::Copy)
            .copied()
            .unwrap();
        handle_mouse(
            &mut app,
            mouse_event(MouseEventKind::Moved, copy.area.x, copy.area.y),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.hover, Some(HoverTarget::Action(MouseAction::Copy)));
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        assert!((copy.area.x..copy.area.right()).any(|x| {
            terminal
                .backend()
                .buffer()
                .cell((x, copy.area.y))
                .is_some_and(|cell| cell.modifier.contains(Modifier::REVERSED))
        }));

        handle_mouse(&mut app, mouse_event(MouseEventKind::Moved, 0, 0), None)
            .await
            .unwrap();
        assert_eq!(app.hover, None);
    }

    #[tokio::test]
    async fn overlays_do_not_hover_inactive_timeline_regions() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.replace_drops(vec![drop("new", "background", "2026-01-01T11:00:00Z")]);
        let backend = TestBackend::new(120, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        let item = app.ui.timeline_items[0];

        app.screen = Screen::Help;
        terminal.draw(|frame| render(frame, &mut app)).unwrap();
        handle_mouse(
            &mut app,
            mouse_event(MouseEventKind::Moved, item.area.x, item.area.y),
            None,
        )
        .await
        .unwrap();

        assert_eq!(app.hover, None);
    }

    #[tokio::test]
    async fn mouse_clear_and_cancel_report_immediate_feedback() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        app.screen = Screen::Timeline;
        app.focus = Focus::Composer;
        app.composer.insert_str("draft");

        run_mouse_action(&mut app, MouseAction::Clear, None)
            .await
            .unwrap();
        assert!(app.composer_content().is_empty());
        assert_eq!(app.status.as_deref(), Some("Composer cleared"));

        run_mouse_action(&mut app, MouseAction::Cancel, None)
            .await
            .unwrap();
        assert_eq!(app.focus, Focus::Timeline);
        assert_eq!(app.status.as_deref(), Some("Composer closed"));
    }

    #[tokio::test]
    async fn pin_prompt_accepts_a_valid_pin_and_returns_to_the_code_screen() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("SECRET".to_owned()), None);
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
    async fn ctrl_u_requests_an_available_update_from_every_screen() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, None, None);
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
            .is_some_and(|status| status.contains("press Ctrl+U to update")));

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('u'), KeyModifiers::NONE),
            None,
        )
        .await
        .unwrap();
        assert_eq!(app.code_input, "U");
        assert!(!app.update_requested);

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL),
            None,
        )
        .await
        .unwrap();
        assert!(app.update_requested);
        assert!(app.update_busy);
        assert_eq!(app.status.as_deref(), Some("Updating to qd 9.9.9…"));
    }

    #[test]
    fn successful_update_requests_a_clean_restart() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
        apply_update_event(&mut app, Some(UpdateEvent::Applied(Ok("9.9.9".to_owned()))));
        assert!(app.quit);
        assert!(app.restart_after_update);
    }

    #[tokio::test]
    async fn ctrl_o_leaves_the_current_room_without_quitting() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("OLD".to_owned()), None);
        app.screen = Screen::Timeline;
        app.focus = Focus::Composer;
        app.connection = ConnectionState::Connected;
        app.drops
            .push(drop("old", "room content", "2026-01-01T11:00:00Z"));
        app.composer.insert_str("draft");
        app.presence = 2;

        handle_key(
            &mut app,
            KeyEvent::new(KeyCode::Char('o'), KeyModifiers::CONTROL),
            None,
        )
        .await
        .unwrap();

        assert_eq!(app.screen, Screen::Code);
        assert!(app.code.is_empty());
        assert!(app.code_input.is_empty());
        assert!(app.drops.is_empty());
        assert!(app.composer_content().is_empty());
        assert_eq!(app.presence, 0);
        assert!(app.switch_room_requested);
        assert!(!app.quit);
    }

    #[test]
    fn room_link_uses_the_canonical_url_and_runs_both_click_actions() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DAVID".to_owned()), None);
        let mut copied = None;
        let mut opened = None;

        share_room_link(
            &mut app,
            |url| {
                copied = Some(url.to_owned());
                Ok(())
            },
            |url| {
                opened = Some(url.to_string());
                Ok(())
            },
        );

        assert_eq!(copied.as_deref(), Some("https://quickdrop.example/DAVID"));
        assert_eq!(opened.as_deref(), copied.as_deref());
        assert_eq!(app.status.as_deref(), Some("Room link copied and opened"));
    }

    #[tokio::test]
    async fn q_quits_from_help_and_failed_publish_restores_the_composer() {
        let server = Url::parse("https://quickdrop.example").unwrap();
        let mut app = App::new(server, Some("DEV".to_owned()), None);
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
            let mut app = App::new(server, Some("DEV".to_owned()), None);
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
            assert!(rendered.contains(if width < 70 { "qd v" } else { "QuickDrop v" }));
            assert!(rendered.contains("https://quickdrop.example/DEV"));
            assert!(app
                .ui
                .actions
                .iter()
                .any(|region| region.action == MouseAction::OpenRoom));
            assert!(rendered.contains("hello from QuickDrop"));
            assert!(rendered.contains(&format!("v{}", env!("CARGO_PKG_VERSION"))));
            assert!(rendered.contains("0 online"));
            let rendered_lower = rendered.to_ascii_lowercase();
            assert!(rendered_lower.contains("c copy"));
            assert!(!rendered_lower.contains("y copy"));

            app.focus = Focus::Composer;
            terminal.draw(|frame| render(frame, &mut app)).unwrap();
            let composer_footer: String = terminal
                .backend()
                .buffer()
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect();
            assert!(composer_footer.contains("Enter Send"));
            assert!(app
                .ui
                .actions
                .iter()
                .any(|region| region.action == MouseAction::Newline));
        }
    }

    #[test]
    fn formats_held_and_countdown_expiry_labels() {
        assert_eq!(
            format_room_expiry(Some(30), None, 1, false).as_deref(),
            Some("held open · 30m idle")
        );
        assert_eq!(
            format_room_expiry(Some(30), None, 1, true).as_deref(),
            Some("held")
        );
        assert_eq!(format_remaining_clock(12 * 60 * 1000 + 34_000), "12:34");
        assert_eq!(format_compact_remaining(90_000), "1m");
        assert_eq!(parse_rfc3339_unix_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_rfc3339_unix_ms("2026-06-23T20:30:00.000Z"),
            Some(1_782_246_600_000)
        );
        assert_eq!(parse_rfc3339_unix_ms("2026-02-31T00:00:00.000Z"), None);
    }
}
