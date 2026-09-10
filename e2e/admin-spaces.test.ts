import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  getFreePort,
  waitForServer,
} from "./fixtures";

let proc: ChildProcess;
let rootDir: string;
let base: string;

const BIN = "./target/debug/silverbullet";
const CWD = join(import.meta.dirname, "..");

test.beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sb-admin-spaces-e2e-"));

  // Same non-interactive provisioning as e2e/multi-space-admin.test.ts: the
  // `setup` subcommand writes users.json (the admin account) + an empty
  // spaces.json, which is what boots the server into multi-space mode.
  execFileSync(
    BIN,
    ["setup", rootDir, "--admin", `${ADMIN_USER}:${ADMIN_PASSWORD}`],
    {
      cwd: CWD,
      stdio: "pipe",
    },
  );

  const port = await getFreePort();
  proc = spawn(BIN, [rootDir, "-p", String(port), "-L", "127.0.0.1"], {
    cwd: CWD,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
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

// Log in through the admin UI before each test, so the browser context's
// cookie jar (shared with `page.request` below) carries the admin session
// for both UI navigation and direct API calls.
test.beforeEach(async ({ page }) => {
  await page.goto(`${base}/.spaces`);
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "Sections", exact: true })
      .locator('[aria-current="page"]'),
  ).toHaveText("Spaces");
});

/** Create a space directly via the admin API (full-config POST) and return its id. */
async function createSpaceViaApi(
  page: Page,
  config: Record<string, unknown>,
): Promise<string> {
  const resp = await page.request.post(`${base}/.spaces/api/admin/spaces`, {
    data: config,
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const json = await resp.json();
  return json.id;
}

/** Fetch a single space's config via the admin API. */
async function fetchSpaceViaApi(page: Page, id: string): Promise<any> {
  const resp = await page.request.get(`${base}/.spaces/api/admin/spaces/${id}`);
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return resp.json();
}

/**
 * Call an admin API endpoint (e.g. `api/admin/users`) using the given page's
 * session cookie, and return the parsed JSON body.
 */
async function admin(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const resp = await page.request.fetch(`${base}/.spaces/${path}`, {
    method,
    data: body,
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return resp.json();
}

test("editing a space preserves fields the form does not manage", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Work",
    binding: { prefix: "/work" },
    themeColor: "#ff0000",
    description: "Custom description",
    revisions: "managed",
  });

  await page.goto(`${base}/.spaces`);
  // The name opens the space itself; the admin-only Edit control at the end
  // of the row is the durable edit route.
  await page.getByRole("link", { name: "Settings for Work" }).click();
  await expect(page).toHaveURL(`${base}/.spaces/${encodeURIComponent(id)}`);
  await page.getByLabel("Name").fill("Renamed");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();

  await expect(page.getByRole("status")).toHaveText("Saved");
  // The canonical edit URL still resolves directly, with the saved value.
  await page.goto(`${base}/.spaces/${encodeURIComponent(id)}`);
  await expect(page.getByLabel("Name")).toHaveValue("Renamed");

  const after = await fetchSpaceViaApi(page, id);
  expect(after.name).toBe("Renamed");
  expect(after.themeColor).toBe("#ff0000");
  expect(after.description).toBe("Custom description");
  expect(after.revisions).toBe("managed");
});

test("saving an existing space stays on its settings with confirmation", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Feedback",
    binding: { prefix: "/feedback" },
  });
  await page.goto(`${base}/.spaces/${encodeURIComponent(id)}`);
  await page.getByLabel("Name").fill("Feedback Renamed");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page).toHaveURL(`${base}/.spaces/${encodeURIComponent(id)}`);
  await expect(page.getByRole("status")).toHaveText("Saved");
  await expect(
    page.getByRole("heading", { name: "Feedback Renamed", exact: true }),
  ).toBeVisible();
});

