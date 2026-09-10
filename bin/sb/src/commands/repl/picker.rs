use std::io::{self, IsTerminal};
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::{
    layout::{Constraint, Layout},
    style::{Color, Style},
    widgets::{Block, List, ListItem, ListState, Paragraph},
};

use crate::{
    cli::GlobalFlags,
    config::{self, Config},
};

use super::value::safe_text;

pub(super) fn needs_choice(flags: &GlobalFlags, cfg: &Config, interactive: bool) -> bool {
    interactive
        && flags.url.is_none()
        && flags.space.is_none()
        && flags.selected_space_id.is_none()
        && cfg.spaces.len() > 1
}

pub fn prepare(flags: &mut GlobalFlags) -> Result<bool, String> {
    if flags.url.is_some() || flags.space.is_some() || flags.selected_space_id.is_some() {
        return Ok(true);
    }
    let cfg = config::load()?;
    if !needs_choice(
        flags,
        &cfg,
        io::stdin().is_terminal() && io::stdout().is_terminal(),
    ) {
        return Ok(true);
    }
    let mut terminal = ratatui::try_init().map_err(|e| e.to_string())?;
    let result: Result<Option<String>, String> = (|| {
        let mut selected = ListState::default().with_selected(Some(0));
        loop {
            terminal
                .draw(|frame| {
                    let [title, list, hint] = Layout::vertical([
                        Constraint::Length(2),
                        Constraint::Min(1),
                        Constraint::Length(1),
                    ])
                    .areas(frame.area());
                    frame.render_widget(
                        Paragraph::new(" Choose a space for the Lua console")
                            .style(Style::default().fg(Color::Cyan)),
                        title,
                    );
                    let items = cfg
                        .spaces
                        .iter()
                        .map(|space| {
                            let location = if space.url.is_empty() {
                                &space.folder_path
                            } else {
                                &space.url
                            };
                            ListItem::new(format!(
                                "{}\n  {}",
                                safe_text(&space.name),
                                safe_text(location)
                            ))
                        })
                        .collect::<Vec<_>>();
                    frame.render_stateful_widget(
                        List::new(items)
                            .block(Block::bordered().title(" Spaces "))
                            .highlight_symbol("› ")
                            .highlight_style(Style::default().fg(Color::Cyan).bold()),
                        list,
                        &mut selected,
                    );
                    frame.render_widget(
                        Paragraph::new(" ↑/↓ choose · Enter connect · Esc cancel"),
                        hint,
                    );
                })
                .map_err(|e| e.to_string())?;
            if !event::poll(Duration::from_millis(100)).map_err(|e| e.to_string())? {
                continue;
            }
            let Event::Key(key) = event::read().map_err(|e| e.to_string())? else {
                continue;
            };
            if key.kind == KeyEventKind::Release {
                continue;
            }
            let index = selected.selected().unwrap_or(0);
            match key.code {
                KeyCode::Esc => return Ok(None),
                KeyCode::Char('c' | 'd' | 'q') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    return Ok(None)
                }
                KeyCode::Up => {
                    selected.select(Some((index + cfg.spaces.len() - 1) % cfg.spaces.len()))
                }
                KeyCode::Down => selected.select(Some((index + 1) % cfg.spaces.len())),
                KeyCode::Home => selected.select(Some(0)),
                KeyCode::End => selected.select(Some(cfg.spaces.len() - 1)),
                KeyCode::Enter => return Ok(Some(cfg.spaces[index].id.clone())),
                _ => {}
            }
        }
    })();
    ratatui::restore();
    match result? {
        Some(id) => {
            flags.selected_space_id = Some(id);
            Ok(true)
        }
        None => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    #[test]
    fn only_ambiguous_interactive_connections_need_a_picker() {
        let mut cfg = Config::default();
        let mut flags = crate::cli::Cli::parse_from(["sb", "repl"]).global;
        assert!(!needs_choice(&flags, &cfg, true));
        cfg.spaces.push(config::SpaceConfig::default());
        assert!(!needs_choice(&flags, &cfg, true));
        cfg.spaces.push(config::SpaceConfig::default());
        assert!(needs_choice(&flags, &cfg, true));
        assert!(!needs_choice(&flags, &cfg, false));
        flags.space = Some("chosen".into());
        assert!(!needs_choice(&flags, &cfg, true));
        flags.space = None;
        flags.url = Some("http://localhost:3000".into());
        assert!(!needs_choice(&flags, &cfg, true));
    }
}
