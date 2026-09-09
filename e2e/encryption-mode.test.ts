import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { getFreePort, waitForEditorReady, waitForServer } from "./fixtures.ts";

const username = "morgan";
const password = "morganpw123";
let process: ChildProcess;
let root: string;
let base: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-encryption-mode-"));
  const port = await getFreePort();
  process = spawn(
    "./target/debug/silverbullet",
    [root, "-p", String(port), "-L", "127.0.0.1"],
    {
      cwd: join(import.meta.dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...globalThis.process.env,
        SB_USER: `${username}:${password}`,
        SB_RUNTIME_API: "0",
      },
    },
  );
  base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/.auth`);
});

test.afterAll(async () => {
  process?.kill();
  await rm(root, { recursive: true, force: true });
});

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return await context.newPage();
}

async function login(page: Page, encrypt: boolean): Promise<void> {
  await page.goto(`${base}/.auth`);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const encryption = page.getByLabel("Encrypt local data on this device", {
    exact: true,
  });
  if (encrypt) await encryption.check();
  else await encryption.uncheck();
  await page.getByRole("button", { name: "Log in", exact: true }).click();
}

async function waitForEditor(page: Page): Promise<void> {
  await page
    .locator("#sb-editor .cm-editor")
    .waitFor({ state: "visible", timeout: 30_000 });
}

async function dumpIndexedDb(page: Page): Promise<string> {
  return await page.evaluate(async () => {
    const names = (await indexedDB.databases())
      .map((database) => database.name)
      .filter((name): name is string => !!name);
    const chunks: string[] = [];
    for (const name of names) {
      chunks.push(name);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const store of Array.from(database.objectStoreNames)) {
        const transaction = database.transaction(store, "readonly");
        const objectStore = transaction.objectStore(store);
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = objectStore.getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const keys = await new Promise<unknown[]>((resolve, reject) => {
          const request = database
            .transaction(store, "readonly")
            .objectStore(store)
            .getAllKeys();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        chunks.push(JSON.stringify(keys), JSON.stringify(values));
      }
      database.close();
    }
    return chunks.join("\n");
  });
}

async function writeMarker(
  page: Page,
  name: string,
  text: string,
): Promise<void> {
  await page.goto(`${base}/${name}?headless=1`);
  await waitForEditor(page);
  await waitForEditorReady(page);
  await page.route("**/.fs/**", (route) => route.abort("internetdisconnected"));
  const editor = page.locator("#sb-editor .cm-content");
  await editor.click();
  await page.keyboard.type(text);
  await expect(editor).toContainText(text);
  await expect.poll(() => dumpIndexedDb(page)).toContain(name);
}

test("opting into encryption preserves a populated plaintext cache", async ({
  browser,
}) => {
  const page = await freshPage(browser);
  try {
    await login(page, false);
    await waitForEditor(page);
    await writeMarker(page, "QueuedPlaintext", "preserve this local edit");
    expect(await dumpIndexedDb(page)).toContain("QueuedPlaintext");

    await page.context().clearCookies();
    await login(page, true);
    await expect(
      page.getByText(
        "This browser already has local data. Synchronize and export it before changing encryption mode. Your existing cache has been preserved.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("enableEncryption")),
    ).toBeNull();
    expect(await dumpIndexedDb(page)).toContain("QueuedPlaintext");
  } finally {
    await page.context().close();
  }
});

test("unchecking encryption preserves an existing encrypted cache", async ({
  browser,
}) => {
  const page = await freshPage(browser);
  try {
    await login(page, true);
    await waitForEditor(page);
    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await indexedDB.databases()).some(
            ({ name }) =>
              name?.startsWith("sb_files_") || name?.startsWith("sb_data_"),
          ),
        ),
      )
      .toBe(true);
    const encryptedDatabases = await page.evaluate(async () =>
      (await indexedDB.databases())
        .map((database) => database.name)
        .filter(
          (name): name is string =>
            !!name &&
            (name.startsWith("sb_files_") || name.startsWith("sb_data_")),
        ),
    );
    expect(encryptedDatabases.length).toBeGreaterThan(0);

    await page.context().clearCookies();
    await login(page, false);
    await expect(
      page.getByText(
        "Encryption is already enabled in this browser. Keep it enabled to preserve your existing local data. Synchronize and export your data before changing encryption mode.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("enableEncryption")),
    ).toBe("true");
    expect(
      await page.evaluate(async () =>
        (await indexedDB.databases())
          .map((database) => database.name)
          .filter(
            (name): name is string =>
              !!name &&
              (name.startsWith("sb_files_") || name.startsWith("sb_data_")),
          ),
      ),
    ).toEqual(encryptedDatabases);
  } finally {
    await page.context().close();
  }
});
