use base64::Engine;
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};
use std::time::{Duration, Instant};

use crossterm::{
    event::{
        self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyModifiers,
        KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
    },
    execute,
};
use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};
use ratatui_textarea::TextArea;
use serde_json::Value;

use super::{
    completion::{self, Candidate, Context},
    history::History,
    state::{Kind, State},
    transport::{workers, Update, Workers},
    value,
};
use crate::conn::SpaceConnection;

const MAX_INPUT: usize = 64 * 1024;

struct Rendered {
    lines: Vec<Line<'static>>,
    ids: Vec<u64>,
}

struct CompletionMenu {
    context: Context,
    candidates: Vec<Candidate>,
    selected: usize,
}

struct Console {
    state: State,
    editor: TextArea<'static>,
    history: History,
    history_index: Option<usize>,
    draft: String,
    search: Option<String>,
    selected: Option<u64>,
    raw: bool,
    expanded: bool,
    scroll: usize,
    horizontal: u16,
    following: bool,
    new_entries: usize,
    help: bool,
    actions: bool,
    shift_enter: bool,
    completion: Option<CompletionMenu>,
    completion_cache: HashMap<Vec<String>, Vec<Candidate>>,
    completion_pending: HashSet<Vec<String>>,
    completion_generation: u64,
    connected: bool,
    target: String,
    timeout: Duration,
    script: bool,
    started: Option<Instant>,
    message: String,
    rendered: Option<Rendered>,
    anchor: Option<(u64, usize)>,
}

impl Console {
    fn new(conn: &SpaceConnection) -> Self {
        let (history, message) = match History::load(&conn.base_url) {
            Ok(history) => (history, String::new()),
            Err(error) => (History::default(), error),
        };
        Self {
            state: State::default(),
            editor: TextArea::default(),
            history,
            history_index: None,
            draft: String::new(),
            search: None,
            selected: None,
            raw: false,
            expanded: false,
            scroll: 0,
            horizontal: 0,
            following: true,
            new_entries: 0,
            help: false,
            actions: false,
            shift_enter: false,
            completion: None,
            completion_cache: HashMap::new(),
            completion_pending: HashSet::new(),
            completion_generation: 0,
            connected: false,
            target: conn.base_url.clone(),
            timeout: conn.timeout,
            script: false,
            started: None,
            message,
            rendered: None,
            anchor: None,
        }
    }

    fn input(&self) -> String {
        self.editor.lines().join("\n")
    }
    fn set_input(&mut self, text: &str) {
        self.editor = TextArea::from(text.split('\n').map(str::to_owned));
        self.editor
            .move_cursor(ratatui_textarea::CursorMove::Bottom);
        self.editor.move_cursor(ratatui_textarea::CursorMove::End);
    }

    fn invalidate_completions(&mut self) {
        self.completion = None;
        self.completion_cache.clear();
        self.completion_pending.clear();
        self.completion_generation += 1;
    }

    fn refresh_completion(&mut self, workers: &Workers) {
        let cursor = self.editor.cursor();
        let (row, column) = (cursor.0, cursor.1);
        let Some(context) = completion::context(self.editor.lines(), row, column) else {
            self.completion = None;
            return;
        };
        let candidates = if let Some(cached) = self.completion_cache.get(&context.path) {
            cached
                .iter()
                .filter(|candidate| candidate.name.starts_with(&context.prefix))
                .cloned()
                .collect()
        } else {
            if !self.completion_pending.contains(&context.path) {
                let request = super::transport::CompletionRequest {
                    generation: self.completion_generation,
                    path: context.path.clone(),
                };
                if workers.completions.try_send(request).is_err() {
                    self.message = "Completion busy; press Tab to retry".into();
                    self.completion = None;
                    return;
                }
                self.completion_pending.insert(context.path.clone());
            }
            vec![]
        };
        let selected = self
            .completion
            .as_ref()
            .filter(|menu| menu.context == context)
            .map(|menu| menu.selected)
            .unwrap_or(0);
        self.completion = Some(CompletionMenu {
            context,
            candidates,
            selected,
        });
    }

    fn accept_completion(&mut self) {
        let Some(menu) = self.completion.as_ref() else {
            return;
        };
        let Some(candidate) = menu.candidates.get(menu.selected) else {
            return;
        };
        let mut lines = self.editor.lines().to_vec();
        let line = &lines[menu.context.row];
        lines[menu.context.row] = format!(
            "{}{}{}",
            line.chars().take(menu.context.start).collect::<String>(),
            candidate.name,
            line.chars().skip(menu.context.end).collect::<String>()
        );
        self.editor = TextArea::from(lines);
        self.editor.move_cursor(ratatui_textarea::CursorMove::Jump(
            menu.context.row as u16,
            (menu.context.start + candidate.name.len()) as u16,
        ));
        self.completion = None;
    }

