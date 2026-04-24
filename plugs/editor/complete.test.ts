import { describe, expect, test } from "vitest";
import { createMockSystem } from "../../plug-api/system_mock.ts";
import type { PageMeta } from "@silverbulletmd/silverbullet/type/index";
import type { CompleteEvent } from "@silverbulletmd/silverbullet/type/client";
import { footnoteComplete, pageComplete } from "./complete.ts";

function makeCompleteEvent(
  linePrefix: string,
  currentPage = "TestPage",
): CompleteEvent {
  return {
    linePrefix,
    pos: linePrefix.length,
    pageName: currentPage,
    parentNodes: [],
  };
}

async function indexPageMeta(name: string, tags: string[] = []): Promise<void> {
  const obj: PageMeta = {
    ref: name,
    tag: "page",
    tags,
    name,
    perm: "rw",
    lastModified: "0",
    created: "0",
  };
  await (globalThis as any).syscall("index.indexObjects", name, [obj]);
}

describe("pageComplete meta-page caret prefix", () => {
  test("[[^ returns only meta-tagged pages", async () => {
    createMockSystem();
    await indexPageMeta("CONFIG", ["meta"]);
    await indexPageMeta("Library/Std", ["meta/library"]);
    await indexPageMeta("RegularPage", []);

    const result = await pageComplete(makeCompleteEvent("[[^"));
    expect(result).toBeTruthy();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("^CONFIG");
    expect(labels).toContain("^Library/Std");
    expect(labels).not.toContain("RegularPage");
    expect(labels).not.toContain("^RegularPage");
  });

  test("[[^CON keeps the caret prefix on labels and `from` covers it", async () => {
    createMockSystem();
    await indexPageMeta("CONFIG", ["meta"]);

    const linePrefix = "[[^CON";
    const result = await pageComplete(makeCompleteEvent(linePrefix));
    expect(result).toBeTruthy();
    // `from` must be the position right before the caret so CodeMirror
    // filters `^CON` against `^CONFIG` (a direct prefix match).
    expect(result!.from).toBe(linePrefix.length - "^CON".length);
    expect(result!.options.map((o) => o.label)).toContain("^CONFIG");
  });

  test("[[ without caret excludes meta pages", async () => {
    createMockSystem();
    await indexPageMeta("CONFIG", ["meta"]);
    await indexPageMeta("RegularPage", []);

    const result = await pageComplete(makeCompleteEvent("[["));
    expect(result).toBeTruthy();
    const labels = result!.options.map((o) => o.label);
    expect(labels).toContain("RegularPage");
    expect(labels).not.toContain("CONFIG");
    expect(labels).not.toContain("^CONFIG");
  });
});

describe("footnoteComplete does not collide with [[^ wikilinks (#1966)", () => {
  // Footnote completion must not match inside meta-page links: mismatched
  // from positions cause the client to discard merged completions.

  test("[[^ returns null", async () => {
    expect(await footnoteComplete(makeCompleteEvent("[[^"))).toBeNull();
  });

  test("[[^CON returns null", async () => {
    expect(await footnoteComplete(makeCompleteEvent("[[^CON"))).toBeNull();
  });

  test("![[^ (image embed) returns null", async () => {
    expect(await footnoteComplete(makeCompleteEvent("![[^"))).toBeNull();
  });

  test("triple bracket [[[^foo also returns null", async () => {
    expect(await footnoteComplete(makeCompleteEvent("[[[^foo"))).toBeNull();
  });

  test("plain text without [^ returns null", async () => {
    expect(await footnoteComplete(makeCompleteEvent("hello"))).toBeNull();
    expect(await footnoteComplete(makeCompleteEvent("[[CONFIG"))).toBeNull();
  });
});

// PaperCutter: header completions. `[[` and `[..](` completion offers the
// markdown headers of pages across the space (like ZK's LSP).
describe("pageComplete header completions", () => {
  async function indexHeader(page: string, name: string): Promise<void> {
    const obj = {
      ref: `${page}@10`,
      tag: "header",
      name,
      page,
      pos: 10,
      level: 1,
      text: name,
    };
    await (globalThis as any).syscall("index.indexObjects", page, [obj]);
  }

  test("[[ offers headers with a wikilink target", async () => {
    createMockSystem();
    await indexHeader("My Page", "My Header");

    const result = await pageComplete(makeCompleteEvent("[["));
    expect(result).toBeTruthy();
    const headerOption = result!.options.find((o) => o.type === "header");
    expect(headerOption).toBeDefined();
    expect(headerOption!.label).toBe("My Header");
    expect(headerOption!.apply).toBe("My Page#My Header|My Header");
    expect(headerOption!.detail).toBe("Header in My Page");
  });

  test("[..]( offers headers with a <>-wrapped target when it has spaces", async () => {
    createMockSystem();
    await indexHeader("My Page With Spaces", "My Header With Spaces");

    const result = await pageComplete(
      makeCompleteEvent("[Header](", "CurrentPage"),
    );
    expect(result).toBeTruthy();
    const headerOption = result!.options.find((o) => o.type === "header");
    expect(headerOption).toBeDefined();
    // Should wrap in <> due to spaces
    expect(headerOption!.apply).toBe(
      "</My Page With Spaces#My Header With Spaces>",
    );
  });

  test("[[^ (meta page caret) does not offer headers", async () => {
    createMockSystem();
    await indexHeader("My Page", "My Header");

    const result = await pageComplete(makeCompleteEvent("[[^"));
    expect(result).toBeTruthy();
    expect(result!.options.find((o) => o.type === "header")).toBeUndefined();
  });
});
