import { afterEach, beforeEach, expect, test } from "vitest";
import { bindingLabel, spaceUrl } from "./bindings.ts";

// `bindingLabel`/`spaceUrl` read the browser `location` global (for the
// listener port on host-bound spaces). Vitest's default "node" environment
// doesn't define it, so stub it the way a `test.localhost:3000` admin page
// would see it.
beforeEach(() => {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).location = { port: "3000" };
});

afterEach(() => {
  // deno-lint-ignore no-explicit-any
  delete (globalThis as any).location;
});

test('spaceUrl normalizes a bare-root prefix of "" to "/"', () => {
  expect(spaceUrl({ prefix: "" })).toBe("/");
});

test('spaceUrl normalizes a literal "/" prefix to "/", not "//"', () => {
  // The server accepts a bare "/" prefix. Appending another slash would
  // produce an invalid protocol-relative URL.
  expect(spaceUrl({ prefix: "/" })).toBe("/");
});

test("spaceUrl appends a trailing slash to a normal prefix", () => {
  expect(spaceUrl({ prefix: "/foo" })).toBe("/foo/");
});

test("spaceUrl doesn't double up a prefix that already ends in a slash", () => {
  expect(spaceUrl({ prefix: "/foo/" })).toBe("/foo/");
});

test("spaceUrl for a host binding ignores the prefix and uses the listener port", () => {
  expect(spaceUrl({ host: "test.localhost" })).toBe("//test.localhost:3000/");
});

test('bindingLabel shows a bare-root prefix as "/"', () => {
  expect(bindingLabel({ prefix: "" })).toBe("/");
  expect(bindingLabel({ prefix: "/" })).toBe("/");
});

test("bindingLabel shows a host binding with its listener port", () => {
  expect(bindingLabel({ host: "test.localhost" })).toBe("test.localhost:3000");
});

test("space entry carries central encryption to the destination hostname while preserving ordinary links", async () => {
  (globalThis as any).location = {
    port: "3000",
    href: "https://login.sb.test:3000/.spaces/",
  };
  const { spaceEntryUrl } = await import("./bindings.ts");
  expect(spaceEntryUrl({ host: "notes.test" }, false)).toBe(
    "//notes.test:3000/",
  );
  const encrypted = new URL(spaceEntryUrl({ host: "notes.test" }, true));
  expect(encrypted.origin).toBe("https://notes.test:3000");
  expect(encrypted.pathname).toBe("/.auth/central/start");
  expect(encrypted.searchParams.get("destination")).toBe(
    "https://notes.test:3000/",
  );
  expect(encrypted.searchParams.get("encrypt")).toBe("true");
  expect(
    new URL(spaceEntryUrl({ prefix: "/notes" }, true)).searchParams.get(
      "destination",
    ),
  ).toBe("https://login.sb.test:3000/notes/");
});
