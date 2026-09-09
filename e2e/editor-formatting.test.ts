import { expect, mod, test, waitForSaveAndReadFromServer } from "./fixtures.ts";
import { createPageViaPagePicker } from "./navigator-ui.ts";

test.describe("Editor formatting", () => {
  test("bold text with Mod+B", async ({ sbPage, sbServer }) => {
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Welcome");

    await createPageViaPagePicker(sbPage, "Formatting Test");
    await expect(editor).toHaveText("");

    await editor.click();
    await sbPage.keyboard.type("make this bold");

    await sbPage.keyboard.press(`${mod}+a`);

    await sbPage.keyboard.press(`${mod}+b`);

    await expect(editor).toContainText("**make this bold**");

    const content = await waitForSaveAndReadFromServer(
      sbPage,
      sbServer,
      "Formatting Test.md",
    );
    expect(content).toContain("**make this bold**");
  });

  test("italic text with Mod+I", async ({ sbPage, sbServer }) => {
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Welcome");

    await createPageViaPagePicker(sbPage, "Italic Test");
    await expect(editor).toHaveText("");

    await editor.click();
    await sbPage.keyboard.type("make this italic");
    await sbPage.keyboard.press(`${mod}+a`);
    await sbPage.keyboard.press(`${mod}+i`);

    await expect(editor).toContainText("_make this italic_");

    const content = await waitForSaveAndReadFromServer(
      sbPage,
      sbServer,
      "Italic Test.md",
    );
    expect(content).toContain("_make this italic_");
  });

  test("bullet list with Mod+Shift+8", async ({ sbPage, sbServer }) => {
    const editor = sbPage.locator("#sb-editor .cm-content");
    await expect(editor).toContainText("Welcome");

    await createPageViaPagePicker(sbPage, "List Test");
    await expect(editor).toHaveText("");

    await editor.click();
    await sbPage.keyboard.type("First item");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("Second item");
    await sbPage.keyboard.press("Enter");
    await sbPage.keyboard.type("Third item");

    await sbPage.keyboard.press(`${mod}+a`);
    await sbPage.keyboard.press(`${mod}+Shift+8`);

    await expect(editor).toContainText("* First item");
    await expect(editor).toContainText("* Second item");
    await expect(editor).toContainText("* Third item");

    const content = await waitForSaveAndReadFromServer(
      sbPage,
      sbServer,
      "List Test.md",
    );
    expect(content).toContain("* First item");
    expect(content).toContain("* Second item");
    expect(content).toContain("* Third item");
  });
});