    fn submit(&mut self, workers: &Workers) {
        let code = self.input();
        let trimmed = code.trim();
        if trimmed.is_empty() {
            return;
        }
        if code.len() > MAX_INPUT {
            self.message = "Input exceeds 64 KiB".into();
            return;
        }
        if trimmed == ".clear" {
            self.state.clear();
            self.editor = TextArea::default();
            return;
        }
        if trimmed == ".script" {
            self.script = true;
            self.editor = TextArea::default();
            return;
        }
        if trimmed == ".auto" {
            self.script = false;
            self.editor = TextArea::default();
            return;
        }
        if let Some(seconds) = trimmed.strip_prefix(".timeout ") {
            match seconds.parse::<u64>() {
                Ok(n) if n > 0 => {
                    self.timeout = Duration::from_secs(n);
                    self.message = format!("Timeout: {n}s");
                    self.editor = TextArea::default();
                }
                _ => self.message = "Use .timeout <positive seconds>".into(),
            }
            return;
        }
        if self.state.busy() {
            self.message = "An evaluation is still running; your draft is preserved".into();
            return;
        }
        if let Err(error) = self.history.push(&code) {
            self.message = error;
        }
        self.invalidate_completions();
        let id = self.state.submit(code.clone());
        match workers.requests.try_send(super::transport::Request {
            id,
            code,
            timeout: self.timeout,
            script: self.script,
        }) {
            Ok(()) => self.started = Some(Instant::now()),
            Err(error) => self.state.complete(id, Err(error.to_string()), 0),
        }
        self.selected = Some(id);
        self.editor = TextArea::default();
        self.history_index = None;
        self.following = true;
    }

    fn anchor_view(&mut self) {
        if !self.following {
            if let Some(rendered) = &self.rendered {
                if let Some(id) = rendered.ids.get(self.scroll) {
                    let start = rendered.ids.iter().position(|other| other == id).unwrap();
                    self.anchor = Some((*id, self.scroll - start));
                }
            }
        }
    }

    fn update(&mut self, update: Update) {
        if let Update::Completion {
            generation,
            path,
            result,
        } = update
        {
            if generation == self.completion_generation {
                self.completion_pending.remove(&path);
                match result {
                    Ok(value) => {
                        if self.completion_cache.len() >= 32 {
                            self.completion_cache.clear();
                        }
                        self.completion_cache
                            .insert(path, completion::candidates(&value));
                    }
                    Err(error) => {
                        self.message = format!("Completion unavailable: {error}");
                        self.completion = None;
                    }
                }
            }
            return;
        }
        self.anchor_view();
        self.rendered = None;
        let added = match &update {
            Update::Logs(entries) => entries.len(),
            _ => 1,
        };
        match update {
            Update::Completion { .. } => unreachable!(),
            Update::Result(id, result, elapsed) => {
                self.invalidate_completions();
                self.state.complete(id, result, elapsed);
                self.started = None;
            }
            Update::Logs(entries) => {
                for e in entries {
                    self.state.log(e.level, e.text, e.timestamp);
                }
            }
            Update::Connection(Ok(())) => {
                if !self.connected {
                    self.invalidate_completions();
                }
                self.connected = true;
                self.state.notice("Connected to runtime");
            }
            Update::Connection(Err(error)) => {
                self.connected = false;
                self.state
                    .notice(format!("Connection interrupted: {error}. Retrying…"));
            }
            Update::Gap => {
                self.invalidate_completions();
                self.state
                    .notice("Runtime restarted or older log entries were dropped");
            }
        }
        if !self.following {
            self.new_entries += added;
        }
    }

    fn recall(&mut self, backwards: bool) {
        let entries = self.history.entries();
        if entries.is_empty() {
            return;
        }
        if self.history_index.is_none() {
            if !backwards {
                return;
            }
            self.draft = self.input();
        }
        let index = match (self.history_index, backwards) {
            (None, true) => Some(entries.len() - 1),
            (Some(i), true) => Some(i.saturating_sub(1)),
            (Some(i), false) if i + 1 < entries.len() => Some(i + 1),
            _ => None,
        };
        let text = index
            .map(|i| entries[i].clone())
            .unwrap_or_else(|| self.draft.clone());
        self.history_index = index;
        self.set_input(&text);
    }

