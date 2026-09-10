//! Console-log ring buffer shared between a `ClientTransport` (which pushes
//! captured console output) and the `ClientRuntime` (which serves it via
//! `/.runtime/logs`). The standalone server hosts a single space, so this is a
//! single bounded buffer (no per-space keying — that lives in the App).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// A captured console log entry. Field names form the `/.runtime/logs` wire
/// contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogEntry {
    pub level: String,
    pub text: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LogBatch {
    pub entries: Vec<LogEntry>,
    pub cursor: Option<String>,
    pub dropped: bool,
}

const MAX_LOG_ENTRIES: usize = 1000;

#[derive(Clone)]
struct SequencedLogEntry {
    sequence: u64,
    entry: LogEntry,
}

struct LogState {
    generation: String,
    sequence: u64,
    entries: VecDeque<SequencedLogEntry>,
}

/// A cloneable, thread-safe bounded ring buffer of log entries. Clones share
/// the same underlying buffer (so the transport and the runtime see one log).
#[derive(Clone)]
pub struct LogBuffer {
    inner: Arc<Mutex<LogState>>,
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(LogState {
                generation: uuid::Uuid::new_v4().to_string(),
                sequence: 0,
                entries: VecDeque::new(),
            })),
        }
    }
}

impl LogBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append an entry, evicting the oldest once `MAX_LOG_ENTRIES` is reached.
    pub fn push(&self, entry: LogEntry) {
        let mut state = self.inner.lock().unwrap();
        state.sequence += 1;
        let sequence = state.sequence;
        if state.entries.len() >= MAX_LOG_ENTRIES {
            state.entries.pop_front();
        }
        state
            .entries
            .push_back(SequencedLogEntry { sequence, entry });
    }

    /// Return entries, optionally only those strictly newer than `since`
    /// (timestamp), capped to the most recent `limit`.
    pub fn query(&self, limit: usize, since: Option<i64>) -> Vec<LogEntry> {
        let state = self.inner.lock().unwrap();
        let filtered: Vec<LogEntry> = state
            .entries
            .iter()
            .filter(|e| since.is_none_or(|s| e.entry.timestamp > s))
            .map(|e| e.entry.clone())
            .collect();
        if limit < filtered.len() {
            filtered[filtered.len() - limit..].to_vec()
        } else {
            filtered
        }
    }

    pub fn query_batch(&self, limit: usize, cursor: Option<&str>) -> LogBatch {
        let state = self.inner.lock().unwrap();
        let requested = cursor.and_then(parse_cursor);
        let cursor_matches = requested
            .as_ref()
            .is_some_and(|(generation, _)| generation == &state.generation);
        let requested_sequence = requested
            .as_ref()
            .filter(|_| cursor_matches)
            .map(|(_, sequence)| *sequence);
        let mut dropped = cursor.is_some() && requested_sequence.is_none();
        if requested_sequence.is_some_and(|sequence| sequence > state.sequence) {
            dropped = true;
        }
        let start_sequence = requested_sequence.filter(|sequence| *sequence <= state.sequence);
        if let (Some(sequence), Some(first)) = (start_sequence, state.entries.front()) {
            if sequence.saturating_add(1) < first.sequence {
                dropped = true;
            }
        }
        let mut entries: Vec<LogEntry> = state
            .entries
            .iter()
            .filter(|entry| start_sequence.is_none_or(|sequence| entry.sequence > sequence))
            .map(|entry| entry.entry.clone())
            .collect();
        if limit > 0 && entries.len() > limit {
            if cursor.is_some() {
                dropped = true;
            }
            entries = entries.split_off(entries.len() - limit);
        }
        LogBatch {
            entries,
            cursor: Some(format_cursor(&state.generation, state.sequence)),
            dropped,
        }
    }
}

fn format_cursor(generation: &str, sequence: u64) -> String {
    format!("{generation}:{sequence}")
}

fn parse_cursor(cursor: &str) -> Option<(String, u64)> {
    let (generation, sequence) = cursor.rsplit_once(':')?;
    Some((generation.to_string(), sequence.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(text: &str, ts: i64) -> LogEntry {
        LogEntry {
            level: "log".into(),
            text: text.into(),
            timestamp: ts,
        }
    }

    #[test]
    fn push_and_query_roundtrip() {
        let buf = LogBuffer::new();
        buf.push(entry("a", 1));
        buf.push(entry("b", 2));
        let all = buf.query(100, None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].text, "a");
        assert_eq!(all[1].text, "b");
    }

    #[test]
    fn since_filters_strictly_newer() {
        let buf = LogBuffer::new();
        buf.push(entry("a", 1));
        buf.push(entry("b", 2));
        buf.push(entry("c", 3));
        let newer = buf.query(100, Some(2));
        assert_eq!(newer.len(), 1);
        assert_eq!(newer[0].text, "c");
    }

    #[test]
    fn limit_returns_the_most_recent() {
        let buf = LogBuffer::new();
        for i in 0..5 {
            buf.push(entry(&format!("e{i}"), i));
        }
        let last2 = buf.query(2, None);
        assert_eq!(last2.len(), 2);
        assert_eq!(last2[0].text, "e3");
        assert_eq!(last2[1].text, "e4");
    }

    #[test]
    fn ring_evicts_oldest_past_capacity() {
        let buf = LogBuffer::new();
        for i in 0..(MAX_LOG_ENTRIES as i64 + 10) {
            buf.push(entry("x", i));
        }
        let all = buf.query(usize::MAX, None);
        assert_eq!(all.len(), MAX_LOG_ENTRIES);
        assert_eq!(all.first().unwrap().timestamp, 10);
    }

    #[test]
    fn clones_share_one_buffer() {
        let a = LogBuffer::new();
        let b = a.clone();
        a.push(entry("shared", 1));
        assert_eq!(b.query(100, None).len(), 1);
    }

    #[test]
    fn cursor_distinguishes_entries_with_the_same_timestamp() {
        let buf = LogBuffer::new();
        buf.push(entry("first", 7));
        let initial = buf.query_batch(100, None);
        let cursor = initial.cursor.unwrap();

        buf.push(entry("second", 7));
        let next = buf.query_batch(100, Some(&cursor));

        assert_eq!(next.entries, vec![entry("second", 7)]);
        assert!(!next.dropped);
    }

    #[test]
    fn cursor_reports_entries_evicted_before_the_next_read() {
        let buf = LogBuffer::new();
        buf.push(entry("before", 1));
        let cursor = buf.query_batch(100, None).cursor.unwrap();
        for i in 0..=MAX_LOG_ENTRIES {
            buf.push(entry(&format!("after-{i}"), 2));
        }

        let next = buf.query_batch(usize::MAX, Some(&cursor));

        assert!(next.dropped);
        assert_eq!(next.entries.len(), MAX_LOG_ENTRIES);
        assert_eq!(next.entries.first().unwrap().text, "after-1");
    }

    #[test]
    fn cursor_reports_a_new_buffer_generation() {
        let old = LogBuffer::new();
        old.push(entry("old", 1));
        let cursor = old.query_batch(100, None).cursor.unwrap();
        let restarted = LogBuffer::new();
        restarted.push(entry("new", 2));

        let next = restarted.query_batch(100, Some(&cursor));

        assert!(next.dropped);
        assert_eq!(next.entries, vec![entry("new", 2)]);
    }
}
