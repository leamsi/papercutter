import {
  expect,
  gotoSilverBulletPage,
  test,
  waitForSaveAndReadFromServer,
} from "./fixtures.ts";

test.describe("Task management", () => {
  test.use({
    spaceFiles: {
      "Tasks.md":
        "# My Tasks\n* [ ] Buy groceries\n* [ ] Write tests\n* [x] Already done",
    },
  });

  test("task checkboxes render", async ({ sbServer, page }) => {
    await gotoSilverBulletPage(page, sbServer, "Tasks");
    const editor = page.locator("#sb-editor .cm-content");

    await expect(page.locator("#sb-current-page input.sb-input")).toHaveValue(
      "Tasks",
    );
    await expect(editor).toContainText("Buy groceries");

    // Task checkboxes render as <span class="sb-checkbox"><input type="checkbox"></span>
    const checkboxes = page.locator(".sb-checkbox input[type='checkbox']");
    await expect(checkboxes.first()).toBeVisible({ timeout: 10_000 });
    await expect(checkboxes).toHaveCount(3);

    await expect(checkboxes.nth(2)).toBeChecked();
    await expect(checkboxes.nth(0)).not.toBeChecked();
    await expect(checkboxes.nth(1)).not.toBeChecked();
  });

  test("toggle task state saves to server", async ({ sbServer, page }) => {
    await gotoSilverBulletPage(page, sbServer, "Tasks");
    const editor = page.locator("#sb-editor .cm-content");

    await expect(editor).toContainText("Buy groceries");

    const firstCheckbox = page
      .locator(".sb-checkbox input[type='checkbox']")
      .first();
    await expect(firstCheckbox).toBeVisible({ timeout: 10_000 });
    await expect(firstCheckbox).not.toBeChecked();

    await firstCheckbox.click();

    await expect(firstCheckbox).toBeChecked();

    const content = await waitForSaveAndReadFromServer(
      page,
      sbServer,
      "Tasks.md",
    );
    expect(content).toMatch(/\* \[x\] Buy groceries/);
  });
});
