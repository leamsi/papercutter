use crate::conn::SpaceConnection;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};

pub(super) struct Request {
    pub(super) id: u64,
    pub(super) code: String,
    pub(super) timeout: Duration,
    pub(super) script: bool,
}
pub(super) struct CompletionRequest {
    pub(super) generation: u64,
    pub(super) path: Vec<String>,
}

pub(super) enum Update {
    Result(u64, Result<Value, String>, u128),
    Completion {
        generation: u64,
        path: Vec<String>,
        result: Result<Value, String>,
    },
    Logs(Vec<crate::api::LogEntry>),
    Connection(Result<(), String>),
    Gap,
}

pub(super) struct Workers {
    pub(super) stop: Arc<AtomicBool>,
    pub(super) requests: mpsc::SyncSender<Request>,
    pub(super) completions: mpsc::SyncSender<CompletionRequest>,
    pub(super) updates: mpsc::Receiver<Update>,
}

impl Drop for Workers {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn connection(conn: &SpaceConnection, timeout: Duration) -> Result<SpaceConnection, String> {
    Ok(SpaceConnection {
        client: crate::conn::new_client(timeout)?,
        base_url: conn.base_url.clone(),
        auth: conn.auth.clone(),
        timeout,
    })
}

pub(super) fn workers(conn: &SpaceConnection) -> Result<Workers, String> {
    let eval = connection(conn, conn.timeout)?;
    let logs = connection(conn, Duration::from_secs(5))?;
    let inspection = connection(conn, Duration::from_secs(5))?;
    let (requests, receive) = mpsc::sync_channel::<Request>(1);
    let (completions, receive_completions) = mpsc::sync_channel::<CompletionRequest>(1);
    let (send, updates) = mpsc::sync_channel(64);
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let output = send.clone();
    std::thread::spawn(move || {
        while let Ok(request) = receive.recv() {
            if stopped.load(Ordering::Relaxed) {
                break;
            }
            let start = Instant::now();
            let result = connection(&eval, request.timeout).and_then(|conn| {
                if request.script {
                    conn.eval_lua_script(&request.code)
                } else {
                    conn.eval_lua_repl(&request.code)
                }
            });
            if output
                .send(Update::Result(
                    request.id,
                    result,
                    start.elapsed().as_millis(),
                ))
                .is_err()
            {
                break;
            }
        }
    });
    let stopped = stop.clone();
    let output = send.clone();
    std::thread::spawn(move || {
        while let Ok(request) = receive_completions.recv() {
            if stopped.load(Ordering::Relaxed) {
                break;
            }
            let result = inspection.inspect_lua_path(&request.path);
            if output
                .send(Update::Completion {
                    generation: request.generation,
                    path: request.path,
                    result,
                })
                .is_err()
            {
                break;
            }
        }
    });
    let stopped = stop.clone();
    std::thread::spawn(move || {
        let mut cursor = None;
        let mut previous = HashMap::new();
        let mut connected = None;
        while !stopped.load(Ordering::Relaxed) {
            match logs.log_batch(cursor.as_deref()) {
                Ok(batch) => {
                    if connected != Some(true) && send.send(Update::Connection(Ok(()))).is_err() {
                        break;
                    }
                    connected = Some(true);
                    if batch.dropped && send.send(Update::Gap).is_err() {
                        break;
                    }
                    let entries = if batch.cursor.is_some() {
                        batch.entries
                    } else {
                        let mut current = HashMap::new();
                        let mut fresh = Vec::new();
                        for entry in batch.entries {
                            let key = (entry.timestamp, entry.level.clone(), entry.text.clone());
                            let count = current.entry(key.clone()).or_insert(0usize);
                            *count += 1;
                            if *count > previous.get(&key).copied().unwrap_or(0) {
                                fresh.push(entry);
                            }
                        }
                        previous = current;
                        fresh
                    };
                    cursor = batch.cursor;
                    if !entries.is_empty() && send.send(Update::Logs(entries)).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    if connected != Some(false)
                        && send.send(Update::Connection(Err(error))).is_err()
                    {
                        break;
                    }
                    connected = Some(false);
                }
            }
            for _ in 0..10 {
                if stopped.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    });
    Ok(Workers {
        stop,
        requests,
        completions,
        updates,
    })
}