    fn select(&mut self, backwards: bool) {
        let ids: Vec<_> = self
            .state
            .entries
            .iter()
            .filter(|entry| matches!(entry.kind, Kind::Evaluation { .. }))
            .map(|e| e.id)
            .collect();
        if ids.is_empty() {
            return;
        }
        let index = self
            .selected
            .and_then(|id| ids.iter().position(|i| *i == id))
            .unwrap_or(ids.len() - 1);
        self.selected = Some(
            ids[if backwards {
                index.saturating_sub(1)
            } else {
                (index + 1).min(ids.len() - 1)
            }],
        );
    }

    fn selected_value(&self) -> Option<&Value> {
        self.state
            .entries
            .iter()
            .find(|e| Some(e.id) == self.selected)
            .and_then(|e| match &e.kind {
                Kind::Evaluation {
                    result: Some(Ok(v)),
                    ..
                } => Some(v),
                _ => None,
            })
    }

    fn copy(&mut self) {
        if let Some(value) = self.selected_value() {
            let text = serde_json::to_string_pretty(value).unwrap_or_default();
            // OSC 52 works over SSH without spawning a platform clipboard program.
            let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
            if encoded.len() > 100_000 {
                self.message = "Result too large for clipboard; use Ctrl+S to export".into();
                return;
            }
            match write!(io::stdout(), "\x1b]52;c;{encoded}\x07")
                .and_then(|()| io::stdout().flush())
            {
                Ok(()) => {
                    self.message =
                        "Clipboard copy requested (requires terminal OSC 52 support)".into()
                }
                Err(e) => self.message = e.to_string(),
            }
        }
    }

    fn export(&mut self) {
        if let Some(value) = self.selected_value() {
            let result = (|| -> Result<String, String> {
                let mut file = tempfile::Builder::new()
                    .prefix("sb-result-")
                    .suffix(".json")
                    .tempfile()
                    .map_err(|e| e.to_string())?;
                serde_json::to_writer_pretty(&mut file, value).map_err(|e| e.to_string())?;
                let (_, path) = file.keep().map_err(|e| e.to_string())?;
                Ok(path.display().to_string())
            })();
            self.message = match result {
                Ok(path) => format!("Exported {path}"),
                Err(e) => e,
            };
        }
    }

