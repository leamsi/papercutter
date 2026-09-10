use std::collections::VecDeque;

use serde_json::Value;

const MAX_ENTRIES: usize = 1000;
const MAX_BYTES: usize = 16 * 1024 * 1024;

pub enum Kind {
    Evaluation {
        code: String,
        result: Option<Result<Value, String>>,
        elapsed_ms: u128,
    },
    Log {
        level: String,
        text: String,
        timestamp: i64,
    },
    Notice(String),
    Completion(u64),
}

pub struct Entry {
    pub id: u64,
    pub kind: Kind,
    bytes: usize,
}

#[derive(Default, Clone, Copy)]
pub enum Severity {
    #[default]
    All,
    Warnings,
    Errors,
}

impl Severity {
    pub fn next(self) -> Self {
        match self {
            Self::All => Self::Warnings,
            Self::Warnings => Self::Errors,
            Self::Errors => Self::All,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Warnings => "warn+",
            Self::Errors => "errors",
        }
    }
}

pub struct State {
    pub entries: VecDeque<Entry>,
    pub show_logs: bool,
    pub severity: Severity,
    next_id: u64,
    bytes: usize,
}

impl Default for State {
    fn default() -> Self {
        Self {
            entries: VecDeque::new(),
            show_logs: true,
            severity: Severity::All,
            next_id: 1,
            bytes: 0,
        }
    }
}

impl State {
    fn push(&mut self, kind: Kind) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        let bytes = kind_size(&kind);
        self.bytes += bytes;
        self.entries.push_back(Entry { id, kind, bytes });
        self.trim();
        id
    }

    pub fn submit(&mut self, code: String) -> u64 {
        self.push(Kind::Evaluation {
            code,
            result: None,
            elapsed_ms: 0,
        })
    }

    pub fn complete(&mut self, id: u64, result: Result<Value, String>, elapsed_ms: u128) {
        if let Some(entry) = self.entries.iter_mut().find(|entry| entry.id == id) {
            if let Kind::Evaluation {
                result: current,
                elapsed_ms: duration,
                ..
            } = &mut entry.kind
            {
                *current = Some(result);
                *duration = elapsed_ms;
                self.bytes -= entry.bytes;
                entry.bytes = kind_size(&entry.kind);
                self.bytes += entry.bytes;
            }
        }
        if self.entries.iter().any(|e| e.id == id) {
            self.push(Kind::Completion(id));
        }
        self.trim();
    }

    fn trim(&mut self) {
        while self.entries.len() > MAX_ENTRIES || self.bytes > MAX_BYTES {
            let Some(index) = self
                .entries
                .iter()
                .position(|entry| !matches!(entry.kind, Kind::Evaluation { .. }))
            else {
                break;
            };
            if let Some(entry) = self.entries.remove(index) {
                self.bytes -= entry.bytes;
                if let Kind::Completion(id) = entry.kind {
                    if let Some(index) = self.entries.iter().position(|e| e.id == id) {
                        self.bytes -= self.entries.remove(index).unwrap().bytes;
                    }
                }
            }
        }
    }

    pub fn log(&mut self, level: String, text: String, timestamp: i64) {
        self.push(Kind::Log {
            level: level.to_ascii_lowercase(),
            text,
            timestamp,
        });
    }

    pub fn notice(&mut self, text: impl Into<String>) {
        self.push(Kind::Notice(text.into()));
    }

    pub fn busy(&self) -> bool {
        self.entries
            .iter()
            .any(|e| matches!(e.kind, Kind::Evaluation { result: None, .. }))
    }

    pub fn visible(&self) -> impl Iterator<Item = &Entry> {
        self.entries.iter().filter(|entry| match &entry.kind {
            Kind::Log { level, .. } => {
                self.show_logs
                    && match self.severity {
                        Severity::All => true,
                        Severity::Warnings => {
                            matches!(level.as_str(), "warn" | "warning" | "error" | "assert")
                        }
                        Severity::Errors => matches!(level.as_str(), "error" | "assert"),
                    }
            }
            Kind::Completion(id) => self.entries.iter().any(|e| e.id == *id),
            _ => true,
        })
    }

    pub fn clear(&mut self) {
        self.entries
            .retain(|e| matches!(e.kind, Kind::Evaluation { result: None, .. }));
        self.bytes = self.entries.iter().map(|e| e.bytes).sum();
    }
}

fn kind_size(kind: &Kind) -> usize {
    match kind {
        Kind::Evaluation { code, result, .. } => {
            code.len()
                + match result {
                    Some(Ok(value)) => value_size(value),
                    Some(Err(error)) => error.len(),
                    None => 0,
                }
        }
        Kind::Log { text, level, .. } => text.len() + level.len(),
        Kind::Notice(text) => text.len(),
        Kind::Completion(_) => 0,
    }
}

fn value_size(value: &Value) -> usize {
    std::mem::size_of::<Value>()
        + match value {
            Value::String(text) => text.len(),
            Value::Array(values) => values.iter().map(value_size).sum(),
            Value::Object(values) => values
                .iter()
                .map(|(key, value)| key.len() + value_size(value))
                .sum(),
            _ => 0,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn completion_updates_its_submission_without_reordering_logs() {
        let mut state = State::default();
        let id = state.submit("1 + 1".into());
        state.log("info".into(), "background".into(), 0);
        state.complete(id, Ok(json!(2)), 12);
        assert!(
            matches!(&state.entries[0].kind, Kind::Evaluation { result: Some(Ok(v)), .. } if v == &json!(2))
        );
        assert!(matches!(state.entries[1].kind, Kind::Log { .. }));
        assert!(!state.busy());
    }

    #[test]
    fn filters_accept_chrome_console_level_names() {
        let mut state = State::default();
        state.log("Warning".into(), "warning".into(), 0);
        state.log("Error".into(), "error".into(), 0);
        state.log("Log".into(), "ordinary".into(), 0);
        state.severity = Severity::Warnings;
        assert_eq!(state.visible().count(), 2);
        state.severity = Severity::Errors;
        assert_eq!(state.visible().count(), 1);
    }

    #[test]
    fn filters_never_hide_execution_errors() {
        let mut state = State::default();
        let id = state.submit("bad()".into());
        state.complete(id, Err("failed".into()), 1);
        state.log("info".into(), "quiet".into(), 0);
        state.log("warn".into(), "warning".into(), 0);
        state.severity = Severity::Errors;
        assert_eq!(state.visible().count(), 2);
        state.show_logs = false;
        assert_eq!(state.visible().count(), 2);
    }

    #[test]
    fn transcript_is_bounded_and_keeps_pending_evaluation() {
        let mut state = State::default();
        let id = state.submit("slow()".into());
        for i in 0..MAX_ENTRIES + 10 {
            state.log("info".into(), i.to_string(), 0);
        }
        assert!(state.entries.len() <= MAX_ENTRIES);
        state.complete(id, Ok(json!(true)), 5);
        assert!(!state.busy());
        assert!(state.entries.iter().any(|e| e.id == id));
    }
}

#[cfg(test)]
mod limits_tests {
    use super::*;

    #[test]
    fn transcript_evicts_large_entries_by_size_not_only_count() {
        let mut state = State::default();
        for _ in 0..40 {
            let id = state.submit("large()".into());
            state.complete(id, Ok(Value::String("x".repeat(1_000_000))), 1);
        }
        assert!(state.entries.len() < 40);
    }
}
