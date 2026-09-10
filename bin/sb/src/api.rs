//! Runtime HTTP calls against a SilverBullet Rust server.
//!
//! All methods live on [`crate::conn::SpaceConnection`].  The Rust server
//! wraps eval responses in a `{ "result": <value> }` / `{ "error": <msg> }`
//! envelope (see `docs/Runtime API.md`) — see the per-method docs for exact
//! response shapes.

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;

use crate::conn::{self, SpaceConnection};

/// A single console log entry from `/.runtime/logs`.
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

const MAX_EVAL_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LOG_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;
const LUA_MODE_HEADER: &str = "X-SilverBullet-Lua-Mode";
const LUA_MODES_HEADER: &str = "X-SilverBullet-Lua-Modes";

fn read_response(
    response: reqwest::blocking::Response,
    max_bytes: u64,
    description: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    response
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("reading {description}: {e}"))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{description} exceeded {max_bytes} bytes"));
    }
    Ok(bytes)
}

fn runtime_error(status: StatusCode, body: &[u8]) -> String {
    if status == StatusCode::UNAUTHORIZED || status.is_redirection() {
        return "authentication required; run `sb space login <name>` for a saved browser connection, or provide --token.".into();
    }
    if let Ok(text) = std::str::from_utf8(body) {
        if let Ok(v) = serde_json::from_str::<Value>(text) {
            if let Some(msg) = v.get("error").and_then(|e| e.as_str()) {
                return msg.to_string();
            }
        }
        return format!("server returned {}: {text}", status.as_u16());
    }
    format!("server returned {}", status.as_u16())
}

impl SpaceConnection {
    fn post_runtime(
        &self,
        path: &str,
        body: &str,
        lua_mode: Option<&str>,
    ) -> Result<Value, String> {
        let url = format!("{}{path}", self.base_url);
        let req = self
            .client
            .post(&url)
            .header("Content-Type", "text/plain")
            .header("X-Timeout", self.timeout.as_secs().to_string())
            .body(body.to_string());
        let req = if let Some(mode) = lua_mode {
            req.header(LUA_MODE_HEADER, mode)
        } else {
            req
        };
        let req = self.apply_auth(req);
        let resp = req.send().map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        let bytes = read_response(resp, MAX_EVAL_RESPONSE_BYTES, "runtime response")?;

        if status.is_success() {
            // On 200, the body is the `{ "result": <value> }` envelope (Core's
            // runtime handlers wrap eval results; see `docs/Runtime API.md`).
            // A Lua-level failure arrives as `{ "error": <msg> }`.
            let v: Value = serde_json::from_slice(&bytes)
                .map_err(|e| format!("parsing response JSON: {e}"))?;
            if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                return Err(err.to_string());
            }
            Ok(v.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(runtime_error(status, &bytes))
        }
    }

    /// Evaluate a Lua expression via `POST /.runtime/lua`.
    pub fn eval_lua(&self, expr: &str) -> Result<Value, String> {
        self.post_runtime("/.runtime/lua", expr, None)
    }

    pub fn inspect_lua_path(&self, path: &[String]) -> Result<Value, String> {
        if path.is_empty() {
            return self.eval_lua("lua.inspect()");
        }
        for key in path {
            let mut bytes = key.bytes();
            if !bytes
                .next()
                .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
                || !bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
            {
                return Err("inspection path must contain only ASCII Lua identifiers".into());
            }
        }
        let keys = path
            .iter()
            .map(|key| format!("\"{key}\""))
            .collect::<Vec<_>>()
            .join(",");
        self.eval_lua(&format!("lua.inspect({{{keys}}})"))
    }

    /// Execute a Lua script via `POST /.runtime/lua_script`.
    pub fn eval_lua_script(&self, code: &str) -> Result<Value, String> {
        self.post_runtime("/.runtime/lua_script", code, None)
    }

