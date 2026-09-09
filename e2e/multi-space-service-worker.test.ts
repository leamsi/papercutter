import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, type Page, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  getFreePort,
  waitForServer,
} from "./fixtures";

/**
 * A space bound at "/" registers its service worker at scope "/", which covers
 * every path on the origin — including the prefixes of *other* spaces. These
 * tests pin down that such a worker must not answer navigations belonging to a
 * different space with its own cached app shell: that shell carries the root
 * space's `<base href="/">`, so the client would boot resolving `.config` and
 * `/.fs/*` against the server root and silently load the wrong space.
 *
 * Unlike the rest of the multi-space e2e suite, these run with the service
 * worker ENABLED — the bug is unreachable without it.
 */

const BIN = "./target/debug/silverbullet";
const CWD = join(import.meta.dirname, "..");

type Server = {
  proc: ChildProcess;
  rootDir: string;
  base: string;
  cookie: string;
};

let server: Server;
let rootDir: string;
let base: string;

/**
 * A server of its own, with an admin session. Most tests share the one from
 * `beforeAll`; the offline test starts a second because it freezes the
 * process, which strands in-flight requests of any test sharing it.
 */
async function startServer(): Promise<Server> {
  const rootDir = await mkdtemp(join(tmpdir(), "sb-sw-scope-e2e-"));
  execFileSync(
    BIN,
    ["setup", rootDir, "--admin", `${ADMIN_USER}:${ADMIN_PASSWORD}`],
    {
      cwd: CWD,
      stdio: "pipe",
    },
  );

  const port = await getFreePort();
  const proc = spawn(BIN, [rootDir, "-p", String(port), "-L", "127.0.0.1"], {
    cwd: CWD,
    stdio: ["ignore", "pipe", "pipe"],
    // Note: SB_DISABLE_SERVICE_WORKER is deliberately NOT set here.
    env: { ...process.env, SB_RUNTIME_API: "0" },
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/.spaces`);

  const login = await fetch(`${base}/.spaces/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { proc, rootDir, base, cookie };
}

async function stopServer(server: Server) {
  server.proc.kill();
  await rm(server.rootDir, { recursive: true, force: true });
}

/** Call the admin API (nested at `/.spaces/api/admin`) as the logged-in admin. */
async function adminOn(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
) {
  const resp = await fetch(`${server.base}/.spaces/api/admin/${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: server.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`${method} ${path} -> ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

function admin(method: string, path: string, body?: unknown) {
  return adminOn(server, method, path, body);
}

/** Create a public space so the browser side needs no login. */
async function createSpace(name: string, prefix: string): Promise<string> {
  const { id } = await admin("POST", "spaces", {
    name,
    folder: join(rootDir, `${name}-space`),
    binding: { prefix },
    public: true,
    seedIndex: true,
  });
  return id;
}

/**
 * Load the root space and wait until its service worker controls the page —
 * that worker is what the assertions below guard. Each test gets a fresh
 * browser context, so this re-registers per test.
 */
async function registerRootServiceWorker(page: Page, origin: string = base) {
  await page.goto(`${origin}/`);
  await page.waitForFunction(
    () => !!navigator.serviceWorker.controller,
    undefined,
    {
      timeout: 30_000,
    },
  );
  // Let the worker finish precaching the app shell before we navigate away.
  await page.waitForTimeout(2000);
}

test.beforeAll(async () => {
  server = await startServer();
  ({ rootDir, base } = server);

  // The root-bound space whose service worker shadows the whole origin. Both
  // tests depend on it, and only one space can hold "/" — so it is created
  // once here rather than per test.
  await createSpace("root", "/");
});

test.afterAll(async () => {
  await stopServer(server);
});

test("a sibling space is not shadowed by the root space's service worker", async ({
  page,
}) => {
  await registerRootServiceWorker(page);
  await createSpace("sibling", "/sibling");

  await page.goto(`${base}/sibling/`);

  // The decisive assertion: the client must boot against the sibling space's
  // base URL. When the root worker serves its own cached shell instead, this
  // is `${base}/` and the client silently loads the root space.
  expect(await page.evaluate(() => document.baseURI)).toBe(`${base}/sibling/`);
});

test("a space moved to a different prefix still boots", async ({ page }) => {
  const id = await createSpace("moved", "/before");
  await registerRootServiceWorker(page);

  await admin("PATCH", `spaces/${id}`, { binding: { prefix: "/after" } });

  await page.goto(`${base}/after/`);

  expect(await page.evaluate(() => document.baseURI)).toBe(`${base}/after/`);
});

test("a sibling space's client assets are not answered with the app shell", async ({
  page,
}) => {
  // The root worker must proxy sibling assets instead of answering module
  // requests with its cached HTML shell. A private sibling exercises asset
  // loading before the visitor authenticates.
  await registerRootServiceWorker(page);
  await admin("POST", "spaces", {
    name: "private",
    folder: join(rootDir, "private-space"),
    binding: { prefix: "/private" },
    public: false,
    seedIndex: true,
  });

  const asset = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return {
      status: response.status,
      body: (await response.text()).slice(0, 40),
    };
  }, `${base}/private/.client/auth.js`);

  expect(asset.status).toBe(200);
  expect(asset.body).not.toContain("<!doctype");

  // And the page that needs it actually renders its form.
  await page.goto(`${base}/private/`);
  await expect(page.locator("#login")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#username")).toBeVisible();
});

test("a sibling space is not shadowed while the worker believes it is offline", async ({
  page,
}) => {
  // A ping timeout marks a slow server offline. Even then, spacePrefixes
  // must prevent the root worker answering sibling navigations from cache.
  // This test uses its own server because freezing strands all in-flight requests.
  const own = await startServer();
  try {
    await runOfflineSiblingCheck(page, own);
  } finally {
    await stopServer(own);
  }
});

async function runOfflineSiblingCheck(page: Page, own: Server) {
  await adminOn(own, "POST", "spaces", {
    name: "root",
    folder: join(own.rootDir, "root-space"),
    binding: { prefix: "/" },
    public: true,
    seedIndex: true,
  });
  // The sibling must exist before the root worker is configured, so its
  // prefix is in the boot config the worker receives.
  await adminOn(own, "POST", "spaces", {
    name: "slow",
    folder: join(own.rootDir, "slow-space"),
    binding: { prefix: "/slow" },
    public: false,
    seedIndex: true,
  });
  await registerRootServiceWorker(page, own.base);

  // Collect the worker's own connectivity broadcasts, so the freeze below is
  // waited out on the state it actually reached rather than on a duration.
  await page.evaluate(() => {
    (globalThis as any).onlineStatuses = [];
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "online-status") {
        (globalThis as any).onlineStatuses.push(event.data.isOnline);
      }
    });
    // The worker's ping runs on a timer, and an idle worker is terminated (and
    // restarts believing it is online). A steady trickle of precache-served
    // requests keeps it alive without touching the frozen server.
    (globalThis as any).keepAlive = setInterval(() => {
      void fetch(".client/client.js");
    }, 250);
  });

  // Freeze (not kill) the server: frozen-but-listening is "slow", not "down",
  // which is exactly what trips the 2s ping timeout.
  own.proc.kill("SIGSTOP");
  await page.waitForFunction(
    () => (globalThis as any).onlineStatuses.includes(false),
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(() => clearInterval((globalThis as any).keepAlive));

  // Navigate while the server is still frozen, so the worker is provably in
  // its offline state when it routes the navigation. The correct behavior is
  // to proxy the request anyway (it is not ours to answer); the kernel holds
  // the connection until the server thaws a moment later. The buggy behavior
  // answers instantly from the precache, before the thaw can matter.
  const navigation = page.goto(`${own.base}/slow/`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  own.proc.kill("SIGCONT");
  await navigation;

  // The private sibling's login form must render — not the root space's
  // cached shell (whose `<base href="/">` would boot the wrong space).
  await expect(page.locator("#login")).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => document.baseURI)).not.toBe(`${own.base}/`);
}