test("the shell allow list is editable, and only shown when shell is enabled", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Shell",
    binding: { prefix: "/shell" },
    shell: { enabled: true, whitelist: ["git"] },
  });

  await page.goto(`${base}/.spaces/${encodeURIComponent(id)}?section=advanced`);

  const allowed = page.getByLabel("Allowed commands");
  await expect(allowed).toHaveValue("git");

  // The field belongs to the toggle above it: with shell commands off there
  // is nothing for an allow list to restrict.
  await page.getByLabel("Enable shell commands").uncheck();
  await expect(allowed).toBeHidden();
  await page.getByLabel("Enable shell commands").check();
  await expect(allowed).toHaveValue("git");

  await allowed.fill("git pandoc");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");

  const after = await fetchSpaceViaApi(page, id);
  expect(after.shell).toEqual({ enabled: true, whitelist: ["git", "pandoc"] });
});

test("switching a host-bound space to prefix without a value is rejected", async ({
  page,
}) => {
  // A host-bound space: editing it never seeds the (unused) `prefix` field.
  // Switching the Binding dropdown to "URL prefix" must not let an empty
  // prefix through — that would silently rebind the space to the server root.
  const id = await createSpaceViaApi(page, {
    name: "Hostname Space",
    binding: { host: "hostname-space.example.com" },
  });

  await page.goto(`${base}/.spaces/${encodeURIComponent(id)}`);

  // The hostname affix describes the public URL, not this admin session's:
  // always https (TLS is required), whatever port the server this page came
  // from happens to be listening on. Nothing trails the hostname.
  await expect(page.locator(".sb-url-affix")).toHaveText(["https://"]);

  await page.getByLabel("Binding").selectOption("prefix");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();

  await expect(page.locator(".sb-alert-error")).toContainText(
    "prefix is required",
  );
  // Saving must have been aborted client-side: still on the edit URL.
  await expect(page).toHaveURL(`${base}/.spaces/${encodeURIComponent(id)}`);

  // The important assertion: the stored binding is unchanged, i.e. the PATCH
  // never went through. An error message next to a binding that quietly
  // changed anyway would be worse than no guard at all.
  const after = await fetchSpaceViaApi(page, id);
  expect(after.binding).toEqual({ host: "hostname-space.example.com" });
});

test("user create and detail screens have refreshable URLs", async ({
  page,
}) => {
  await page.getByRole("link", { name: "Users" }).click();
  // The tab labels the screen and must be marked as the current page.
  await expect(page.locator("[aria-current=page]")).toHaveText("Users");
  await expect(page).toHaveURL(`${base}/.spaces/users`);
  await page.getByRole("link", { name: "Create user" }).click();
  await expect(page).toHaveURL(`${base}/.spaces/users/new`);

  await page.getByLabel("Username").fill("route-user");
  await page.getByLabel("Password", { exact: true }).fill("password123");
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page).toHaveURL(`${base}/.spaces/users/route-user`);
  await expect(page.getByRole("heading", { name: "route-user" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "route-user" })).toBeVisible();

  // A direct visit without a session goes through login and returns to the
  // requested detail screen rather than dropping back at the list.
  await page.context().clearCookies();
  await page.goto(`${base}/.spaces/users/route-user`);
  await expect(page).toHaveURL(/\/\.spaces\/login\?next=/);
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(`${base}/.spaces/users/route-user`);
});

test("the wordmark's app icon loads, including on a nested URL", async ({
  page,
}) => {
  // A broken <img> still lays out, so assert the bytes actually arrived. The
  // nested URL is the real risk: the asset path is relative, and only the
  // page's <base href="/.spaces/"> stops it resolving against /.spaces/users/.
  await page.goto(`${base}/.spaces/users`);
  const icon = page.locator(".sb-wordmark img");
  await expect(icon).toBeVisible();
  expect(
    await icon.evaluate((img: HTMLImageElement) => img.naturalWidth > 0),
  ).toBe(true);
});