    pub fn eval_lua_repl(&self, code: &str) -> Result<Value, String> {
        let url = format!("{}/.runtime/logs", self.base_url);
        let req = self
            .apply_auth(self.client.get(&url))
            .query(&[("limit", "1")]);
        let response = req.send().map_err(|e| format!("request failed: {e}"))?;
        let status = response.status();
        let supports_repl = response
            .headers()
            .get(LUA_MODES_HEADER)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|modes| modes.split(',').any(|mode| mode.trim() == "repl"));
        let body = read_response(
            response,
            MAX_LOG_RESPONSE_BYTES,
            "runtime capability response",
        )?;
        if !status.is_success() {
            return Err(runtime_error(status, &body));
        }
        if !supports_repl {
            return Err("server does not support safe automatic Lua evaluation".into());
        }
        self.post_runtime("/.runtime/lua_script", code, Some("repl"))
    }

    /// Fetch console logs via `GET /.runtime/logs`.
    pub fn logs(&self, limit: usize, since: Option<i64>) -> Result<Vec<LogEntry>, String> {
        Ok(self.get_log_batch(limit, since, None)?.entries)
    }

    pub fn log_batch(&self, cursor: Option<&str>) -> Result<LogBatch, String> {
        self.get_log_batch(1000, None, cursor)
    }

    fn get_log_batch(
        &self,
        limit: usize,
        since: Option<i64>,
        cursor: Option<&str>,
    ) -> Result<LogBatch, String> {
        let url = format!("{}/.runtime/logs", self.base_url);
        let mut req = self.client.get(&url);
        if limit > 0 {
            req = req.query(&[("limit", limit.to_string())]);
        }
        if let Some(s) = since {
            if s > 0 {
                req = req.query(&[("since", s.to_string())]);
            }
        }
        if let Some(cursor) = cursor {
            req = req.query(&[("cursor", cursor)]);
        }
        let req = self.apply_auth(req);
        let resp = req.send().map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        let bytes = read_response(resp, MAX_LOG_RESPONSE_BYTES, "logs response")?;

        if status == StatusCode::UNAUTHORIZED || (status.as_u16() >= 300 && status.as_u16() < 400) {
            return Err(
                "authentication required; run `sb space login <name>`, use --token, or configure a space with 'space add'"
                    .to_string(),
            );
        }
        if !status.is_success() {
            return Err(runtime_error(status, &bytes));
        }

        #[derive(Deserialize)]
        struct LogsResponse {
            logs: Vec<LogEntry>,
            #[serde(default)]
            cursor: Option<String>,
            #[serde(default)]
            dropped: bool,
        }

        let data: LogsResponse =
            serde_json::from_slice(&bytes).map_err(|e| format!("parsing logs response: {e}"))?;
        Ok(LogBatch {
            entries: data.logs,
            cursor: data.cursor,
            dropped: data.dropped,
        })
    }

    /// GET `/.config` and return the parsed JSON body on 200.
    pub fn config(&self) -> Result<Value, String> {
        let url = format!("{}/.config", self.base_url);
        let req = self.apply_auth(self.client.get(&url));
        let resp = req.send().map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        let bytes = resp.bytes().map_err(|e| format!("reading body: {e}"))?;
        if !status.is_success() {
            return Err(runtime_error(status, &bytes));
        }
        serde_json::from_slice(&bytes).map_err(|e| format!("parsing config JSON: {e}"))
    }

    /// GET `/.ping`; returns `true` iff the server responds with 2xx.
    pub fn ping(&self) -> bool {
        let url = format!("{}/.ping", self.base_url);
        match self.client.get(&url).send() {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }

    /// GET `/.config` without credentials to probe reachability and auth state.
    ///
    /// Returns `(reachable, needs_auth)`:
    /// - 2xx → `(true, false)`
    /// - 401 or 3xx → `(true, true)`
    /// - error / other status → `(false, false)`
    pub fn probe(&self) -> (bool, bool) {
        let url = format!("{}/.config", self.base_url);
        // Probe without auth — use a fresh client with redirect off.
        let probe_client = match conn::new_client(self.timeout) {
            Ok(c) => c,
            Err(_) => return (false, false),
        };
        match probe_client.get(&url).send() {
            Ok(resp) => {
                let s = resp.status();
                if s.is_success() {
                    (true, false)
                } else if s == StatusCode::UNAUTHORIZED || (s.as_u16() >= 300 && s.as_u16() < 400) {
                    (true, true)
                } else {
                    (false, false)
                }
            }
            Err(_) => (false, false),
        }
    }

    /// GET `/.config` with credentials; returns `true` iff the response is 2xx.
    pub fn auth_check(&self) -> bool {
        let url = format!("{}/.config", self.base_url);
        let req = self.apply_auth(self.client.get(&url));
        match req.send() {
            Ok(resp) => resp.status().is_success(),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn revoked_authentication_points_to_login_without_replaying() {
        let error = super::runtime_error(reqwest::StatusCode::UNAUTHORIZED, b"unauthorized");
        assert!(error.contains("sb space login"));
    }

    use crate::conn::{Auth, SpaceConnection};
    use reqwest::blocking::Client;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        thread,
        time::Duration,
    };

    #[derive(Debug)]
    struct RecordedRequest {
        _method: String,
        _path: String,
        headers: Vec<(String, String)>,
        _body: Vec<u8>,
    }

    impl RecordedRequest {
        fn header(&self, name: &str) -> Option<&str> {
            let lower = name.to_lowercase();
            self.headers
                .iter()
                .find(|(k, _)| k.to_lowercase() == lower)
                .map(|(_, v)| v.as_str())
        }
    }

    fn mock_server(response: &'static str) -> (String, thread::JoinHandle<RecordedRequest>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let handle = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("accept");
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut writer = stream;

            let mut req_line = String::new();
            reader.read_line(&mut req_line).unwrap();
            let mut parts = req_line.trim().splitn(3, ' ');
            let method = parts.next().unwrap_or("").to_string();
            let path = parts.next().unwrap_or("").to_string();

            let mut headers = Vec::new();
            let mut content_length: usize = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(colon) = trimmed.find(':') {
                    let name = trimmed[..colon].trim().to_string();
                    let value = trimmed[colon + 1..].trim().to_string();
                    if name.to_lowercase() == "content-length" {
                        content_length = value.parse().unwrap_or(0);
                    }
                    headers.push((name, value));
                }
            }

            let mut body = vec![0u8; content_length];
            if content_length > 0 {
                use std::io::Read;
                reader.read_exact(&mut body).unwrap();
            }

            writer.write_all(response.as_bytes()).unwrap();

            RecordedRequest {
                _method: method,
                _path: path,
                headers,
                _body: body,
            }
        });

        (base_url, handle)
    }

    fn mock_server_sequence(
        responses: Vec<&'static str>,
    ) -> (String, thread::JoinHandle<Vec<RecordedRequest>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let base_url = format!("http://127.0.0.1:{port}");

        let handle = thread::spawn(move || {
            responses
                .into_iter()
                .map(|response| {
                    let (stream, _) = listener.accept().expect("accept");
                    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
                    let mut writer = stream;
                    let mut request_line = String::new();
                    reader.read_line(&mut request_line).unwrap();
                    let mut parts = request_line.trim().splitn(3, ' ');
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let mut headers = Vec::new();
                    let mut content_length = 0;
                    loop {
                        let mut line = String::new();
                        reader.read_line(&mut line).unwrap();
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            break;
                        }
                        if let Some(colon) = trimmed.find(':') {
                            let name = trimmed[..colon].trim().to_string();
                            let value = trimmed[colon + 1..].trim().to_string();
                            if name.eq_ignore_ascii_case("content-length") {
                                content_length = value.parse().unwrap_or(0);
                            }
                            headers.push((name, value));
                        }
                    }
                    let mut body = vec![0; content_length];
                    if content_length > 0 {
                        use std::io::Read;
                        reader.read_exact(&mut body).unwrap();
                    }
                    writer.write_all(response.as_bytes()).unwrap();
                    RecordedRequest {
                        _method: method,
                        _path: path,
                        headers,
                        _body: body,
                    }
                })
                .collect()
        });
        (base_url, handle)
    }

    fn bearer_conn(base_url: &str, token: &str) -> SpaceConnection {
        SpaceConnection {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            base_url: base_url.trim_end_matches('/').to_string(),
            auth: Auth::Bearer(token.to_string()),
            timeout: Duration::from_secs(30),
        }
    }

    #[test]
    fn inspect_lua_path_posts_only_identifier_keys() {
        for (path, expression) in [
            (vec![], "lua.inspect()"),
            (
                vec!["index", "_nested2"],
                r#"lua.inspect({"index","_nested2"})"#,
            ),
        ] {
            let response = "HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"result\":{}}";
            let (base_url, handle) = mock_server(response);
            let conn = bearer_conn(&base_url, "tok");
            let path = path.into_iter().map(String::from).collect::<Vec<_>>();

            assert_eq!(conn.inspect_lua_path(&path).unwrap(), serde_json::json!({}));
            let request = handle.join().unwrap();
            assert_eq!(request._path, "/.runtime/lua");
            assert_eq!(request._body, expression.as_bytes());
        }
    }

    #[test]
    fn inspect_lua_path_rejects_invalid_keys_before_sending() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let conn = bearer_conn(&format!("http://{}", listener.local_addr().unwrap()), "tok");
        for key in ["", "2name", "a.b", "a()", "a b", "é", "x\"}); print(1); --"] {
            assert!(conn
                .inspect_lua_path(&["index".into(), key.into()])
                .is_err());
            assert_eq!(
                listener.accept().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock
            );
        }
    }

    #[test]
    fn eval_lua_200_returns_value() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: application/json\r\n",
            "Content-Length: 12\r\n",
            "\r\n",
            r#"{"result":2}"#,
        );
        let (base_url, handle) = mock_server(response);
        let conn = bearer_conn(&base_url, "mytoken");

        let result = conn.eval_lua("1+1").unwrap();
        assert_eq!(result, serde_json::json!(2));

        let req = handle.join().unwrap();
        assert_eq!(
            req.header("content-type").unwrap_or(""),
            "text/plain",
            "must send Content-Type: text/plain"
        );
        assert!(
            req.header("x-timeout").is_some(),
            "must send X-Timeout header"
        );
        assert_eq!(
            req.header("authorization").unwrap_or(""),
            "Bearer mytoken",
            "must send Authorization: Bearer <token>"
        );
    }

    #[test]
    fn eval_lua_503_runtime_not_enabled() {
        let body = r#"{"error":"Runtime API is not enabled"}"#;
        let response = format!(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        // We need a 'static response — use Box::leak for the test.
        let response: &'static str = Box::leak(response.into_boxed_str());
        let (base_url, handle) = mock_server(response);
        let conn = bearer_conn(&base_url, "tok");

        let err = conn.eval_lua("x").unwrap_err();
        let _ = handle.join();
        assert!(
            err.contains("not enabled"),
            "expected 'not enabled' in: {err}"
        );
    }

    #[test]
    fn eval_lua_401_auth_required() {
        let response = concat!(
            "HTTP/1.1 401 Unauthorized\r\n",
            "Content-Length: 0\r\n",
            "\r\n",
        );
        let (base_url, handle) = mock_server(response);
        let conn = bearer_conn(&base_url, "bad");

        let err = conn.eval_lua("x").unwrap_err();
        let _ = handle.join();
        assert!(
            err.contains("authentication required"),
            "expected auth error in: {err}"
        );
    }

    #[test]
    fn eval_lua_repl_preflights_capability_and_forwards_auth() {
        let capability = concat!(
            "HTTP/1.1 200 OK\r\n",
            "X-SilverBullet-Lua-Modes: expression, script, repl\r\n",
            "Content-Length: 11\r\n",
            "\r\n",
            r#"{"logs":[]}"#,
        );
        let evaluation = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Type: application/json\r\n",
            "Content-Length: 13\r\n",
            "\r\n",
            r#"{"result":42}"#,
        );
        let (base_url, handle) = mock_server_sequence(vec![capability, evaluation]);
        let conn = bearer_conn(&base_url, "mytoken");

        assert_eq!(conn.eval_lua_repl("6 * 7").unwrap(), serde_json::json!(42));
        let requests = handle.join().unwrap();

        assert_eq!(requests.len(), 2);
        assert!(requests[0]._path.contains("/.runtime/logs?limit=1"));
        assert_eq!(requests[0].header("authorization"), Some("Bearer mytoken"));
        assert_eq!(requests[1]._path, "/.runtime/lua_script");
        assert_eq!(requests[1].header("authorization"), Some("Bearer mytoken"));
        assert_eq!(requests[1].header(super::LUA_MODE_HEADER), Some("repl"));
        assert_eq!(requests[1]._body, b"6 * 7");
    }

    #[test]
    fn eval_lua_repl_does_not_post_to_an_old_server() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Length: 11\r\n",
            "\r\n",
            r#"{"logs":[]}"#,
        );
        let (base_url, handle) = mock_server(response);
        let conn = bearer_conn(&base_url, "mytoken");

        let error = conn.eval_lua_repl("dangerous()").unwrap_err();
        let request = handle.join().unwrap();

        assert!(error.contains("does not support safe automatic Lua evaluation"));
        assert!(request._path.contains("/.runtime/logs?limit=1"));
        assert!(request._body.is_empty());
    }

    #[test]
    fn logs_200_parses_entries() {
        let body = r#"{"logs":[{"level":"log","text":"hi","timestamp":5}]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let response: &'static str = Box::leak(response.into_boxed_str());
        let (base_url, handle) = mock_server(response);
        let conn = bearer_conn(&base_url, "tok");

        let entries = conn.logs(10, None).unwrap();
        let _ = handle.join();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].level, "log");
        assert_eq!(entries[0].text, "hi");
        assert_eq!(entries[0].timestamp, 5);
    }

    #[test]
    fn log_batch_parses_cursor_metadata() {
        let body = r#"{"logs":[{"level":"warn","text":"late","timestamp":5}],"cursor":"generation:8","dropped":true}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let response: &'static str = Box::leak(response.into_boxed_str());
        let (base_url, handle) = mock_server(response);
        let conn = bearer_conn(&base_url, "tok");

        let batch = conn.log_batch(Some("generation:7")).unwrap();
        let request = handle.join().unwrap();

        assert_eq!(batch.entries[0].text, "late");
        assert_eq!(batch.cursor.as_deref(), Some("generation:8"));
        assert!(batch.dropped);
        assert!(request._path.contains("limit=1000"), "{}", request._path);
        assert!(
            request._path.contains("cursor=generation%3A7"),
            "{}",
            request._path
        );
        assert_eq!(request.header("authorization"), Some("Bearer tok"));
    }

    #[test]
    fn log_batch_accepts_old_server_response_without_cursor() {
        let body = r#"{"logs":[]}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let response: &'static str = Box::leak(response.into_boxed_str());
        let (base_url, handle) = mock_server(response);
        let conn = bearer_conn(&base_url, "tok");

        let batch = conn.log_batch(None).unwrap();
        let _ = handle.join();

        assert!(batch.entries.is_empty());
        assert_eq!(batch.cursor, None);
        assert!(!batch.dropped);
    }

    #[test]
    fn cookie_auth_sends_cookie_header() {
        let response = concat!(
            "HTTP/1.1 200 OK\r\n",
            "Content-Length: 4\r\n",
            "\r\n",
            "null",
        );
        let (base_url, handle) = mock_server(response);
        let conn = SpaceConnection {
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            base_url: base_url.clone(),
            auth: Auth::Cookie {
                name: "auth_x".to_string(),
                value: "jwt".to_string(),
            },
            timeout: Duration::from_secs(30),
        };

        let _ = conn.eval_lua("nil").unwrap();
        let req = handle.join().unwrap();
        assert_eq!(
            req.header("cookie").unwrap_or(""),
            "auth_x=jwt",
            "must send Cookie: auth_x=jwt"
        );
    }
}
