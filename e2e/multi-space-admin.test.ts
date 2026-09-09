import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  getFreePort,
  waitForEditorReady,
  waitForServer,
} from "./fixtures";

let proc: ChildProcess;
let rootDir: string;
let base: string;

const BIN = "./target/debug/silverbullet";
const CWD = join(import.meta.dirname, "..");

test.beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sb-multi-e2e-"));

  // The setup subcommand writes the admin account and an empty spaces.json,
  // which selects multi-space mode. SB_USER is invalid alongside spaces.json.
  execFileSync(
    BIN,
    [
      "setup",
      rootDir,
      "--admin",
      `${ADMIN_USER}:${ADMIN_PASSWORD}`,
      // No --space: start with an empty server and create the first space
      // through the admin UI below (what this test exercises).
    ],
    { cwd: CWD, stdio: "pipe" },
  );

  const port = await getFreePort();
  proc = spawn(BIN, [rootDir, "-p", String(port), "-L", "127.0.0.1"], {
    cwd: CWD,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // See fixtures.ts: with the service worker disabled and `?headless=1` on
      // navigation, the client uses its own in-page runtime, so the server
      // never needs to spawn a headless Chrome for the runtime API.
      SB_RUNTIME_API: "0",
      SB_DISABLE_SERVICE_WORKER: "1",
    },
  });
  base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/.spaces`);
});

test.afterAll(async () => {
  proc?.kill();
  await rm(rootDir, { recursive: true, force: true });
});

test("first run: login, create a space, open it, edit a page", async ({
  page,
}) => {
  // With no root-bound space, / redirects (307) to the unified `/.spaces`
  // surface, which then bounces an unauthenticated visitor to its login
  // screen.
  await page.goto(`${base}/`);
  await expect(page).toHaveURL(/\/\.spaces\/login/);

  // Log in with the admin account created by `setup`.
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  // Empty list -> create a space on its own URL.
  await expect(page.getByText("No spaces yet")).toBeVisible();
  await page.getByRole("link", { name: "Create space" }).click();
  await expect(page).toHaveURL(`${base}/.spaces/new`);
  await page.getByLabel("Name").fill("Playground");
  await page.getByLabel("Prefix").fill("/play");
  await expect(page.locator("#space-folder")).toHaveValue("spaces/playground");
  await expect(page.getByRole("button", { name: "Browse…" })).toBeVisible();
  await page.getByRole("button", { name: "Create" }).click();

  await expect(page).toHaveURL(/\/\.spaces\/[^/]+$/);
  await page.getByRole("link", { name: "Access", exact: true }).click();
  await page.locator(".sb-access-public select").selectOption("write");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.getByRole("link", { name: "Spaces", exact: true }).click();

  // It shows up in the list.
  await expect(page.getByText("Playground")).toBeVisible();

  await page.goto(`${base}/play/?headless=1`);
  await page
    .locator("#sb-editor .cm-editor")
    .waitFor({ state: "visible", timeout: 30_000 });
  await waitForEditorReady(page);

  // Type into the page and confirm content sticks.
  const editor = page.locator("#sb-editor .cm-content");
  await editor.click();
  await page.keyboard.type("Hello from multi-space");
  await expect(editor).toContainText("Hello from multi-space");
});

test("user settings sections preserve drafts and confirm successful saves", async ({
  page,
}) => {
  await page.request.post(`${base}/.spaces/api/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  await page.goto(`${base}/.spaces/users`);
  await expect(
    page.getByRole("columnheader", { name: "Last login" }),
  ).toBeVisible();
  const lastLogin = page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: ADMIN_USER, exact: true }) })
    .locator("time");
  await expect(lastLogin).toBeVisible();
  expect(Date.parse((await lastLogin.getAttribute("datetime"))!)).not.toBeNaN();
  await page.goto(`${base}/.spaces/users/${ADMIN_USER}`);
  const sidebar = page.getByRole("navigation", { name: "User settings" });
  await expect(sidebar).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Full name", { exact: true }).fill("Morgan Rivers");
  await sidebar.getByRole("link", { name: "API tokens" }).click();
  await expect(
    page.getByRole("heading", { name: "Profile", exact: true }),
  ).toBeHidden();
  await sidebar.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(
    "Morgan Rivers",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Profile saved.");
  await page.reload();
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(
    "Morgan Rivers",
  );
  await page.route("**/.spaces/api/admin/users/*/profile", (route) =>
    route.fulfill({ status: 500, body: "Could not save profile" }),
  );
  await page.getByLabel("Full name", { exact: true }).fill("Unsaved draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.locator(".sb-alert-error")).toBeVisible();
  await page.unroute("**/.spaces/api/admin/users/*/profile");
  await sidebar.getByRole("link", { name: "API tokens" }).click();
  await page.getByRole("textbox", { name: "Token name" }).fill("settings-test");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("API token created.");
  await sidebar.getByRole("link", { name: "Profile", exact: true }).click();
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(
    "Unsaved draft",
  );
  await sidebar.getByRole("link", { name: "API tokens" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).toBeHidden();
  await page
    .getByLabel("Settings section", { exact: true })
    .selectOption("security");
  await expect(
    page.getByRole("heading", { name: "Password", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "API tokens", exact: true }),
  ).toBeVisible();
});
