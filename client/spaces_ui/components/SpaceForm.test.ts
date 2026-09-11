import { h } from "preact";
import { render } from "preact-render-to-string";
import { expect, test } from "vitest";
import { SpaceForm } from "./SpaceForm.tsx";

test("new spaces start with managed revisions and shell commands disabled", () => {
  (globalThis as any).location = { origin: "http://localhost:3000" };
  const html = render(
    h(SpaceForm, {
      onSaved: () => {},
      cancelHref: "/.spaces/",
      onDeleted: () => {},
      onUnauthorized: () => {},
    }),
  );

  expect(html).toMatch(/<option[^>]*selected[^>]*value="managed"[^>]*>/);
  expect(html).toMatch(
    /<h3>Shell commands<\/h3><label><input(?![^>]*checked)[^>]*type="checkbox"[^>]*>/,
  );
  delete (globalThis as any).location;
});