test("a non-admin sees only their spaces and no admin affordances", async ({
  page,
}) => {
  // The file's beforeEach already established an admin session on `page`; use
  // it to create a member user and a space they belong to via the admin API.
  await admin(page, "POST", "api/admin/users", {
    username: "member",
    password: "memberpw123",
  });
  await admin(page, "POST", "api/admin/spaces", {
    name: "Members Only",
    folder: join(rootDir, "members-only"),
    binding: { prefix: "/members" },
    members: { member: {} },
    seedIndex: true,
  });

  // Drop the admin session and log in as the member instead.
  await page.context().clearCookies();
  await page.goto(`${base}/.spaces/login`);
  await page.fill("#username", "member");
  await page.fill("#password", "memberpw123");
  await page.click("button[type=submit]");

  await expect(page.locator(".sb-space-list li")).toHaveCount(1);
  await expect(page.locator("text=Members Only")).toBeVisible();
  const tabs = page.getByRole("navigation", { name: "Sections", exact: true });
  await expect(
    page.getByRole("button", { name: "Profile menu", exact: true }),
  ).toBeVisible();
  await expect(tabs.getByRole("link", { name: "Spaces" })).toHaveCount(1);
  await expect(tabs.getByRole("link", { name: "Users" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Add space" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Spaces" })).toBeVisible();

  // Typing an admin URL yields the not-found screen, not the user list.
  await page.goto(`${base}/.spaces/users`);
  await expect(page.locator("h1")).toHaveText("Not found");

  // And the API refuses regardless of what the UI renders. The caller is
  // authenticated (just not an admin), so this is 403, not 401.
  const resp = await page.request.get(`${base}/.spaces/api/admin/users`);
  expect(resp.status()).toBe(403);
});

test("leaving settings warns about drafts but switching sections preserves them", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Notebook",
    binding: { prefix: "/notebook" },
    revisions: "managed",
  });
  await page.goto(`${base}/.spaces/${encodeURIComponent(id)}`);
  await page.getByLabel("Name", { exact: true }).fill("Edited notebook");
  await page
    .getByRole("navigation", { name: "Space settings" })
    .getByRole("link", { name: "Revisions" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Git sync", exact: true }),
  ).toBeVisible();
  let warned = false;
  page.once("dialog", async (dialog) => {
    warned = true;
    expect(dialog.message()).toContain("unsaved space settings");
    await dialog.dismiss();
  });
  await page.getByRole("link", { name: "← All spaces", exact: true }).click();
  expect(warned).toBe(true);
  await page
    .getByRole("navigation", { name: "Space settings" })
    .getByRole("link", { name: "General" })
    .click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Edited notebook",
  );
});

