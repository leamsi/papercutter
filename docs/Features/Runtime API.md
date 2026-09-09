---
tags: maturity/experimental
references:
- bin/silverbullet/src/server.rs
- bin/sb/src/commands/query.rs
---

The Runtime API lets you interact with SilverBullet programmatically over HTTP: evaluate Lua expressions and run scripts from the command line, scripts, or external tools.

Requests are evaluated via Chrome DevTools Protocol (CDP) in a headless Chrome instance, which does the actual execution so all results reflect the live client state.

> **note** Note
> The [[Features/CLI]] provides a convenient command-line interface for the Runtime API — evaluate Lua, run scripts, open a REPL, and more, without writing raw HTTP requests.

> **note** Note
> The Runtime API is not available in read-only mode (`SB_READ_ONLY`).

# Setup
The Runtime API is enabled automatically when Chrome, Chromium, or Chromium headless shell is detected on your system — no configuration needed. Auto-detection prefers headless shell when it is available on `PATH`.

If Chrome isn't auto-detected, set the path explicitly:
```
SB_CHROME_PATH=/usr/bin/chromium
```

Headless shell uses less memory by omitting Chrome’s browser UI while keeping the web platform used by SilverBullet. You can select it explicitly with `SB_CHROME_PATH=/path/to/chrome-headless-shell` (Alpine Linux calls the executable `chromium-headless-shell`). The runtime also uses memory-oriented V8 settings and disables unused address-bar UI in regular headless Chrome. These changes preserve the full client, per-user/space isolation, and native profile storage; runtimes are not stopped automatically when idle.

In single-instance mode, set `SB_RUNTIME_API=0` to disable the Runtime API. In multi-space mode this variable is ignored: use the **Enable runtime API** toggle in the administrator’s **Server** tab. Each space retains its own runtime setting and each writer has an independent **Runtime API** permission in the access grid. Runtime permission is unavailable to readers. Existing writers default to enabled unless explicitly opted out; new spaces default on when Chrome is detected and the server toggle is enabled.

# Docker setup
Use the `-runtime-api` Docker image variant, which includes Chromium headless shell:
```yaml
services:
  silverbullet:
    image: ghcr.io/silverbulletmd/silverbullet:latest-runtime-api
    environment:
      - SB_USER=me:secret        # optional
      - SB_AUTH_TOKEN=mytoken    # optional, for API auth
    volumes:
      - myspace:/space
    ports:
      - "3000:3000"
```

The `-runtime-api` image stores isolated temporary Chrome profiles under `/space/.chrome-data`. A new runtime receives a fresh profile and rebuilds its client index; profiles are removed on Reset, permission revocation, or server shutdown. Administrative Stop retains the profile for reuse within the current server lifetime.

The base Docker image (`ghcr.io/silverbulletmd/silverbullet`) does **not** include a browser and is smaller.

# Endpoints

## Evaluate a Lua expression
`POST /.runtime/lua`

The request body is a raw Lua expression as plain text.

```bash
curl -d '1 + 1' http://localhost:3000/.runtime/lua
# => {"result":2}
```

```bash
curl -d 'editor.getCurrentPage()' http://localhost:3000/.runtime/lua
# => {"result":"index"}
```

## Evaluate a Lua script
`POST /.runtime/lua_script`

The request body is a raw Lua script as plain text. This allows multi-statement scripts with explicit `return` statements.

```bash
curl -d 'local pages = query[[from tags.page limit 3 select table.select(_, "name")]]
return pages' \
     http://localhost:3000/.runtime/lua_script
# => {"result":[{"name":"index"},{"name":"Projects"},{"name":"TODO"}]}
```

## Screenshot
`GET /.runtime/screenshot`

Captures the current viewport of the headless Chrome instance as a PNG image.

```bash
curl -o screenshot.png http://localhost:3000/.runtime/screenshot
```

## Console logs
`GET /.runtime/logs`

Returns recent console log entries from the headless browser.

| Query parameter | Description |
|---|---|
| `limit` | Maximum number of entries to return (default: 100, server retains up to 1000) |
| `since` | Unix millisecond timestamp — only return entries newer than this |

