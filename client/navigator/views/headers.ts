import { editor, index } from "@silverbulletmd/silverbullet/syscalls";
import { isHiddenPage, isMetaPage } from "./pages.ts";
import { baseMeta, type BuiltinView, INDEX_REFRESH_EVENTS } from "./types.ts";

/**
 * PaperCutter: a workspace-wide header picker. Where `std.toc` outlines the
 * current page, this view lists the markdown headers of every page in the
 * space (like ZK's LSP): pick one to jump straight to it.
 *
 * A header row is the indexed `header` object (`plugs/index/header.ts`):
 * `name`, `page`, `pos`, `level` and optionally header-level `tags`.
 */
type HeaderObj = Record<string, any>;

export const headerPicker: BuiltinView<HeaderObj> = {
  meta: baseMeta({
    title: "Headers",
    label: "Open",
    placeholder: "Header",
    refreshOn: INDEX_REFRESH_EVENTS,
    refreshOnOpen: true,
    // Ranked against the header's name, but the host page stays matchable --
    // "intro proj" finds `#Intro` on Projects/Alpha.
    filterFields: {
      primary: { weight: 1.0, segments: true },
      page: { weight: 0.6, segments: true },
      description: 0.4,
    },
  }),
  row: {
    primary: (obj) => String(obj.name ?? ""),
    description: (obj) => `in ${obj.page}`,
    icon: () => "hash",
  },
  source: headerSource,
  onSelect: (obj) =>
    // The indexed `pos` is the offset of the header inside its page, which is
    // precise even for duplicate header names.
    editor.navigate({
      path: `${obj.page}.md`,
      details: { type: "position", pos: obj.pos },
    } as any),
};

/** Recency sort key of a page: the page you are on first, then pages by when
 * they were last opened, then by last modified; unknown timestamps last. */
function pageRecency(
  page: HeaderObj,
  opened: Record<string, number>,
  currentPath: string,
): number {
  const name = String(page.name);
  if (currentPath === `${name}.md`) return -Infinity;
  if (opened[name] !== undefined) return -opened[name];
  const time = new Date(page.lastModified ?? 0).getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : -time;
}

/**
 * Every header in the space, sorted the way the page picker orders pages:
 * by page recency first, headers in document order within a page. Headers of
 * meta pages (templates etc.) and of pages hidden from navigation are left
 * out -- they are not navigation targets.
 */
async function headerSource(): Promise<HeaderObj[]> {
  if (!(await index.isAvailable())) return [];
  const [headers, pages, opened, path] = await Promise.all([
    index.queryLuaObjects<HeaderObj>("header", {} as any),
    index.queryLuaObjects<HeaderObj>("page", {} as any),
    editor.getLastOpenedMap(),
    editor.getCurrentPath(),
  ]);

  const skipPages = new Set(
    pages
      .filter((page) => isMetaPage(page) || isHiddenPage(page))
      .map((page) => String(page.name)),
  );
  const recency = new Map<string, number>();
  for (const page of pages) {
    recency.set(String(page.name), pageRecency(page, opened, path));
  }

  return headers
    .filter((header) => !skipPages.has(String(header.page)))
    .sort((a, b) => {
      const pageOrder =
        (recency.get(String(a.page)) ?? Number.MAX_SAFE_INTEGER) -
        (recency.get(String(b.page)) ?? Number.MAX_SAFE_INTEGER);
      if (pageOrder !== 0) return pageOrder;
      return (a.pos ?? 0) - (b.pos ?? 0);
    });
}