    fn key(&mut self, key: KeyEvent, workers: &Workers) -> bool {
        self.anchor_view();
        self.rendered = None;
        if self.help {
            self.help = false;
            return false;
        }
        if self.actions {
            match key.code {
                KeyCode::Esc => self.actions = false,
                KeyCode::Char(c)
                    if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
                {
                    match c.to_ascii_lowercase() {
                        'h' => self.help = true,
                        'l' => self.state.show_logs = !self.state.show_logs,
                        'j' => self.raw = !self.raw,
                        _ => return false,
                    }
                    self.actions = false;
                }
                _ => {}
            }
            return false;
        }
        if let Some(search) = self.search.as_mut() {
            match key.code {
                KeyCode::Esc => self.search = None,
                KeyCode::Enter => {
                    let needle = search.clone();
                    let found = self
                        .history
                        .entries()
                        .iter()
                        .rev()
                        .find(|entry| entry.contains(&needle))
                        .cloned();
                    self.search = None;
                    if let Some(text) = found {
                        self.set_input(&text);
                    }
                }
                KeyCode::Backspace => {
                    search.pop();
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    search.push(c)
                }
                _ => {}
            }
            return false;
        }
        if let Some(menu) = self.completion.as_mut() {
            match key.code {
                KeyCode::Tab => {
                    self.accept_completion();
                    return false;
                }
                KeyCode::Up | KeyCode::Down if key.modifiers.is_empty() => {
                    if !menu.candidates.is_empty() {
                        let count = menu.candidates.len();
                        menu.selected = if key.code == KeyCode::Down {
                            (menu.selected + 1) % count
                        } else {
                            (menu.selected + count - 1) % count
                        };
                    }
                    return false;
                }
                KeyCode::Esc => {
                    self.completion = None;
                    return false;
                }
                KeyCode::Char(_) | KeyCode::Backspace
                    if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT => {}
                _ => self.completion = None,
            }
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Tab => self.refresh_completion(workers),
            KeyCode::Char('q') if ctrl => return true,
            KeyCode::Char('d') if ctrl && self.input().is_empty() => return true,
            KeyCode::Char('c') if ctrl => {
                self.editor = TextArea::default();
                self.history_index = None;
                self.message = if self.state.busy() {
                    "Draft cleared; server evaluation continues".into()
                } else {
                    String::new()
                };
            }
            KeyCode::Char('j') if ctrl => {
                self.editor.insert_newline();
            }
            KeyCode::Char('g') if ctrl => self.actions = true,
            KeyCode::Char('r') if ctrl => self.search = Some(String::new()),
            KeyCode::Char('l') if ctrl => {
                self.state.clear();
                self.following = true;
            }
            KeyCode::Char('s') if ctrl => self.export(),
            KeyCode::Char('y') if ctrl => self.copy(),
            KeyCode::F(1) => self.help = true,
            KeyCode::F(2) => self.state.show_logs = !self.state.show_logs,
            KeyCode::F(3) => {
                self.state.severity = self.state.severity.next();
                self.message = format!("Log severity: {}", self.state.severity.label());
            }
            KeyCode::F(4) => self.raw = !self.raw,
            KeyCode::F(5) => self.expanded = !self.expanded,
            KeyCode::Esc => {
                self.following = true;
                self.horizontal = 0;
            }
            KeyCode::Up if alt => self.select(true),
            KeyCode::Down if alt => self.select(false),
            KeyCode::Left if alt => self.horizontal = self.horizontal.saturating_sub(8),
            KeyCode::Right if alt => self.horizontal = self.horizontal.saturating_add(8),
            KeyCode::PageUp => {
                self.anchor = None;
                self.scroll = self.scroll.saturating_sub(10);
                self.following = false;
            }
            KeyCode::PageDown => {
                self.anchor = None;
                self.scroll = self.scroll.saturating_add(10);
                self.following = false;
            }
            KeyCode::End if ctrl => {
                self.following = true;
                self.new_entries = 0;
            }
            KeyCode::Up if self.editor.cursor().0 == 0 => self.recall(true),
            KeyCode::Down if self.editor.cursor().0 + 1 == self.editor.lines().len() => {
                self.recall(false)
            }
            KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.editor.insert_newline();
            }
            KeyCode::Enter => {
                if self.input().trim() == ".exit" {
                    return true;
                }
                self.submit(workers);
            }
            _ => {
                self.editor.input(key);
            }
        }
        if self.completion.is_some() {
            self.refresh_completion(workers);
        }
        false
    }

    fn content(&self) -> Rendered {
        let mut lines = Vec::new();
        let mut ids = Vec::new();
        for entry in self.state.visible() {
            let start = lines.len();
            match &entry.kind {
                Kind::Evaluation {
                    code,
                    result,
                    elapsed_ms,
                } => {
                    let selected = Some(entry.id) == self.selected;
                    lines.push(Line::from(Span::styled(
                        format!(
                            "{} #{}  {}",
                            if selected { "▸" } else { " " },
                            entry.id,
                            if result.is_none() {
                                "running…".into()
                            } else {
                                format!("{elapsed_ms} ms")
                            }
                        ),
                        Style::default().fg(Color::DarkGray),
                    )));
                    for line in preview_lines(code, 40) {
                        lines.push(Line::from(Span::styled(
                            format!("  › {}", line),
                            Style::default().fg(Color::Cyan),
                        )));
                    }
                    lines.push(Line::default());
                }
                Kind::Log {
                    level,
                    text,
                    timestamp,
                } => {
                    let color = match level.as_str() {
                        "error" | "assert" => Color::Red,
                        "warn" | "warning" => Color::Yellow,
                        _ => Color::Gray,
                    };
                    let time = chrono::DateTime::from_timestamp_millis(*timestamp)
                        .map(|t| t.format("%H:%M:%S").to_string())
                        .unwrap_or_default();
                    for line in preview_lines(text, 40) {
                        lines.push(Line::from(Span::styled(
                            format!("{time} [{}] {}", value::safe_text(level), line),
                            Style::default().fg(color),
                        )));
                    }
                }
                Kind::Completion(id) => {
                    if let Some(entry) = self.state.entries.iter().find(|e| e.id == *id) {
                        if let Kind::Evaluation {
                            result, elapsed_ms, ..
                        } = &entry.kind
                        {
                            lines.push(Line::from(Span::styled(
                                format!("  ← #{id} • {elapsed_ms} ms"),
                                Style::default().fg(Color::DarkGray),
                            )));
                            match result {
                                Some(Ok(v)) => {
                                    lines.extend(value::render(v, self.raw, self.expanded))
                                }
                                Some(Err(e)) => lines.push(Line::from(Span::styled(
                                    format!("  Error: {}", value::safe_text(e)),
                                    Style::default().fg(Color::Red),
                                ))),
                                None => {}
                            }
                            lines.push(Line::default());
                        }
                    }
                }
                Kind::Notice(message) => lines.push(Line::from(Span::styled(
                    value::safe_text(message),
                    Style::default().fg(Color::Yellow),
                ))),
            }
            ids.extend(std::iter::repeat_n(entry.id, lines.len() - start));
        }
        Rendered { lines, ids }
    }

    #[cfg(test)]
    fn lines(&self) -> Vec<Line<'static>> {
        self.content().lines
    }

    fn draw(&mut self, frame: &mut Frame) {
        let input_height = (self.editor.lines().len().saturating_add(2).clamp(3, 10) as u16)
            .min(frame.area().height.saturating_sub(4).max(1));
        let [header, body, input, footer] = Layout::vertical([
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(input_height),
            Constraint::Length(if self.message.is_empty() { 2 } else { 3 }),
        ])
        .areas(frame.area());
        let running = self
            .started
            .map(|t| format!(" • running {:.1}s", t.elapsed().as_secs_f32()))
            .unwrap_or_default();
        frame.render_widget(
            Paragraph::new(format!(
                " SilverBullet • {} • {}{running}",
                value::safe_text(&self.target),
                if self.connected {
                    "connected"
                } else {
                    "connecting"
                }
            ))
            .style(Style::default().fg(Color::Cyan)),
            header,
        );
        if self.following {
            self.new_entries = 0;
            self.anchor = None;
        }
        if self.rendered.is_none() {
            self.rendered = Some(self.content());
        }
        let rendered = self.rendered.as_ref().unwrap();
        if let Some((id, offset)) = self.anchor.take() {
            self.scroll = rendered
                .ids
                .iter()
                .position(|other| *other == id)
                .map(|start| start + offset)
                .unwrap_or(0);
        }
        let lines = &rendered.lines;
        let max_scroll = lines.len().saturating_sub(body.height as usize);
        self.scroll = if self.following {
            max_scroll
        } else {
            self.scroll.min(max_scroll)
        };
        let visible: Vec<_> = lines
            .iter()
            .skip(self.scroll)
            .take(body.height as usize)
            .cloned()
            .collect();
        frame.render_widget(Paragraph::new(visible).scroll((0, self.horizontal)), body);
        let mode = if self.script { "Script" } else { "Lua" };
        self.editor
            .set_block(Block::default().borders(Borders::ALL).title(format!(
                " {mode} • Enter run • {} newline • Tab complete ",
                if self.shift_enter {
                    "Shift+Enter"
                } else {
                    "Ctrl+J"
                }
            )));
        self.editor.set_cursor_line_style(Style::default());
        frame.render_widget(&self.editor, input);
        let paused = if !self.following {
            format!(" • paused +{} (Ctrl+End follows)", self.new_entries)
        } else {
            String::new()
        };
        let key_style = Style::default().fg(Color::Cyan).bold();
        let mut footer_lines = vec![
            Line::from(vec![
                Span::styled(" Ctrl+G", key_style),
                Span::raw(" Actions · "),
                Span::styled("Ctrl+Q", key_style),
                Span::raw(" Quit"),
            ]),
            Line::styled(
                format!(
                    " Logs: {} · Output: {}{paused}",
                    if self.state.show_logs { "on" } else { "off" },
                    if self.raw { "JSON" } else { "Auto" },
                ),
                Style::default().fg(Color::DarkGray),
            ),
        ];
        if !self.message.is_empty() {
            footer_lines.push(Line::from(value::safe_text(&self.message)));
        }
        frame.render_widget(Paragraph::new(footer_lines), footer);
        if let Some(menu) = &self.completion {
            let height = 10.min(input.y);
            let area = Rect::new(
                input.x,
                input.y.saturating_sub(height),
                input.width.min(90),
                height,
            );
            let mut lines = vec![];
            if menu.candidates.is_empty() {
                lines.push(Line::from(
                    if self.completion_pending.contains(&menu.context.path) {
                        " Loading API names…"
                    } else {
                        " No matching names"
                    },
                ));
            } else {
                let selected = menu.selected.min(menu.candidates.len() - 1);
                for (index, candidate) in menu
                    .candidates
                    .iter()
                    .enumerate()
                    .skip(selected.saturating_sub(4))
                    .take(5)
                {
                    lines.push(Line::styled(
                        format!(
                            " {} {} {}",
                            if index == selected { "›" } else { " " },
                            candidate.name,
                            value::safe_text(&candidate.detail)
                        ),
                        if index == selected {
                            Style::default().fg(Color::Cyan).bold()
                        } else {
                            Style::default()
                        },
                    ));
                }
                lines.push(Line::from(value::safe_text(
                    &menu.candidates[selected].description,
                )));
            }
            lines.push(Line::from(" Tab accept · ↑↓ select · Esc close"));
            frame.render_widget(Clear, area);
            frame.render_widget(
                Paragraph::new(lines).block(Block::bordered().title(" API completion ")),
                area,
            );
        }
        if self.actions {
            let area = popup(frame.area(), 54, 9);
            frame.render_widget(Clear, area);
            let mut lines = vec![
                Line::from(" Release Ctrl, then press a letter:"),
                Line::default(),
            ];
            for (key, label) in [
                ("H", "Help".to_owned()),
                (
                    "L",
                    format!(
                        "Logs          {}",
                        if self.state.show_logs {
                            "on → off"
                        } else {
                            "off → on"
                        }
                    ),
                ),
                (
                    "J",
                    format!(
                        "Output        {}",
                        if self.raw {
                            "JSON → Auto"
                        } else {
                            "Auto → JSON"
                        }
                    ),
                ),
            ] {
                lines.push(Line::from(vec![
                    Span::styled(format!(" {key}  "), key_style),
                    Span::raw(label),
                ]));
            }
            lines.push(Line::default());
            lines.push(Line::from(" Esc  Close menu"));
            frame.render_widget(
                Paragraph::new(lines).block(Block::bordered().title(" Console actions ")),
                area,
            );
        }
        if self.help {
            let area = popup(frame.area(), 78, 22);
            frame.render_widget(Clear, area);
            frame.render_widget(Paragraph::new("Enter          Run input (single or multiline)\nShift+Enter    Insert newline (supported terminals)\nCtrl+J         Insert newline (fallback)\nCtrl+R         Search saved history\nTab            Complete API names; Tab accepts\n↑ / ↓          Recall history at input boundaries\nCtrl+G         Open actions; release Ctrl, then:\n  H / L / J    Help / toggle logs / Auto or JSON\nF3 / F5        Cycle severity / expand previews\nAlt+↑ / ↓      Select previous/next result\nAlt+← / →      Scroll output horizontally\nPageUp/Down    Scroll output; Ctrl+End follows\nCtrl+Y         Copy selected result as JSON (OSC 52)\nCtrl+S         Export selected result to a temporary JSON file\nCtrl+L         Clear transcript (keeps running evaluation)\nCtrl+C         Clear draft; does not cancel server work\nCtrl+Q         Quit\n.script / .auto / .timeout <seconds>\nAny key closes help").block(Block::bordered().title(" Console help ")), area);
        }
        if let Some(search) = &self.search {
            let area = popup(frame.area(), 76, 8);
            let found = self
                .history
                .entries()
                .iter()
                .rev()
                .find(|entry| entry.contains(search))
                .map(|s| value::safe_text(s))
                .unwrap_or_else(|| "No match".into());
            frame.render_widget(Clear, area);
            frame.render_widget(
                Paragraph::new(format!(
                    "Search: {}\n\n{}\n\nEnter recall • Esc cancel",
                    value::safe_text(search),
                    found
                ))
                .block(Block::bordered().title(" History ")),
                area,
            );
        }
    }
}

