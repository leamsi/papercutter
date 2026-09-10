import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
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
  rootDir = await mkdtemp(join(tmpdir(), "sb-runtimes-e2e-"));

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

test("runtime metrics, stop, reset, and errors refresh the list", async ({
  page,
}) => {
  let rows = [
    {
      id: "runtime-one",
      spaceId: "fieldnotes",
      spaceName: "Field Notes",
      username: null,
      status: "running",
      cpuPercent: 125.5,
      memoryBytes: 1048576,
      diskBytes: 2048,
    },
  ];
  let failReset = true;
  await page.route("**/.spaces/api/admin/runtimes**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: rows });
    if (request.url().endsWith("/runtime-one/stop")) {
      rows = rows.map((row) => ({
        ...row,
        status: "stopped",
        cpuPercent: 0,
        memoryBytes: 0,
      }));
      return route.fulfill({ status: 204 });
    }
    if (request.url().endsWith("/runtime-one/reset")) {
      if (failReset)
        return route.fulfill({
          status: 500,
          json: { errors: [{ field: "", message: "Profile cleanup failed" }] },
        });
      rows = [];
      return route.fulfill({ status: 204 });
    }
    return route.fulfill({ status: 404 });
  });
  await page.getByRole("link", { name: "Admin", exact: true }).click();
  await page
    .getByRole("link", { name: "Runtimes", exact: true })
    .click({ timeout: 3000 });
  const row = page.getByRole("row").filter({ hasText: "Field Notes" });
  await expect(row).toContainText("Accountless");
  await expect(row).toContainText("125.5%");
  await expect(row).toContainText("1 MiB");
  await expect(row).toContainText("2 KiB");
  await row.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(row).toContainText("stopped");
  await expect(
    row.getByRole("button", { name: "Stop", exact: true }),
  ).toBeDisabled();
  await row.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByText("Profile cleanup failed")).toBeVisible();
  failReset = false;
  await row.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByText("No runtimes have been started.")).toBeVisible();
});

test("polling pauses when hidden and ignores a sample fetched before Stop", async ({
  page,
}) => {
  await page.clock.install();
  let requests = 0;
  let stopped = false;
  let releaseSample: (() => void) | undefined;
  await page.route("**/.spaces/api/admin/runtimes**", async (route) => {
    if (route.request().method() === "POST") {
      stopped = true;
      return route.fulfill({ status: 204 });
    }
    requests++;
    const status = stopped ? "stopped" : "running";
    if (requests === 2)
      await new Promise<void>((resolve) => {
        releaseSample = resolve;
      });
    await route.fulfill({
      json: [
        {
          id: "runtime-two",
          spaceId: "garden",
          spaceName: "Garden",
          username: "rowan",
          status,
          cpuPercent: null,
          memoryBytes: null,
          diskBytes: null,
        },
      ],
    });
  });
  await page.goto(`${base}/.spaces/admin?section=runtimes`);
  const row = page.getByRole("row").filter({ hasText: "Garden" });
  await expect(row).toContainText("rowan");
  await expect(
    row.getByRole("cell", { name: "Unavailable", exact: true }),
  ).toHaveCount(3);
  await page.clock.fastForward(3000);
  await expect.poll(() => requests).toBe(2);
  await page.clock.fastForward(9000);
  expect(requests).toBe(2);
  await row.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => stopped).toBe(true);
  releaseSample!();
  await expect(row).toContainText("stopped");
  await expect.poll(() => requests).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.fastForward(9000);
  expect(requests).toBe(3);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => requests).toBe(4);
  await page.getByRole("link", { name: "Server", exact: true }).click();
  await page.clock.fastForward(9000);
  expect(requests).toBe(4);
});

test("a successful poll clears a list loading error", async ({ page }) => {
  await page.clock.install();
  let unavailable = true;
  await page.route("**/.spaces/api/admin/runtimes", (route) =>
    route.fulfill(
      unavailable
        ? {
            status: 500,
            json: { errors: [{ field: "", message: "Sampling failed" }] },
          }
        : { json: [] },
    ),
  );
  await page.goto(`${base}/.spaces/admin?section=runtimes`);
  await expect(page.getByText("Sampling failed")).toBeVisible();
  unavailable = false;
  await page.clock.fastForward(3000);
  await expect(page.getByText("No runtimes have been started.")).toBeVisible();
  await expect(page.getByText("Sampling failed")).not.toBeVisible({
    timeout: 1000,
  });
});

test("runtime table stays within a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.route("**/.spaces/api/admin/runtimes", (route) =>
    route.fulfill({
      json: [
        {
          id: "runtime-mobile",
          spaceId: "garden",
          spaceName: "Garden",
          username: "rowan",
          status: "stop_failed",
          cpuPercent: 125.5,
          memoryBytes: 1048576,
          diskBytes: 2048,
        },
      ],
    }),
  );
  await page.goto(`${base}/.spaces/admin?section=runtimes`);
  await expect(
    page.getByRole("cell", { name: "Garden", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Stop failed", exact: true }),
  ).toBeVisible({ timeout: 1000 });
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeEnabled();

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
  await page
    .getByRole("button", { name: "Reset", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Reset", exact: true }),
  ).toBeInViewport();
});
