/**
 * PaperCutter: the header picker is a Space Lua view, defined in
 * `libraries/Library/Std/Widgets/Header Picker.md` (like `std.toc`). These
 * tests extract that page's `space-lua` code, evaluate it against the real
 * view registry, and drive the same hooks the panel uses -- so what is
 * asserted here is the shipped Lua, not a copy of its logic.
 */
import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { descriptionText } from "../../../plug-api/ui/description.ts";
import { extractSpaceLuaFromPageText } from "../../boot_config.ts";
import { evalStatement } from "../../space_lua/eval.ts";
import { parseBlock } from "../../space_lua/parse.ts";
import { ArrayQueryCollection } from "../../space_lua/query_collection.ts";
import {
  LuaBuiltinFunction,
  LuaEnv,
  LuaNativeJSFunction,
  LuaStackFrame,
  LuaTable,
  type LuaValue,
} from "../../space_lua/runtime.ts";
import { luaBuildStandardEnv } from "../../space_lua/stdlib.ts";

const { index, space, config, editor, markdown, system, events } = vi.hoisted(
  () => ({
    index: {
      isAvailable: vi.fn<() => Promise<boolean>>(),
      queryLuaObjects:
        vi.fn<(tag: string, query: unknown) => Promise<unknown[]>>(),
    },
    space: {
      listPages: vi.fn<() => Promise<unknown[]>>(),
      listDocuments: vi.fn<() => Promise<unknown[]>>(),
    },
    editor: {
      flashNotification: vi.fn<(msg: string, kind?: string) => Promise<void>>(),
      getUiOption: vi.fn<(name: string) => Promise<unknown>>(),
      getCurrentPath: vi.fn<() => Promise<string>>(),
    },
    markdown: {
      parseMarkdown: vi.fn<(text: string) => Promise<unknown>>(),
    },
    config: { get: vi.fn() },
    system: {
      getMode: vi.fn<() => Promise<string>>(),
      invokeFunction:
        vi.fn<(name: string, ...args: unknown[]) => Promise<unknown>>(),
    },
    events: {
      dispatchEvent:
        vi.fn<(name: string, data?: unknown) => Promise<unknown[]>>(),
    },
  }),
);

vi.mock("@silverbulletmd/silverbullet/syscalls", () => ({
  index,
  space,
  config,
  editor,
  markdown,
  system,
  events,
  datastore: {},
}));
// `client/plugos/syscalls/editor.ts` (pulled in via boot_config) and the
// registry both reach into navigator.ts at module scope; stub its UI halves.
vi.mock("../navigator.ts", () => ({
  open: vi.fn(),
  hide: vi.fn(),
}));

const { commandDefinition, validateDefineSpec, wireMeta } = await import(
  "../lua_views.ts"
);
const { handle, register, setLuaEnvSource } = await import("../registry.ts");
const { normalizeDefineSpec } = await import("../view_value.ts");

type Obj = Record<string, any>;

function headerOf(name: string, page: string, pos: number) {
  return { ref: `${page}@${pos}`, tag: "header", name, page, pos, level: 1 };
}

function pageOf(
  name: string,
  lastModified: string,
  tags: string[] = [],
  extra: Record<string, any> = {},
) {
  return { ref: name, tag: "page", name, lastModified, tags, ...extra };
}

/**
 * Evaluate the header picker page's Space Lua with stubbed `view`/`editor`/
 * `index` namespaces, then register what its `view.define` produced the way
 * `defineView` does. Returns the raw spec for chrome assertions.
 */
async function loadPicker(opts: {
  headers: Obj[];
  pages: Obj[];
  opened?: Record<string, number>;
  currentPage?: string;
}) {
  let spec: LuaTable | undefined;
  const navigations: Obj[] = [];

  const env = new LuaEnv(luaBuildStandardEnv());
  setLuaEnvSource(() => env);

  const viewNs = new LuaTable();
  // A LuaBuiltinFunction, like the real `lua:view.define`: the spec must
  // arrive as the Lua table the user wrote, not a converted JS object.
  void viewNs.set(
    "define",
    new LuaBuiltinFunction((_sf, specValue: LuaValue) => {
      spec = specValue as LuaTable;
    }),
  );
  env.set("view", viewNs);

  const editorNs = new LuaTable();
  void editorNs.set(
    "getCurrentPage",
    new LuaNativeJSFunction(() => opts.currentPage ?? "test"),
  );
  void editorNs.set(
    "getLastOpenedMap",
    new LuaNativeJSFunction(() => opts.opened ?? {}),
  );
  void editorNs.set(
    "navigate",
    new LuaNativeJSFunction((ref: Obj) => {
      navigations.push(ref);
    }),
  );
  env.set("editor", editorNs);

  const indexNs = new LuaTable();
  void indexNs.set(
    "pages",
    new LuaNativeJSFunction(() => new ArrayQueryCollection(opts.pages)),
  );
  void indexNs.set(
    "headers",
    new LuaNativeJSFunction(() => new ArrayQueryCollection(opts.headers)),
  );
  env.set("index", indexNs);

  const source = await readFile(
    new URL(
      "../../../libraries/Library/Std/Widgets/Header Picker.md",
      import.meta.url,
    ),
    "utf8",
  );
  const block = parseBlock(extractSpaceLuaFromPageText(source));
  await evalStatement(
    block,
    env,
    LuaStackFrame.createWithGlobalEnv(env, block.ctx),
  );

  expect(spec).toBeDefined();
  validateDefineSpec(spec!);
  // Exactly what `defineView` does with a flat definition.
  const normalized = normalizeDefineSpec(spec!);
  register({ meta: wireMeta(normalized), spec: normalized });
  return { spec: spec!, navigations };
}