```bash
curl http://localhost:3000/.runtime/logs?limit=5
```

**Response:** `Content-Type: application/json`
```json
{
  "logs": [
    {"level": "log", "text": "[Client] Booting SilverBullet client", "timestamp": 1710000000000},
    {"level": "info", "text": "Service worker disabled.", "timestamp": 1710000000050}
  ]
}
```

Each entry has:
* `level` — one of `log`, `info`, `warn`, `error`, `debug`
* `text` — the concatenated console message
* `timestamp` — unix milliseconds when the entry was captured

# Timeout
The Lua endpoints (`/.runtime/lua` and `/.runtime/lua_script`) support an `X-Timeout` header to control the maximum wait time in seconds (default: 30):

```
curl -H "X-Timeout: 60" \
     -d 'some_long_running_expression()' \
     http://localhost:3000/.runtime/lua
```

# Error handling
All error responses are JSON with `Content-Type: application/json` and an `error` key. Runtime execution failures also include a stable machine-readable `code`.

Status codes used across the Runtime API:

* **403** — The caller lacks Write or Runtime API permission.
* **400** — Empty request body: `{"error": "Request body is required"}`.
* **500** — Lua/JS execution error (the evaluated code threw, e.g. a Lua error): `{"error": "<error message>", "code": "script_error"}`. The message is the concise client error (e.g. `attempt to call a nil value`); the full stack is available in the runtime console log.
* **503** — Runtime API not enabled or no headless browser running: `{"error": "Runtime API is not enabled"}` or `{"error": "...", "code": "bridge_unavailable"}`.
* **504** — Timeout exceeded: `{"error": "...", "code": "timeout"}`.

# How it works
As documented in [[Architecture]], the vast majority of SilverBullet’s power is implemented in the client. However, there are use cases for programmatically accessing your space with all of SilverBullet (client’s) power.

When the Runtime API is enabled, the first request to an `/.runtime/` endpoint starts a separate headless Chrome process for that user and space. Each runtime has its own temporary profile, cookies, browser storage, and console log. It loads the full SilverBullet client with the originating user’s identity and permissions. Removing Write or runtime access, disabling the account, or switching runtime off stops the affected browser and invalidates its credentials.

Once ready, the server communicates with the browser directly via Chrome DevTools Protocol (CDP). Because Lua code runs inside a real SilverBullet client, it has access to the full API surface — `editor.*`, `space.*`, queries, and everything else available to in-page scripts and widgets. The results reflect live client state.

## Debugging
Set `SB_CHROME_SHOW=1` to run Chrome with a visible window — useful for watching what the headless client is doing. Set `SB_CHROME_DATA_DIR` to choose the parent directory for isolated temporary profiles. Startup logs report the detected Chrome executable or that Chrome is unavailable.

## Resource usage
Headless Chrome spawns several processes (browser, network, storage, and renderer) for each active user and space pair. Additional runtimes therefore cost a whole browser, not just a tab. Browsers start lazily so unused runtime permissions consume no Chrome processes.

## Managing runtimes

Server administrators can open **Admin → Runtimes** to see each instantiated runtime's space, user, status, CPU, estimated memory, and profile disk usage. The list refreshes while visible and includes stopped runtimes with retained profiles. Viewing it does not start Chrome.

**Stop** cancels execution and stops Chrome, retaining its profile and client index. The next authorized runtime request starts Chrome again with a fresh credential for the same user and space. **Reset** also deletes the profile and removes the entry; the next request creates a fresh profile and rebuilds the index. Neither action changes permissions. A reset that cannot finish cleanup remains unavailable until Reset succeeds. Removing a user's permissions still invalidates credentials and removes retained runtime data.

CPU includes Chrome's child processes; 100% represents one fully used logical core. Memory sums resident memory across those processes and may count shared pages more than once. Profile disk usage measures browser files, excluding the space's notes. Measurements that cannot be obtained appear as unavailable. Profiles retained by Stop do not persist across a server restart.
