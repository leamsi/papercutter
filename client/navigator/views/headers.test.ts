import { expect, test, vi } from "vitest";

const index = {
  isAvailable: vi.fn<() => Promise<boolean>>(),
  queryLuaObjects: vi.fn<(tag: string, query: unknown) => Promise<unknown[]>>(),
};
const editor = {
  getLastOpenedMap: vi.fn<() => Promise<Record<string, number>>>(),
  getCurrentPath: vi.fn<() => Promise<string>>(),
  navigate: vi.fn<(ref: unknown) => Promise<void>>(),
};

vi.mock("@silverbulletmd/silverbullet/syscalls", () => ({
  index,
  editor,
}));

const { headerPicker } = await import("./headers.ts");

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

/** Stub the syscalls `headerSource` consults and return its rows. */
async function pickHeaders(opts: {
  headers: ReturnType<typeof headerOf>[];
  pages: ReturnType<typeof pageOf>[];
  opened?: Record<string, number>;
  currentPath?: string;
  withIndex?: boolean;
}) {
  index.isAvailable.mockResolvedValue(opts.withIndex ?? true);
  index.queryLuaObjects.mockImplementation((tag: string) => {
    if (tag === "header") return Promise.resolve(opts.headers);
    if (tag === "page") return Promise.resolve(opts.pages);
    return Promise.resolve([]);
  });
  editor.getLastOpenedMap.mockResolvedValue(opts.opened ?? {});
  editor.getCurrentPath.mockResolvedValue(opts.currentPath ?? "test.md");
  return headerPicker.source({ phrase: "" });
}

test("lists headers of pages across the space", async () => {
  const rows = await pickHeaders({
    headers: [headerOf("Header 1", "Page 1", 10)],
    pages: [pageOf("Page 1", "2026-01-01T00:00:00Z")],
  });

  expect(rows.length).toBe(1);
  expect(headerPicker.row.primary?.(rows[0])).toBe("Header 1");
  expect(headerPicker.row.description?.(rows[0])).toBe("in Page 1");
});

test("excludes headers of meta pages and hidden pages", async () => {
  const rows = await pickHeaders({
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

  expect(rows.map((row) => row.name)).toEqual(["Header 1", "Header 3"]);
});

test("offers no pages, only headers", async () => {
  const rows = await pickHeaders({
    headers: [headerOf("Header 1", "Page 1", 10)],
    pages: [
      pageOf("Page 1", "2026-01-01T00:00:00Z"),
      pageOf("Page 2", "2026-01-01T00:00:00Z"),
    ],
  });

  expect(rows.length).toBe(1);
});

test("sorts by page recency (last opened) first, then by position", async () => {
  const now = Date.now();
  const rows = await pickHeaders({
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
  });

  expect(rows.map((row) => row.name)).toEqual([
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
  const rows = await pickHeaders({
    headers: [
      headerOf("Other Header", "other-page", 10),
      headerOf("Current Header", "current", 5),
      headerOf("Another Current", "current", 20),
    ],
    pages: [
      pageOf("other-page", new Date(now).toISOString()),
      pageOf("current", new Date(now).toISOString()),
    ],
    currentPath: "current.md",
  });

  expect(rows.map((row) => row.name)).toEqual([
    "Current Header",
    "Another Current",
    // then other pages
    "Other Header",
  ]);
});

test("selecting a header navigates to its page position", async () => {
  const obj = headerOf("My Header", "My Page", 42);
  await headerPicker.onSelect(obj, {});

  expect(editor.navigate).toHaveBeenCalledWith({
    path: "My Page.md",
    details: { type: "position", pos: 42 },
  });
});