fn preview_lines(text: &str, limit: usize) -> Vec<String> {
    let mut source = text.split('\n');
    let mut lines: Vec<_> = source
        .by_ref()
        .take(limit)
        .map(|line| {
            let mut characters = line.chars();
            let prefix: String = characters.by_ref().take(2048).collect();
            let mut text = value::safe_text(&prefix);
            if characters.next().is_some() {
                text.push_str("… [truncated]");
            }
            text
        })
        .collect();
    if source.next().is_some() {
        lines.push("… [truncated]".into());
    }
    lines
}

fn popup(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect::new(
        area.x + (area.width - width) / 2,
        area.y + (area.height - height) / 2,
        width,
        height,
    )
}

pub fn run(conn: SpaceConnection) -> Result<(), String> {
    let workers = workers(&conn)?;
    let mut console = Console::new(&conn);
    let mut terminal = ratatui::try_init().map_err(|e| e.to_string())?;
    let enhanced = crossterm::terminal::supports_keyboard_enhancement().unwrap_or(false);
    let mut keyboard_pushed = false;
    let result = (|| -> Result<(), String> {
        if enhanced {
            execute!(
                io::stdout(),
                PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
            )
            .map_err(|e| e.to_string())?;
            keyboard_pushed = true;
            console.shift_enter = true;
        }
        execute!(io::stdout(), EnableBracketedPaste).map_err(|e| e.to_string())?;
        loop {
            for update in workers.updates.try_iter().take(64) {
                console.update(update);
            }
            if console.completion.is_some() {
                console.refresh_completion(&workers);
            }
            terminal
                .draw(|frame| console.draw(frame))
                .map_err(|e| e.to_string())?;
            if !event::poll(Duration::from_millis(50)).map_err(|e| e.to_string())? {
                continue;
            }
            match event::read().map_err(|e| e.to_string())? {
                Event::Key(key) if key.kind != event::KeyEventKind::Release => {
                    if console.key(key, &workers) {
                        break;
                    }
                }
                Event::Paste(text) => {
                    if console.input().len() + text.len() <= MAX_INPUT {
                        console.editor.insert_str(text);
                    } else {
                        console.message = "Paste exceeds 64 KiB input limit".into();
                    }
                }
                _ => {}
            }
        }
        Ok(())
    })();
    if keyboard_pushed {
        let _ = execute!(io::stdout(), PopKeyboardEnhancementFlags);
    }
    let _ = execute!(io::stdout(), DisableBracketedPaste);
    ratatui::restore();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{backend::TestBackend, Terminal};
    use serde_json::json;
    use std::sync::{atomic::AtomicBool, mpsc, Arc};

    fn console() -> Console {
        Console {
            state: State::default(),
            editor: TextArea::default(),
            history: History::default(),
            history_index: None,
            draft: String::new(),
            search: None,
            selected: None,
            raw: false,
            expanded: false,
            scroll: 0,
            horizontal: 0,
            following: true,
            new_entries: 0,
            help: false,
            actions: false,
            shift_enter: false,
            completion: None,
            completion_cache: HashMap::new(),
            completion_pending: HashSet::new(),
            completion_generation: 0,
            connected: true,
            target: "http://localhost:3000".into(),
            timeout: Duration::from_secs(30),
            script: false,
            started: None,
            message: String::new(),
            rendered: None,
            anchor: None,
        }
    }

    fn idle_workers() -> Workers {
        let (requests, _) = mpsc::sync_channel(1);
        let (_, updates) = mpsc::sync_channel(1);
        let (completions, _) = mpsc::sync_channel(1);
        Workers {
            completions,
            requests,
            updates,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    #[test]
    fn transcript_places_logs_before_the_result_that_arrived_later() {
        let mut console = console();
        let id = console.state.submit("answer()".into());
        console
            .state
            .log("info".into(), "during execution".into(), 0);
        console.state.complete(id, Ok(json!("finished")), 10);
        let lines = console.lines();
        let text: Vec<_> = lines.iter().map(|line| line.to_string()).collect();
        let log = text
            .iter()
            .position(|line| line.contains("during execution"))
            .unwrap();
        let result = text
            .iter()
            .position(|line| line.contains("finished"))
            .unwrap();
        assert!(log < result);
    }

    #[test]
    fn actions_menu_preserves_draft_and_consumes_selection() {
        let mut console = console();
        console.set_input("return 1");
        let workers = idle_workers();
        console.key(
            KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL),
            &workers,
        );
        console.key(
            KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE),
            &workers,
        );
        assert!(!console.state.show_logs);
        assert_eq!(console.input(), "return 1");
        console.key(
            KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL),
            &workers,
        );
        console.key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), &workers);
        console.key(
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
            &workers,
        );
        assert_eq!(console.input(), "return 1x");
    }

    #[test]
    fn completion_caches_namespace_and_preserves_text_after_the_cursor() {
        let mut console = console();
        console.set_input("return index.qu(2)");
        console
            .editor
            .move_cursor(ratatui_textarea::CursorMove::Jump(0, 15));
        let (completions, receive) = mpsc::sync_channel(1);
        let mut workers = idle_workers();
        workers.completions = completions;
        console.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &workers);
        let request = receive.try_recv().unwrap();
        assert_eq!(request.path, vec!["index"]);
        console.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &workers);
        assert!(console.completion.is_some());
        assert!(receive.try_recv().is_err());
        console.update(Update::Completion {
            generation: request.generation,
            path: request.path,
            result: Ok(json!({"properties":[{"key":"query", "type":"function"}]})),
        });
        console.refresh_completion(&workers);
        console.key(
            KeyEvent::new(KeyCode::Char('e'), KeyModifiers::NONE),
            &workers,
        );
        assert!(receive.try_recv().is_err());
        console.key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE), &workers);
        assert_eq!(console.input(), "return index.query(2)");
        assert_eq!(console.editor.cursor().1, 18);
        assert!(console.completion.is_none());
    }

    #[test]
    fn stale_completion_does_not_restore_cache_after_evaluation() {
        let mut console = console();
        console.update(Update::Gap);
        console.update(Update::Completion {
            generation: 0,
            path: vec![],
            result: Ok(json!({"properties":[{"key":"old", "type":"table"}]})),
        });
        assert!(console.completion_cache.is_empty());
    }

    #[test]
    fn enter_submits_multiline_and_shift_enter_only_inserts_newline() {
        let mut console = console();
        console.set_input("return 1");
        let (requests, receive) = mpsc::sync_channel(1);
        let (_, updates) = mpsc::sync_channel(1);
        let (completions, _) = mpsc::sync_channel(1);
        let workers = Workers {
            completions,
            requests,
            updates,
            stop: Arc::new(AtomicBool::new(false)),
        };
        console.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT), &workers);
        assert_eq!(console.input(), "return 1\n");
        assert!(receive.try_recv().is_err());
        console.key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), &workers);
        assert_eq!(receive.try_recv().unwrap().code, "return 1\n");
        assert_eq!(console.input(), "");
    }

    #[test]
    fn newline_shortcut_preserves_existing_input() {
        let mut console = console();
        console.editor.insert_str("return 1");
        console.key(
            KeyEvent::new(KeyCode::Char('j'), KeyModifiers::CONTROL),
            &idle_workers(),
        );
        assert_eq!(console.input(), "return 1\n");
    }

    #[test]
    fn history_preserves_multiline_trailing_blank_lines() {
        let mut console = console();
        console.history.push("return 1\n\n").unwrap();
        console.recall(true);
        assert_eq!(console.input(), "return 1\n\n");
    }

    #[test]
    fn paused_counter_counts_log_entries() {
        let mut console = console();
        console.following = false;
        console.update(Update::Logs(vec![
            crate::api::LogEntry {
                level: "info".into(),
                text: "one".into(),
                timestamp: 0,
            },
            crate::api::LogEntry {
                level: "info".into(),
                text: "two".into(),
                timestamp: 0,
            },
        ]));
        assert_eq!(console.new_entries, 2);
    }

    #[test]
    fn a_large_log_cannot_expand_into_an_unbounded_transcript() {
        let mut console = console();
        console
            .state
            .log("info".into(), "line\n".repeat(100_000), 0);
        assert!(console.lines().len() <= 50);
        let lines = console.lines();
        assert!(lines
            .iter()
            .any(|line| line.to_string().contains("truncated")));
    }

    #[test]
    fn paused_viewport_stays_on_same_log_when_older_entries_expire() {
        let mut console = console();
        for i in 0..1000 {
            console.state.log("info".into(), format!("log-{i:04}"), 0);
        }
        console.following = false;
        console.scroll = 500;
        let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
        terminal.draw(|f| console.draw(f)).unwrap();
        let before: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .skip(80)
            .take(80)
            .map(|c| c.symbol())
            .collect();
        console.key(
            KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE),
            &idle_workers(),
        );
        console.update(Update::Logs(
            (1000..1010)
                .map(|i| crate::api::LogEntry {
                    level: "info".into(),
                    text: format!("log-{i:04}"),
                    timestamp: 0,
                })
                .collect(),
        ));
        terminal.draw(|f| console.draw(f)).unwrap();
        let after: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .skip(80)
            .take(80)
            .map(|c| c.symbol())
            .collect();
        assert_eq!(before, after);
    }

    #[test]
    fn logs_and_results_do_not_change_draft() {
        let mut console = console();
        console.editor.insert_str("unfinished(");
        let id = console.state.submit("1+1".into());
        console.update(Update::Logs(vec![crate::api::LogEntry {
            level: "warn".into(),
            text: "example warning".into(),
            timestamp: 0,
        }]));
        console.update(Update::Result(id, Ok(json!(2)), 30));
        assert_eq!(console.input(), "unfinished(");
        assert!(!console.state.busy());
    }

    #[test]
    fn history_recall_restores_draft_and_places_cursor_at_end() {
        let mut console = console();
        console.history.push("return 1").unwrap();
        console.editor.insert_str("draft");
        console.recall(true);
        assert_eq!(console.input(), "return 1");
        assert_eq!(console.editor.cursor(), (0, 8));
        console.recall(false);
        assert_eq!(console.input(), "draft");
    }

    #[test]
    fn frame_shows_table_and_fixed_editor_while_filtering_logs() {
        let mut console = console();
        let id = console.state.submit("items()".into());
        console
            .state
            .complete(id, Ok(json!([{"name":"Oak", "count":2}])), 10);
        console.state.log("info".into(), "hidden log".into(), 0);
        console.state.show_logs = false;
        console.editor.insert_str("draft");
        let mut terminal = Terminal::new(TestBackend::new(90, 24)).unwrap();
        terminal.draw(|f| console.draw(f)).unwrap();
        let text: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        assert!(text.contains("Oak"));
        assert!(text.contains("count"));
        assert!(text.contains("draft"));
        assert!(!text.contains("hidden log"));
        for (width, height) in [(1, 1), (8, 3), (20, 8)] {
            terminal.backend_mut().resize(width, height);
            terminal.resize(Rect::new(0, 0, width, height)).unwrap();
            terminal.draw(|f| console.draw(f)).unwrap();
        }
    }
}
