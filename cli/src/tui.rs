use std::{env, io, time::Duration};

use crossterm::{
    event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
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
use tokio::{sync::mpsc, time::sleep};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tui_textarea::TextArea;

use crate::{copy_to_system_clipboard, endpoint, open_room, Client, QdCommand, QdError, TextDrop};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Screen {
    Code,
    Timeline,
    Help,
    ConfirmDelete,
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
    Delete(String),
}
#[derive(Debug)]
enum NetEvent {
    State(ConnectionState),
    Snapshot(Vec<TextDrop>),
    Added(TextDrop),
    Deleted(String),
    Removed(Vec<String>),
    Error(String),
}

struct App<'a> {
    screen: Screen,
    focus: Focus,
    code_input: String,
    code: String,
    drops: Vec<TextDrop>,
    selected: usize,
    composer: TextArea<'a>,
    connection: ConnectionState,
    status: Option<String>,
    quit: bool,
    no_color: bool,
    server: Url,
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
            code: code.unwrap_or_default(),
            drops: Vec::new(),
            selected: 0,
            composer,
            connection: ConnectionState::Connecting,
            status: None,
            quit: false,
            no_color: env::var_os("NO_COLOR").is_some(),
            server,
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
        sort_drops(&mut drops);
        self.drops = drops;
        self.selected = self.selected.min(self.drops.len().saturating_sub(1));
    }
    fn add_drop(&mut self, drop: TextDrop) {
        self.drops.retain(|item| item.id != drop.id);
        self.drops.push(drop);
        sort_drops(&mut self.drops);
        self.selected = 0;
        self.status = Some("Sent".to_owned());
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
}

pub async fn run_tui(server: Url, initial_code: Option<String>) -> Result<(), QdError> {
    let mut terminal = TerminalGuard::enter()?;
    let mut events = EventStream::new();
    let mut app = App::new(server, initial_code);
    let mut connection = None;
    loop {
        terminal
            .draw(|frame| render(frame, &mut app))
            .map_err(terminal_error)?;
        if app.quit {
            return Ok(());
        }
        if app.screen == Screen::Timeline && connection.is_none() {
            let command = QdCommand {
                code: app.code.clone(),
                copy: false,
                server: app.server.clone(),
            };
            let room = open_room(&Client::new(), &command).await?;
            if room.protected {
                app.screen = Screen::Code;
                app.code_input = app.code.clone();
                app.status =
                    Some("PIN-protected clipboards are only available on the web".to_owned());
                app.code.clear();
                continue;
            }
            app.code = room.code;
            let (actions_tx, actions_rx) = mpsc::channel(32);
            let (network_tx, network_rx) = mpsc::channel(64);
            tokio::spawn(realtime_client(
                app.server.clone(),
                app.code.clone(),
                actions_rx,
                network_tx,
            ));
            connection = Some((actions_tx, network_rx));
        }
        if let Some((actions, network)) = connection.as_mut() {
            tokio::select! {
                terminal_event = events.next() => if let Some(Ok(Event::Key(key))) = terminal_event { handle_key(&mut app, key, Some(actions)).await?; },
                network_event = network.recv() => match network_event { Some(event) => apply_network_event(&mut app, event), None => app.connection = ConnectionState::Reconnecting }
            }
        } else if let Some(Ok(Event::Key(key))) = events.next().await {
            handle_key(&mut app, key, None).await?;
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
            KeyCode::Enter => match normalize_code(&app.code_input) {
                Ok(code) => {
                    app.code = code;
                    app.screen = Screen::Timeline;
                    app.status = None;
                }
                Err(message) => app.status = Some(message),
            },
            KeyCode::Backspace => {
                app.code_input.pop();
            }
            KeyCode::Char(character) if app.code_input.len() < 16 && valid_code_char(character) => {
                app.code_input.push(character.to_ascii_uppercase())
            }
            _ => {}
        },
        Screen::Help => {
            if matches!(
                key.code,
                KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q')
            ) {
                app.screen = Screen::Timeline;
            }
        }
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
            app.focus = Focus::Timeline;
        } else if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Enter | KeyCode::Char('s'))
        {
            let content = app.composer_content();
            if content.trim().is_empty() {
                app.status = Some("Write something before sending".to_owned());
            } else if app.connection != ConnectionState::Connected {
                app.status = Some("Wait for the connection before sending".to_owned());
            } else if let Some(sender) = actions {
                sender
                    .send(Action::Publish(content))
                    .await
                    .map_err(channel_error)?;
                app.clear_composer();
                app.focus = Focus::Timeline;
                app.status = Some("Sending…".to_owned());
            }
        } else if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('u') {
            app.clear_composer();
        } else {
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
        KeyCode::Char('y') => {
            if let Some(content) = app.selected_drop().map(|drop| drop.content.clone()) {
                copy_to_system_clipboard(&content)?;
                app.status = Some("Copied".to_owned());
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
        _ => {}
    }
    Ok(())
}

fn apply_network_event(app: &mut App<'_>, event: NetEvent) {
    match event {
        NetEvent::State(state) => app.connection = state,
        NetEvent::Snapshot(drops) => app.replace_drops(drops),
        NetEvent::Added(drop) => app.add_drop(drop),
        NetEvent::Deleted(id) => {
            app.remove_drop(&id);
            app.status = Some("Deleted".to_owned());
        }
        NetEvent::Removed(ids) => {
            for id in ids {
                app.remove_drop(&id);
            }
        }
        NetEvent::Error(message) => app.status = Some(message),
    }
}

async fn realtime_client(
    server: Url,
    code: String,
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
        let Ok((mut socket, _)) = connect_async(url.as_str()).await else {
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
        loop {
            tokio::select! {
                action = actions.recv() => match action {
                    Some(Action::Publish(content)) => if socket.send(Message::Text(json!({ "type": "drop_add", "content": content }).to_string().into())).await.is_err() { break; },
                    Some(Action::Delete(drop_id)) => if socket.send(Message::Text(json!({ "type": "drop_delete", "dropId": drop_id }).to_string().into())).await.is_err() { break; },
                    None => return,
                },
                message = socket.next() => match message {
                    Some(Ok(Message::Text(text))) => if let Some(event) = parse_server_event(&text) { if events.send(event).await.is_err() { return; } },
                    Some(Ok(Message::Ping(payload))) => if socket.send(Message::Pong(payload)).await.is_err() { break; },
                    Some(Ok(_)) => {}, Some(Err(_)) | None => break,
                }
            }
        }
        sleep(Duration::from_secs(2)).await;
    }
}

fn parse_server_event(text: &str) -> Option<NetEvent> {
    let payload: Value = serde_json::from_str(text).ok()?;
    match payload.get("type")?.as_str()? {
        "snapshot" => serde_json::from_value(payload.get("drops")?.clone())
            .ok()
            .map(NetEvent::Snapshot),
        "drop_added" => serde_json::from_value(payload.get("drop")?.clone())
            .ok()
            .map(NetEvent::Added),
        "drop_deleted" => payload
            .get("dropId")?
            .as_str()
            .map(|id| NetEvent::Deleted(id.to_owned())),
        "drops_removed" => serde_json::from_value(payload.get("dropIds")?.clone())
            .ok()
            .map(NetEvent::Removed),
        "error" => Some(NetEvent::Error(
            payload
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("The server rejected the action")
                .to_owned(),
        )),
        _ => None,
    }
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
    let block = Block::default()
        .title(" Open a clipboard ")
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
        Paragraph::new(app.status.as_deref().unwrap_or("Enter open · Esc quit")).style(
            Style::default().fg(if app.status.is_some() {
                app.color(Color::Red)
            } else {
                Color::Reset
            }),
        ),
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
    app.composer.set_block(
        Block::default()
            .title(" New drop ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(if app.focus == Focus::Composer {
                app.color(Color::Cyan)
            } else {
                Color::Reset
            })),
    );
    frame.render_widget(&app.composer, rows[2]);
    let footer = app
        .status
        .as_deref()
        .unwrap_or(if app.focus == Focus::Composer {
            "Ctrl+S/Enter send · Esc timeline · Ctrl+U clear"
        } else {
            "Enter edit · y copy · r resend · d delete · ? help · q quit"
        });
    frame.render_widget(Paragraph::new(footer).alignment(Alignment::Center), rows[3]);
}

