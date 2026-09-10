import { expect, test } from "./fixtures.ts";

test("configuration tabs switch with arrow keys and preserve the editor", async ({
  sbPage,
}) => {
  const before = await sbPage.evaluate(() =>
    (globalThis as any).client.editorView.state.doc.toString(),
  );
  await sbPage.evaluate(() =>
    (globalThis as any).client.runCommandByName("Configuration: Open"),
  );
  const frame = sbPage.frameLocator(".sb-modal iframe");
  const first = frame.getByRole("tab", { name: "Configuration", exact: true });
  await expect(first).toBeVisible();
  await expect(
    frame.getByRole("textbox", { name: "Filter configuration options..." }),
  ).toBeFocused();
  await first.focus();
  await sbPage.keyboard.press("ArrowRight");
  const shortcuts = frame.getByRole("tab", {
    name: "Keyboard Shortcuts",
    exact: true,
  });
  await expect(shortcuts).toBeFocused();
  await expect(shortcuts).toHaveAttribute("aria-selected", "true");
  await sbPage.keyboard.press("End");
  await expect(
    frame.getByRole("tab", { name: "Libraries", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await sbPage.keyboard.press("Home");
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute("aria-selected", "true");
  expect(
    await sbPage.evaluate(() =>
      (globalThis as any).client.editorView.state.doc.toString(),
    ),
  ).toBe(before);
});

test("UI font loads inside configuration panels without changing the editor font", async ({
  sbPage,
}) => {
  await sbPage.evaluate(() =>
    (globalThis as any).client.runCommandByName("Configuration: Open"),
  );
  const frame = sbPage.frameLocator(".sb-modal iframe");
  const tab = frame.getByRole("tab", { name: "Configuration", exact: true });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveCSS("font-family", /iA-Mono/);
  const loaded = await tab.evaluate(
    async () => (await document.fonts.load('13px "iA-Mono"')).length,
  );
  expect(loaded).toBeGreaterThan(0);
  await expect(
    frame.getByRole("textbox", { name: "Filter configuration options..." }),
  ).toHaveCSS("font-family", /iA-Mono/);
  expect(
    await sbPage.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--editor-font")
        .trim(),
    ),
  ).toBe('"iA-Mono", "Menlo"');
});