test("/.accounts is proxied to the server, not answered with the app shell", async ({
  page,
}) => {
  // Every `/.`-prefixed surface the worker cannot answer locally has to be
  // declared in `spaceSurfaces`, or it falls through to the SPA-shell
  // fallback and the client parses `<!doctype html>` as JSON. `/.accounts`
  // feeds `@mention` completion and the Mention Inbox's default filter, so
  // the failure shows up as "nobody is a recipient" rather than as an error.
  await registerRootServiceWorker(page);

  const result = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const body = await response.text();
    return { status: response.status, body: body.slice(0, 60) };
  }, `${base}/.accounts`);

  expect(result.status).toBe(200);
  expect(result.body).not.toContain("<!doctype");
  expect(() => JSON.parse(result.body)).not.toThrow();
});

test("Space Manager logs out after leaving the only editor tab", async ({
  page,
  context,
}) => {
  await registerRootServiceWorker(page);
  await page.evaluate(() => (window as any).client.widgetsReady);
  const login = await page.request.post(`${base}/.spaces/api/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  await page.goto(`${base}/.spaces/`);
  expect(context.pages()).toHaveLength(1);
  await page.getByRole("button", { name: "Profile menu", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You are signed out" }),
  ).toBeVisible();
  expect((await page.request.get(`${base}/.spaces/api/session`)).status()).toBe(
    401,
  );
});

test("Space Manager logs out outside the last editor's worker scope", async ({
  page,
  context,
  browserName,
}) => {
  const isolated = await startServer();
  try {
    await adminOn(isolated, "POST", "spaces", {
      name: "Notebook",
      binding: { prefix: "/notes" },
      public: true,
      seedIndex: true,
    });
    await adminOn(isolated, "POST", "spaces", {
      name: "Public notebook",
      binding: { prefix: "/public" },
      public: true,
      seedIndex: true,
    });
    await page.goto(`${isolated.base}/public/`);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(() => (window as any).client.widgetsReady);
    await page.goto(`${isolated.base}/notes/`);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.evaluate(() => (window as any).client.widgetsReady);
    const login = await page.request.post(
      `${isolated.base}/.spaces/api/login`,
      {
        data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
      },
    );
    expect(login.ok()).toBe(true);
    await page.goto(`${isolated.base}/.spaces/`);
    expect(context.pages()).toHaveLength(1);
    expect(
      await page.evaluate(
        async () => (await navigator.serviceWorker.getRegistrations()).length,
      ),
    ).toBe(2);
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller),
    ).toBeNull();
    if (browserName === "chromium") {
      const cdp = await context.newCDPSession(page);
      await cdp.send("ServiceWorker.enable");
      await cdp.send("ServiceWorker.stopAllWorkers");
      await cdp.detach();
    }
    await page
      .getByRole("button", { name: "Profile menu", exact: true })
      .click();
    await page.getByRole("button", { name: "Log out", exact: true }).click();
    if (browserName === "chromium") {
      await expect(
        page.getByRole("button", { name: "Force logout", exact: true }),
      ).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      await page
        .getByRole("button", { name: "Force logout", exact: true })
        .click();
    }
    await expect(
      page.getByRole("heading", { name: "You are signed out" }),
    ).toBeVisible();
  } finally {
    await stopServer(isolated);
  }
});

test("Space Manager offers force logout for an old worker and deletes data directly", async ({
  page,
}) => {
  const login = await page.request.post(`${base}/.spaces/api/login`, {
    data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  expect(login.ok()).toBe(true);
  await page.goto(`${base}/.spaces/`);
  await page.context().route(`${base}/retired/service_worker.js`, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.addEventListener("install", event => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));`,
    }),
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/retired/service_worker.js");
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.serviceWorker.getRegistration("/retired/"))?.active
            ?.state,
      ),
    )
    .toBe("activated");
  await page.getByRole("button", { name: "Profile menu", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Force logout", exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`${base}/.spaces/api/session`)).status()).toBe(
    200,
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Force logout", exact: true }).click();
  await expect(
    page.getByText("Local space data has been removed from this browser."),
  ).toBeVisible();
  expect((await page.request.get(`${base}/.spaces/api/session`)).status()).toBe(
    401,
  );
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistrations()).length,
    ),
  ).toBe(0);
});

