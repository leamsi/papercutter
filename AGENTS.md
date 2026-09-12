# AGENTS.md — guide for humans and agents working on PaperCutter

This file captures hard-won knowledge about this fork: what it is, how its
patches are structured, how to develop, and — most importantly — how to sync
with upstream SilverBullet without losing the plot. It was written after a
full upstream rebase (SilverBullet 2.7.0 → 2.10.0, 507 commits), so it
reflects the **current** architecture, not the one most older docs describe.

Note: upstream's `.gitignore` lists `AGENTS.md` (they deliberately keep agent
notes untracked). This fork tracks it on purpose — it is fork documentation,
like the PaperCutter block in `README.md`.

---

## 1. What PaperCutter is

PaperCutter is a **personal fork** of [SilverBullet](https://silverbullet.md).
The README's top block is the authoritative feature list. So update it if asked
to implement a new feature (or if there's a functional change to one of the
features) The fork exists to carry a small set of opinionated patches over
upstream:

1. **Periods in markdown filenames** — `foo.bookmark.md` works as a page name.
   Implemented by treating unknown dot-suffixes as part of the page name
   (append `.md`) and only leaving *known* extensions (`.pdf`, `.png`, …)
   untouched.
2. **Header Picker (`std.headers`, `Ctrl-Alt-h`)** — a workspace-wide picker
   of every markdown header across the space, ordered by page recency (the
   current page's headers first, then recently opened pages, then by header
   position). Headers of meta/template pages and pages hidden from
   navigation are excluded.
3. **Header autocomplete** — typing `[[` or `[..](` offers headers from
   across the space (like ZK's LSP), not just page names.

Fork philosophy (keep this true):

- **A rebase-based fork**: `git rebase origin/main` keeps PaperCutter as a
  readable stack of patches over upstream. No merge commits from upstream
  into the fork branch.
- **Prefer upstream's infrastructure over fork-parallel code.** If upstream
  builds something better (a new picker system, a link-writing helper), port
  the fork feature *onto it* rather than maintaining a divergent copy. The
  fork's parser-vs-regex story in `plug-api/lib/ref.ts` is the cautionary
  tale — see §6.
- **Mark fork deltas in code** with comments starting with `PaperCutter:`.
  Before/during a sync, find them all with `git grep -n "PaperCutter"`.
- The fork does **not** maintain upstream's `docs/CHANGELOG.md`; the README
  block serves that role for fork changes.

## 2. Repo topology

| Remote        | Points at                                  | Role |
|---------------|--------------------------------------------|------|
| `origin`      | `silverbulletmd/silverbullet` (GitHub)     | Upstream. Only ever fetched, never pushed. |
| `papercutter` | `leamsi/papercutter` (GitHub, SSH)         | The fork's own remote. |

- Branch `papercutter` = upstream `main` + the fork's commit chain (currently
  6 commits; see `git log --oneline origin/main..HEAD`). It tracks
  `papercutter/papercutter`.
- Upstream moves **fast and large** (a few hundred commits between releases;
  entire subsystems get replaced). Expect big diffs; don't eyeball the whole
  range — target the files the fork touches (§6).
- `backup-papercutter-pre-upstream-sync` is a safety branch pinned to the
  pre-rebase chain of the last sync. Recreate one before each sync.

## 3. Architecture quick tour (current, post-2.10)

Backend is **Rust** (Cargo workspace); frontend is TypeScript/CodeMirror 6
with Preact. The old Go server and `go.mod` are gone — any guide mentioning
`go build`/`go test` predates 2.10.

- `client/` — the browser client (bundled by esbuild, served by the Rust
  server from `client_bundle/`, a gitignored build artifact).
  - `client/navigator/` — **the navigation system**. A generic "view"
    abstraction: any collection of rows shown as a fuzzy-filterable list or
    tree, in a modal or docked panel. Builtin views are registered in
    `client/navigator/builtins.ts` under reserved names (`std.pages`,
    `std.anchors`, `std.headers` ← PaperCutter, `std.tags`, `std.commands`,
    `std.spaceTree`, `std.pageHistory`, `std.spaceLog`, `std.gitConflicts`,
    `std.gitStatus`). Spaces define their own views in Space Lua via
    `view.define` (they may not shadow builtin names). `std.toc` (Table of
    Contents, current page only) is a Lua view in
    `libraries/Library/Std/Widgets/Widgets.md`, *not* a builtin.
  - A `BuiltinView` (see `client/navigator/views/types.ts`) has `meta`
    (`baseMeta()` supplies defaults), optional `segments`, a `row`
    presentation (`primary`/`description`/`icon`/…), an async `source(ctx)`
    that queries the index, and `onSelect`/`onCreate`/`keymap`. Views fetch
    their own data — there are no `viewState.allDocuments`-style caches
    anymore.
  - Picker UX conventions: `refreshOn: INDEX_REFRESH_EVENTS` +
    `refreshOnOpen: true`; `filterFields` keeps the host page matchable;
    Feather icons, kebab-case (`"hash"`, `"anchor"`, `"file-text"`); the page
    picker routes `$` → anchor picker, `#` → tag picker (see
    `docs/Navigator.md`).
  - Keybinding families: `Ctrl-k` page picker, `Ctrl-Shift-k` meta picker,
    `Ctrl-o` tree, `Ctrl-Alt-t/m/l/c` tags/mentions/links/commands,
    **`Ctrl-Shift-h` is `Navigate: Home`** (don't claim it!), `Ctrl-Alt-h` is
    the fork's Header picker. Menu placement schema: `{location, group,
    order, label}` with locations like `navigate`/`file`/`edit`/`view`/`space`.
- `plug-api/lib/` — shared libraries plugs and client both use:
  - `ref.ts` — the **shared reference grammar**. `refRegex` powers both
    `parseToRef()` and validation; change it and both change. Refs look like
    `Page`, `Page@123`, `Page@L4C2`, `Page#Header`, `Page$anchor`, `^Page`
    (meta). `normalizePath()` appends `.md` unless the path ends in a
    **known extension** (PaperCutter's list — this is what makes
    `foo.bookmark.md` work). The fork's regex delta is documented in a
    comment right above `refRegex`.
  - `link_write.ts` + `resolve_path.ts` — how links are *written*:
    "bare iff unique" invariant, `writeLinkPath(path, format, index)`,
    `collisionIndex(space.collidingBasenames())`. Formats: `full-path`
    (default), `shortest`, suffix-unambiguous.
- `plugs/index/` — the indexer. `header.ts` produces header objects
  `{ref, tag: "header", tags, level, name, text, page, pos, range}`; `ref`
  is the header's `$anchor` name when it has one, else `Page@pos`. It also
  exports `headerComplete()`, which completes headers after a `#` inside a
  wikilink (upstream feature; distinct from the fork's `[[` mixing).
- `plugs/editor/complete.ts` — `pageComplete()` mixes pages, documents,
  aspiring pages and (PaperCutter) **headers** for `[[`/`[..](`. Boosts use
  `recencyToBoost()` (monotone log-of-age); markdown-link targets get `+5`
  for relative paths and `<...>` wrapping when they contain spaces; wikilink
  targets go through `written()` (collision-aware).
- `server/` — the Rust server (multi-space capable; `--single` restores the
  classic env-var mode). `server-common`, `server-merge`, and
  `server-runtime-chrome` are sibling crates; `bin/silverbullet` is the
  server binary, `bin/sb` the CLI (browser-based auth etc.).
- `libraries/` — Space Lua shipped with the app (`Library/Std/...`).
- `docs/` — the SilverBullet manual itself (130+ pages), including
  `docs/Navigator.md`, `docs/CHANGELOG.md`. `website/` no longer exists.

## 4. The fork's patch inventory (sync checklist)

These are the files upstream changes will collide with. `git grep -n
"PaperCutter" -- '*.ts' '*.md'` finds every in-code marker.

| File | Fork delta |
|---|---|
| `plug-api/lib/ref.ts` | Regex lookahead: `(?!.*\.[a-zA-Z0-9]+\.md$)` → `(?!.*\/\.[^/]*\.md$)` (allow multi-period `.md` names, still reject hidden `/.foo.md`); `normalizePath()` uses the `knownExtensions` list instead of upstream's permissive `endsInExtension()`. |
| `plug-api/lib/ref.test.ts` | Fork expectations merged in (`foo.md.md`, `foo.bookmark.md`, `folder/nested.page.md` accepted; `" .foo"` → `" .foo.md"`). |
| `plugs/editor/complete.ts` | `allHeaders` query + header options appended in `pageComplete()`; wikilink target `written(page)#Header|Header`, markdown-link `<path#Header>` for spaced targets, `recencyToBoost()` by host page. |
| `plugs/editor/complete.test.ts` | `pageComplete header completions` describe-block (3 tests). |
| `client/navigator/views/headers.ts` | `std.headers` builtin view (source/rows/onSelect). |
| `client/navigator/views/headers.test.ts` | 6 tests for the view (mocked syscalls). |
| `client/navigator/builtins.ts` | Registers `"std.headers": headerPicker`. |
| `client/editor_commands.ts` | `Navigate: Header Picker` command, `Ctrl-Alt-h`, menu `navigate/2_picker`. |
| `docs/Navigator.md` | One bullet documenting the Header picker. |
| `README.md` | PaperCutter block at the top (features + TODO), badges removed. |
| `.gitignore` | `AGENTS.md` un-ignored so this guide is tracked. |
| `package.json` / `package-lock.json` | vitest `^4.1.2` (upstream pins `^4.0.18`; in-range, cosmetic). |

## 5. Everyday development

### Setup & toolchain

```sh
nvm use            # Node is pinned to 24.13.0 (.nvmrc). As of September 12, Node 25 breaks tests!
make setup         # npm install + playwright install
rustup toolchain install stable --profile minimal   # if cargo complains
```

Node 25's global `localStorage` shim breaks `client/logout.test.ts` (see §7).
Always use the pinned Node.

### Build / run

```sh
make build         # plugs + client + plug compiler + Rust server & CLI (release)
make build-rs      # just the Rust release binary → target/release/silverbullet
npm run build      # just the web side (also regenerates version.json)
```

Run a server: `./target/release/silverbullet -p 3000 <path-to-folder>` (or
`SB_FOLDER`/`SB_PORT` env vars; `--single` for the classic single-space
mode). The binary serves the client bundle from `client_bundle/` — rebuild
the client after client-side changes or you'll test stale code.

### Checks (run all before pushing)

```sh
make check         # tsc --noEmit + biome lint . + biome format + cargo fmt --check + clippy -D warnings
npx vitest run     # the JS test suite
cargo test --workspace --all-features
```

Always run `npx biome format --write` on files you touched before
committing — biome's formatting is opinionated (e.g. array elements one per
line) and `make check` enforces it.

### Test patterns

- Syscall-backed code: prefer the real in-memory mock,
  `createMockSystem()` from `plug-api/system_mock.ts`, and seed data with
  `(globalThis as any).syscall("index.indexObjects", pageName, [obj])`. See
  `plugs/editor/complete.test.ts`.
- Navigator views: `vi.mock("@silverbulletmd/silverbullet/syscalls", ...)`
  with mock objects declared at top level, then **dynamically import the
  module under test after the mocks** — `const { headerPicker } = await
  import("./headers.ts")`. A static `import` is hoisted above the mock
  consts and blows up with "Cannot access 'index' before initialization".
  See `client/navigator/views/headers.test.ts` and
  `client/navigator/builtins.test.ts` for the house style.
- e2e (Playwright) lives in `e2e/`; needs a full build (`make test-e2e`).
  Heavy — usually skip for fork work; unit tests + `make check` catch
  nearly everything.
- Benchmarks: `npm run bench`.

### Where to put changes

- A picker/view change → its own file under `client/navigator/views/`,
  registered in `builtins.ts`, opened via a command (`openCommand(name)` from
  `client/navigator/navigator.ts` or `client.openNavigatorView(name)`).
- Data for a picker comes from the index: add an object type in
  `plugs/index/` (see `header.ts` as the template) and query it with
  `index.queryLuaObjects(tag, query)`.
- Docs: user-facing behavior → `docs/*.md` (e.g. add a bullet to
  `docs/Navigator.md`); fork meta → the README block. Upstream changelog
  entries are upstream's job.

## 6. Upstream sync playbook

This is the most important section. Do it exactly in this order.

1. **Backup**: `git branch backup-papercutter-pre-upstream-sync` at the
   current tip. (After the rebase, beware: `git rebase --update-refs`
   rewrites branches pointing into the rebased range — re-pin the backup
   with `git branch -f <name> <old-sha>` if it moved.)
2. **Fetch & survey**:
   ```sh
   git fetch origin --prune
   git log --oneline <old-tip>..origin/main          # the incoming wave
   git diff <old-tip>..origin/main --stat -- <fork files from §4>   # collision forecast
   ```
   Read upstream's commit subjects for the touched areas; check whether any
   fork feature got reimplemented upstream (when it did — header completion
   — prefer upstream's version and only keep the fork's extra UX).
3. **Rebase**: `git rebase origin/main`. Expect conflicts in exactly the §4
   files. Resolution principles, learned the hard way:
   - **Take upstream's file (`git checkout --ours <file>`), then re-apply
     the fork's intent as a small delta.** Don't try to preserve fork-side
     implementations; upstream rewrites its own code constantly and the
     fork's copies rot (the manual ref parser was dropped for exactly this
     reason: upstream's regex had already gained `$anchor` support the fork
     lacked).
   - Conflict markers can align horribly. `checkout --ours` + hand-porting
     the fork hunk beats hand-untangling markers.
   - **In a rebase, `--ours` = the new base (upstream side), `--theirs` =
     the commit being applied.** (It's the reverse of merge intuition.)
   - Files that auto-merge cleanly can still be wrong: auto-merged code may
     call APIs upstream deleted. After resolving each commit, grep the tree
     for stale references (e.g. `startPageNavigate("header")` survived an
     auto-merge even though upstream removed that mode).
   - When a commit's changes are already present in your earlier
     resolutions it becomes **empty** — that's fine, let the rebase skip it
     (`git rebase --skip` / continue; git drops it).
   - Fold small follow-up fixes (formatting, keybinding clashes) into their
     proper commit: `git commit --fixup <sha>` then
     `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main`.
   - Check **keybinding collisions** against upstream's current bindings
     (`git grep -h -E "key: " -- '*.yaml' '*.ts'`) — the fork's original
     `Ctrl-Shift-h` collided with `Navigate: Home` and had to move.
   - Incidental dependency bumps riding along in a fork commit (package
     churn): decide deliberately whether to keep or drop them; dropping
     keeps the patch focused, keeping is fine if in-range.
4. **Rebuild environment**: `npm install` (upstream adds/removes deps every
   sync), regenerate `version.json` if missing (`npm run build` does it, or
   the one-liner in §7), `npx biome format --write <touched files>`.
5. **Test**: full `npx vitest run`, `npm run check`, and
   `GIT_CONFIG_GLOBAL=/dev/null cargo test --workspace --all-features` (see
   §7 for why the env var). Run the smoke test after `npm run build` so it
   exercises the fresh bundle.
6. **Publish**: `git push --force-with-lease papercutter papercutter` — the
   rebase rewrote history; a normal push will be rejected.

### A concrete example of "port the intent, not the code"

The Header Picker's original implementation (viewState cache + preact
`AnythingPicker` mode) was deleted wholesale by upstream. The port kept only
the *behavior*: query `header` objects, filter meta/hidden pages, sort by
page recency then position, navigate to `Page@pos`, and the original unit
test cases (re-expressed against the new view's `source()`/`onSelect()`).
The result reads like it was written for the new architecture — that's the
goal.

## 7. Environment gotchas & known (non-)failures

- **Node version**: repo pins **24.13.0**. On Node ≥25,
  `client/logout.test.ts` fails 10 tests with `localStorage.getItem is not a
  function` — an environment artifact of Node 25's global `localStorage`
  shim, *not* a code bug. Verify with `nvm use` before suspecting your
  changes.
- **`version.json`** (gitignored, generated): imported by
  `client/plugos/syscalls/system.ts`; without it dozens of test files fail
  to load with "Cannot find module '../../../version.json'". Regenerate
  with `npm run build` or:
  ```sh
  npx tsx -e 'import("./build/version.ts").then((m) => m.updateVersionFile()).then(() => console.log("ok"))'
  ```
  (No top-level await — tsx evaluates CJS.)
- **Rust revisions tests need real git hooks**: `revisions::sync` and
  `revisions::engine` tests install per-repo `hooks/update` scripts. If your
  global git config sets `core.hookspath`, those hooks never fire and 3
  tests fail deterministically. Run with
  `GIT_CONFIG_GLOBAL=/dev/null cargo test ...`.
- **Rust toolchain**: `rust-toolchain.toml` pins `stable`; rustup
  auto-installs but may choke on removed components (`rls-preview`) —
  `rustup component remove --toolchain stable rls-preview` and retry.
- **Stale `client_bundle/`**: the smoke test
  (`bin/silverbullet/tests/smoke.rs`) fails with "unresolved placeholder in
  shell" if the served bundle predates the current client. `npm run build`
  fixes it.
- **Disk space**: a full `cargo test` run compiles the whole workspace;
  don't run it inside a second worktree without cleaning `target/` (they're
  ~GBs each, not shared).