fn render_help(frame: &mut Frame<'_>, app: &App<'_>) {
    let area = centered_rect(58, 18, frame.area());
    frame.render_widget(Clear, area);
    let help = "Navigation\n  j/↓, k/↑       Select a drop\n  g/Home, G/End   First or last drop\n  Enter/i/Tab     Edit composer\n\nActions\n  y copy · r resend · d delete\n\nComposer\n  Ctrl+S/Enter send · Ctrl+U clear · Esc timeline\n\n? or Esc close · q quit";
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
}
impl TerminalGuard {
    fn enter() -> Result<Self, QdError> {
        enable_raw_mode().map_err(terminal_error)?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen) {
            let _ = disable_raw_mode();
            return Err(terminal_error(error));
        }
        match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(terminal) => Ok(Self { terminal }),
            Err(error) => {
                let _ = disable_raw_mode();
                let _ = execute!(io::stdout(), LeaveAlternateScreen);
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
        let _ = execute!(self.terminal.backend_mut(), LeaveAlternateScreen);
        let _ = self.terminal.show_cursor();
    }
}
fn terminal_error(error: io::Error) -> QdError {
    QdError::Runtime(format!("terminal error: {error}"))
}
fn channel_error<T>(_: mpsc::error::SendError<T>) -> QdError {
    QdError::Runtime("the realtime connection stopped unexpectedly".to_owned())
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
    fn parses_realtime_drop_events() {
        let event = parse_server_event(r#"{"type":"drop_added","drop":{"id":"1","content":"hello","createdAt":"2026-01-01T11:00:00Z"}}"#).unwrap();
        let NetEvent::Added(drop) = event else {
            panic!("expected added event")
        };
        assert_eq!(drop.content, "hello");
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