test("failed saving preserves edits until explicit force logout deletes local data", async ({
  page,
  context,
}) => {
  await registerRootServiceWorker(page);
  await page.evaluate(() => (window as any).client.widgetsReady);
  expect(
    (
      await page.request.post(`${base}/.spaces/api/login`, {
        data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`${base}/.spaces/`);
  const editor = await context.newPage();
  await editor.goto(`${base}/RecoveryDraft`);
  await expect(editor.locator("#sb-editor .cm-editor")).toBeVisible();
  await editor.evaluate(() => (window as any).client.widgetsReady);
  await editor.evaluate(() => {
    const client = (window as any).client;
    client.contentManager.save = async () => {
      throw new Error("Synthetic storage failure");
    };
    const view = client.editorView;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: "Keep this unsaved draft available for recovery",
      },
    });
    clearTimeout(client.contentManager.saveTimeout);
  });
  await page.getByRole("button", { name: "Profile menu", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Force logout", exact: true }),
  ).toBeVisible();
  expect((await page.request.get(`${base}/.spaces/api/session`)).status()).toBe(
    200,
  );
  await expect(editor).toHaveURL(`${base}/RecoveryDraft`);
  expect(await editor.evaluate(() => document.documentElement.inert)).toBe(
    false,
  );
  await expect(editor.locator("#sb-editor .cm-content")).toContainText(
    "Keep this unsaved draft available for recovery",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Force logout", exact: true }).click();
  await expect(
    page.getByText("Local space data has been removed from this browser."),
  ).toBeVisible();
  await expect(
    editor.getByText("Local space data has been removed from this browser."),
  ).toBeVisible();
  expect((await page.request.get(`${base}/.spaces/api/session`)).status()).toBe(
    401,
  );
  expect(
    await page.evaluate(async () =>
      (await indexedDB.databases()).filter((db) => db.name?.startsWith("sb_")),
    ),
  ).toEqual([]);
});

test("Space Manager without workers ignores duplicate locks in its own tab", async ({
  page,
}) => {
  expect(
    (
      await page.request.post(`${base}/.spaces/api/login`, {
        data: { username: ADMIN_USER, password: ADMIN_PASSWORD },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`${base}/.spaces/`);
  await page.evaluate(() => {
    void navigator.locks.request(
      "silverbullet-logout-participant",
      { mode: "shared" },
      () => new Promise<void>(() => {}),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await navigator.locks.query()).held?.filter(
            (lock) => lock.name === "silverbullet-logout-participant",
          ).length,
      ),
    )
    .toBe(2);
  expect(
    await page.evaluate(
      async () => (await navigator.serviceWorker.getRegistrations()).length,
    ),
  ).toBe(0);
  await page.getByRole("button", { name: "Profile menu", exact: true }).click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(
    page.getByText("Local space data has been removed from this browser."),
  ).toBeVisible();
  expect((await page.request.get(`${base}/.spaces/api/session`)).status()).toBe(
    401,
  );
});

test("repeated local manager logouts with back-forward cache enabled", async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch({
    channel: process.env.SB_TEST_CHROME_CHANNEL,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/.spaces/login`);
    for (let iteration = 0; iteration < 4; iteration++) {
      await page.getByLabel("Username", { exact: true }).fill(ADMIN_USER);
      await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      await page
        .getByRole("button", { name: "Profile menu", exact: true })
        .click();
      await page.getByRole("button", { name: "Log out", exact: true }).click();
      await expect(
        page.getByText("Local space data has been removed from this browser."),
      ).toBeVisible();
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
    }
    await page.getByLabel("Username", { exact: true }).fill(ADMIN_USER);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Profile menu", exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-before-history", "true"),
    );
    await page.goto("about:blank");
    expect((await page.request.get(`${base}/.spaces/api/logout`)).ok()).toBe(
      true,
    );
    await page.goBack();
    await expect(
      page.getByRole("button", { name: "Log in", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-before-history",
      "true",
    );
  } finally {
    await browser.close();
  }
});