/** The meta the panel resolves -- what the UI builds itself from. */
async function viewMeta() {
  return (await handle({ view: "std.headers", hook: "meta" })) as {
    title: string;
    dock: string;
    supportedDocks?: string[];
    filterFields?: Record<string, unknown>;
  };
}

/** The panel's rows hook: what the user would see, in source order. */
async function viewRows() {
  return (await handle({
    view: "std.headers",
    hook: "rows",
    args: { ctx: { phrase: "" } },
  })) as { obj: Obj; primary?: string; description?: unknown }[];
}

test("lists headers of pages across the space", async () => {
  await loadPicker({
    headers: [headerOf("Header 1", "Page 1", 10)],
    pages: [pageOf("Page 1", "2026-01-01T00:00:00Z")],
  });

  const rows = await viewRows();
  expect(rows.length).toBe(1);
  expect(rows[0].primary).toBe("Header 1");
  expect(descriptionText(rows[0].description as any)).toBe("in Page 1");
});

test("excludes headers of meta pages and hidden pages", async () => {
  await loadPicker({
    headers: [
      headerOf("Header 1", "Page 1", 10),
      headerOf("Header 2", "template/stuff", 20),
      headerOf("Header 3", "Page 2", 30),
      headerOf("Header 4", "secret", 40),
    ],
    pages: [
      pageOf("Page 1", "2026-01-01T00:00:00Z"),
      pageOf("template/stuff", "2026-01-01T00:00:00Z", ["template"]),
      pageOf("Page 2", "2026-01-01T00:00:00Z"),
      pageOf("secret", "2026-01-01T00:00:00Z", [], {
        pageDecoration: { hide: true },
      }),
    ],
  });

  const rows = await viewRows();
  expect(rows.map((row) => row.primary)).toEqual(["Header 1", "Header 3"]);
});

test("offers no pages, only headers", async () => {
  await loadPicker({
    headers: [headerOf("Header 1", "Page 1", 10)],
    pages: [
      pageOf("Page 1", "2026-01-01T00:00:00Z"),
      pageOf("Page 2", "2026-01-01T00:00:00Z"),
    ],
  });

  const rows = await viewRows();
  expect(rows.length).toBe(1);
});

test("sorts by page recency (last opened) first, then by position", async () => {
  const now = Date.now();
  await loadPicker({
    headers: [
      headerOf("Intro", "older-page", 5),
      headerOf("Conclusion", "older-page", 100),
      headerOf("Summary", "recent-page", 50),
      headerOf("Overview", "recent-page", 10),
    ],
    pages: [
      pageOf("older-page", new Date(now - 86400000).toISOString()),
      pageOf("recent-page", new Date(now - 86400000).toISOString()),
    ],
    opened: { "older-page": now - 3600000, "recent-page": now },
    currentPage: "somewhere-else",
  });

  const rows = await viewRows();
  expect(rows.map((row) => row.primary)).toEqual([
    // recently opened page first
    "Overview", // recent-page, pos 10
    "Summary", // recent-page, pos 50
    // then older page
    "Intro", // older-page, pos 5
    "Conclusion", // older-page, pos 100
  ]);
});

test("puts the current page's headers first", async () => {
  const now = Date.now();
  await loadPicker({
    headers: [
      headerOf("Other Header", "other-page", 10),
      headerOf("Current Header", "current", 5),
      headerOf("Another Current", "current", 20),
    ],
    pages: [
      pageOf("other-page", new Date(now).toISOString()),
      pageOf("current", new Date(now).toISOString()),
    ],
    currentPage: "current",
  });

  const rows = await viewRows();
  expect(rows.map((row) => row.primary)).toEqual([
    "Current Header",
    "Another Current",
    // then other pages
    "Other Header",
  ]);
});

test("selecting a header navigates to its page position", async () => {
  const { navigations } = await loadPicker({
    headers: [headerOf("My Header", "My Page", 42)],
    pages: [pageOf("My Page", "2026-01-01T00:00:00Z")],
  });

  await handle({
    view: "std.headers",
    hook: "select",
    args: { obj: { name: "My Header", page: "My Page", pos: 42 } },
  });

  expect(navigations).toEqual([
    { path: "My Page.md", details: { type: "position", pos: 42 } },
  ]);
});

test("carries the picker's command chrome and dockable view meta", async () => {
  const { spec } = await loadPicker({
    headers: [],
    pages: [],
  });

  const meta = await viewMeta();
  expect(meta.title).toBe("Headers");
  expect(meta.dock).toBe("modal");
  expect(meta.supportedDocks).toEqual([
    "modal",
    "lhs",
    "rhs",
    "bhs",
    "page-top",
    "page-bottom",
  ]);
  // Ranked against the header's name; the host page stays matchable.
  expect(meta.filterFields).toEqual({
    primary: { weight: 1, segments: true },
    page: { weight: 0.6, segments: true },
    description: 0.4,
  });

  const command = commandDefinition(spec, async () => {});
  expect(command.name).toBe("Navigate: Header Picker");
  // Ctrl-Shift-h is taken by "Navigate: Home".
  expect(command.key).toBe("Ctrl-Alt-h");
  expect(command.menu).toEqual({
    location: "navigate",
    group: "2_picker",
    order: 5,
    label: "Header...",
  });
});