test("settings sections preserve drafts and save only the visible group", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Section notebook",
    binding: { prefix: "/section-notebook" },
    shell: { enabled: false, whitelist: ["git"] },
  });
  await page.goto(`${base}/.spaces/${encodeURIComponent(id)}`);
  const navigation = page.getByRole("navigation", { name: "Space settings" });
  await expect(page.locator(".sb-management-sidebar")).toHaveCount(1);
  await expect(
    page
      .getByRole("navigation", { name: "Sections", exact: true })
      .getByRole("link"),
  ).toHaveText(["Spaces", "Users", "Profile", "Admin"]);
  await expect(navigation).toHaveClass(/sb-tabs/);
  await expect(navigation.getByRole("link")).toHaveText([
    "General",
    "Access",
    "Revisions",
    "Advanced",
  ]);
  await page.getByLabel("Name", { exact: true }).fill("Draft notebook");
  await expect(
    navigation.getByRole("link", { name: "General", exact: true }),
  ).toHaveAttribute("data-dirty", "true");
  await navigation.getByRole("link", { name: "Advanced" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toBeHidden();
  await page.getByLabel("Enable shell commands").check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Saved" }),
  ).toBeVisible();
  const after = await fetchSpaceViaApi(page, id);
  expect(after.name).toBe("Section notebook");
  expect(after.shell).toEqual({ enabled: true, whitelist: ["git"] });
  await navigation.getByRole("link", { name: "General" }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Draft notebook",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  await page.goBack();
  await expect(page.getByLabel("Enable shell commands")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Enable shell commands")).toBeVisible();
});

test("mobile settings use a section selector without horizontal overflow", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Pocket notebook",
    binding: { prefix: "/pocket-notebook" },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/.spaces/${encodeURIComponent(id)}`);
  await page.getByLabel("Settings section").selectOption("access");
  await expect(
    page.getByRole("group", { name: "Who has access", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Space settings" }),
  ).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("canceling logout keeps the session and unsaved settings", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Draft notebook",
    folder: "spaces/draft-notebook",
    binding: { prefix: "/draft-notebook" },
  });
  await page.goto(`${base}/.spaces/${id}`);
  await page.getByLabel("Name", { exact: true }).fill("Saved notebook");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Profile menu", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  expect((await page.request.get(`${base}/.spaces/api/session`)).ok()).toBe(
    true,
  );
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Saved notebook",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status", { exact: true })).toHaveText("Saved");
  await page.getByLabel("Name", { exact: true }).fill("Another draft");
  let confirmations = 0;
  page.on("dialog", async (dialog) => {
    confirmations++;
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Profile menu", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(`${base}/.spaces/login?signedOut=true`);
  await expect(
    page.getByRole("heading", { name: "You are signed out" }),
  ).toBeVisible();
  expect(confirmations).toBe(1);
});

test("finish or cancel Git setup before changing revision mode", async ({
  page,
}) => {
  const id = await createSpaceViaApi(page, {
    name: "Revision notebook",
    folder: "spaces/revision-notebook",
    binding: { prefix: "/revision-notebook" },
    revisions: "managed",
  });
  await page.goto(`${base}/.spaces/${id}?section=revisions`);
  await page
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await expect(page.getByLabel("Mode", { exact: true })).toBeDisabled();
  await expect(
    page.getByText(
      "Finish or cancel Git setup below before changing revision mode.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Mode", { exact: true })).toBeEnabled();
  await page.getByLabel("Mode", { exact: true }).selectOption("disabled");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status", { exact: true })).toHaveText("Saved");
  await page.getByRole("link", { name: "← All spaces", exact: true }).click();
  await expect(page).toHaveURL(`${base}/.spaces/`);
});

test("the shared profile menu replaces account navigation in the header", async ({
  page,
}) => {
  await expect(page.getByRole("link", { name: "admin's Profile" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Log out", exact: true }),
  ).toHaveCount(0);
  const trigger = page.getByRole("button", {
    name: "Profile menu",
    exact: true,
  });
  await trigger.click();
  const menu = page.locator(".sb-anchored-menu");
  await expect(menu.getByRole("button")).toHaveText([
    "Edit profile",
    "All spaces",
    "Log out",
  ]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await menu.getByRole("button", { name: "Edit profile", exact: true }).click();
  await expect(page).toHaveURL(`${base}/.spaces/profile`);
  await page.getByLabel("Full name").fill("Taylor Example");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await trigger.click();
  await expect(menu.locator(".sb-anchored-menu-title")).toHaveText(
    "Taylor Example",
  );
  await expect(trigger).toHaveText("TE");
  await menu.getByRole("button", { name: "All spaces", exact: true }).click();
  await expect(page).toHaveURL(`${base}/.spaces/`);
});

test("Admin defaults to Server and preserves Authentication links", async ({
  page,
}, testInfo) => {
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await expect(page).toHaveURL(`${base}/.spaces/admin`);
  await expect(
    page.getByRole("heading", { name: "Admin", exact: true }),
  ).toBeVisible();
  const sections = page.getByRole("navigation", { name: "Admin settings" });
  await expect(
    sections.getByRole("link", { name: "Server", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByLabel("Primary URL", { exact: true })).toBeVisible();
  await sections
    .getByRole("link", { name: "Authentication", exact: true })
    .click();
  await page.getByRole("button", { name: "Set up SSO" }).click();
  await expect(page.getByLabel("Provider", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("admin-authentication-desktop.png"),
  });
  await page.goto(`${base}/.spaces/authentication`);
  await expect(
    page.getByRole("heading", { name: "Admin", exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Sections", exact: true })
      .locator('[aria-current="page"]'),
  ).toHaveText("Admin");
  await sections.getByRole("link", { name: "Authentication" }).click();
  await expect(page).toHaveURL(`${base}/.spaces/admin?section=authentication`);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Set up SSO", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sections).toBeHidden();
  await expect(page.getByLabel("Settings section")).toHaveValue(
    "authentication",
  );
  await page.getByRole("button", { name: "Set up SSO" }).click();
  await expect(page.getByLabel("Provider", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("admin-authentication-mobile.png"),
  });
});

test("Admin settings remain inaccessible to non-admin accounts", async ({
  page,
  browser,
}) => {
  const created = await page.request.post(`${base}/.spaces/api/admin/users`, {
    data: { username: "casey", password: "casey-password", admin: false },
  });
  expect(created.ok()).toBe(true);
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    const login = await member.request.post(`${base}/.spaces/api/login`, {
      data: { username: "casey", password: "casey-password" },
    });
    expect(login.ok()).toBe(true);
    for (const path of ["admin", "authentication"]) {
      await member.goto(`${base}/.spaces/${path}`);
      await expect(
        member.getByRole("link", { name: "Admin", exact: true }),
      ).toHaveCount(0);
      await expect(
        member.getByRole("heading", { name: "Not found" }),
      ).toBeVisible();
      await expect(
        member.getByRole("button", { name: "Set up SSO" }),
      ).toHaveCount(0);
    }
    expect(
      (
        await member.request.get(`${base}/.spaces/api/admin/authentication`)
      ).status(),
    ).toBe(403);
  } finally {
    await context.close();
  }
});

test("access grid preserves permission dependencies and saved grants", async ({
  page,
}, testInfo) => {
  await admin(page, "POST", "api/admin/users", {
    username: "morgan",
    password: "morgan-password",
    admin: false,
  });
  const id = await createSpaceViaApi(page, {
    name: "Permissions",
    binding: { prefix: "/permissions" },
  });
  await page.goto(`${base}/.spaces/${id}?section=access`);
  const read = page.getByRole("checkbox", {
    name: "morgan: Read",
    exact: true,
  });
  const write = page.getByRole("checkbox", {
    name: "morgan: Write",
    exact: true,
  });
  await expect(read).not.toBeChecked();
  await write.check();
  await expect(read).toBeChecked();
  await write.uncheck();
  await expect(read).toBeChecked();
  await write.check();
  await read.uncheck();
  await expect(write).not.toBeChecked();
  await write.check();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await fetchSpaceViaApi(page, id)).members.morgan.role).toBe("write");
  await page.reload();
  await expect(read).toBeChecked();
  await expect(write).toBeChecked();
  const adminWrite = page.getByRole("checkbox", {
    name: `${ADMIN_USER}: Write`,
    exact: true,
  });
  await expect(adminWrite).toBeChecked();
  await expect(adminWrite).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("access-grid-desktop.png"),
  });
  await page.getByRole("checkbox", { name: "Freeze this space" }).check();
  await expect(write).toBeDisabled();
  await expect(write).toBeChecked();
  await page.getByRole("checkbox", { name: "Freeze this space" }).uncheck();
  await expect(write).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("access-grid-mobile.png"),
  });
  await read.uncheck();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
  expect((await fetchSpaceViaApi(page, id)).members?.morgan).toBeUndefined();
});

test("Spaces filtering supports keyboard targeting without opening until Enter", async ({
  page,
}) => {
  await createSpaceViaApi(page, {
    name: "Keyboard Cedar",
    binding: { prefix: "/keyboard-cedar" },
  });
  await createSpaceViaApi(page, {
    name: "Keyboard Maple",
    binding: { prefix: "/keyboard-maple" },
  });
  await page.reload();
  const filter = page.getByRole("textbox", { name: "Filter spaces" });
  await expect(filter).toBeVisible({ timeout: 3000 });
  await filter.fill("Keyboard");
  const rows = page.locator(".sb-management-row");
  await expect(rows).toHaveCount(2);
  const managerUrl = page.url();
  await expect(rows.nth(0)).toHaveAttribute("data-target", "true");
  await filter.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("data-target", "true");
  await filter.press("ArrowUp");
  await expect(rows.nth(0)).toHaveAttribute("data-target", "true");
  const settings = rows
    .nth(1)
    .getByRole("link", { name: "Settings for Keyboard Maple" });
  await settings.focus();
  await expect(rows.nth(1)).toHaveAttribute("data-target", "true");
  await expect(rows.nth(0)).not.toHaveAttribute("data-target", "true");
  const firstLink = rows.nth(0).locator(".sb-space-link");
  await firstLink.focus();
  await firstLink.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("data-target", "true");
  expect(page.url()).toBe(managerUrl);
  await firstLink.press("Escape");
  await expect(filter).toHaveValue("");
  await filter.fill("no matching space");
  await expect(rows).toHaveCount(0);
  await filter.press("Enter");
  expect(page.url()).toBe(managerUrl);
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await filter.fill("Keyboard Maple");
  await rows
    .first()
    .getByRole("link", { name: "Settings for Keyboard Maple" })
    .press("Enter");
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await page.goBack();
  await filter.fill("Keyboard Maple");
  await expect(
    rows.first().getByRole("link", { name: "Settings for Keyboard Maple" }),
  ).toBeVisible();
  await filter.press("Enter");
  await expect(page).toHaveURL(/\/keyboard-maple\//);
});

test("main page titles align and Spaces does not move when its list loads", async ({
  page,
}) => {
  const sections = page.getByRole("navigation", {
    name: "Sections",
    exact: true,
  });
  const positions: { x: number; y: number }[] = [];
  for (const name of ["Spaces", "Users", "Profile", "Admin"]) {
    await sections.getByRole("link", { name, exact: true }).click();
    const heading = page.getByRole("heading", { name, exact: true });
    await expect(heading).toBeVisible();
    await expect(page.getByText("Loading…", { exact: true })).toBeHidden();
    await page.evaluate(() => document.fonts.ready);
    const box = await heading.boundingBox();
    expect(box).not.toBeNull();
    positions.push({ x: box!.x, y: box!.y });
  }
  for (const position of positions) {
    expect(Math.abs(position.x - positions[0].x)).toBeLessThan(0.5);
    expect(Math.abs(position.y - positions[0].y)).toBeLessThan(0.5);
  }
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/.spaces/api/spaces", async (route) => {
    await pending;
    await route.continue();
  });
  try {
    await sections.getByRole("link", { name: "Spaces", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Add space", exact: true }),
    ).toBeVisible();
    const heading = page.getByRole("heading", { name: "Spaces", exact: true });
    const filter = page.getByRole("textbox", { name: "Filter spaces" });
    const before = [await heading.boundingBox(), await filter.boundingBox()];
    release();
    await expect(page.getByText("Loading…", { exact: true })).toBeHidden();
    expect([await heading.boundingBox(), await filter.boundingBox()]).toEqual(
      before,
    );
  } finally {
    release();
    await page.unroute("**/.spaces/api/spaces");
  }
});