- Untracked local noise (`PLAN.md`, `REVIEW.md`, `test_space/`,
  `.bg-shell/`, `.gsd/`) is yours; biome will flag `.bg-shell/manifest.json`
  in `fmt:check`. Harmless.

## 8. Command cheat sheet

```sh
# Environment
nvm use                                  # Node 24.13.0 — required for clean tests
make setup                               # deps + playwright browsers
npx tsx -e 'import("./build/version.ts").then((m) => m.updateVersionFile()).then(() => console.log("ok"))'

# Build & run
npm run build                            # plugs + client (+ version.json)
make build-rs                            # release Rust binary
./target/release/silverbullet -p 3000 <space-folder>

# Checks
make check                               # everything (tsc/biome/fmt/clippy)
npx vitest run                           # JS tests
npx vitest run plug-api/lib/ref.test.ts  # just the ref grammar
npx biome format --write <files>         # format what you touched
GIT_CONFIG_GLOBAL=/dev/null cargo test --workspace --all-features

# Upstream sync (see §6 for the full playbook)
git fetch origin --prune
git branch backup-papercutter-pre-upstream-sync
git rebase origin/main
git commit --fixup <sha> && GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash origin/main
git push --force-with-lease papercutter papercutter

# Fork-delta inventory
git grep -n "PaperCutter" -- '*.ts' '*.md'
git log --oneline origin/main..HEAD      # the fork's commit stack
git diff origin/main HEAD --stat         # the fork's cumulative delta
```

## 9. Style & meta

- `STYLE.md` and `CONTRIBUTING.md` cover upstream's conventions; commit
  messages in the stack are plain imperative subjects ("Add header
  completions to page completion").
- Upstream has an [LLM use
  policy](https://silverbullet.md/LLM%20Use) — worth reading if you plan to
  upstream a change (PaperCutter patches are fork-only by default).
- When editing `ref.ts`'s `refRegex`, re-read the PaperCutter comment above
  it first; the lookahead difference is the entire periods feature.
- When adding a picker row type, keep descriptions short ("in <page>") —
  they're filterable text, not prose.

## 10. Last, but not least

Keep AGENTS.md file up to date with any new discoveries, gotchas, important
commands, things to keep in mind, lessons learned and so on. It's your chance to
train future developers on the codebase so they can move faster than you!
