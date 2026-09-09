import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  ADMIN_PASSWORD,
  ADMIN_USER,
  getFreePort,
  mod,
  waitForServer,
} from "./fixtures";

let serverProcess: ChildProcess;
let root: string;
let base: string;
const cwd = join(import.meta.dirname, "..");
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const commit = (repo: string, message: string) => {
  git(repo, "add", "--all");
  git(
    repo,
    "-c",
    "user.name=Editor",
    "-c",
    "user.email=editor@example.test",
    "commit",
    "-qm",
    message,
  );
};

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sb-git-integration-"));
  execFileSync(
    "./target/debug/silverbullet",
    [
      "setup",
      join(root, "server"),
      "--admin",
      `${ADMIN_USER}:${ADMIN_PASSWORD}`,
    ],
    { cwd, stdio: "pipe" },
  );
  const space = join(root, "notebook");
  await mkdir(space);
  git(space, "init", "-q", "-b", "main");
  git(space, "config", "user.name", "");
  git(space, "config", "user.email", "");
  await writeFile(join(space, "Sample.md"), "Base sentence.\n");
  await writeFile(join(space, "Picture.bin"), Buffer.from("base\0bytes"));
  commit(space, "Initial pages");
  execFileSync("git", ["init", "-q", "--bare", join(root, "remote.git")]);
  await writeFile(
    join(root, "server", "spaces.json"),
    JSON.stringify({
      sample: {
        name: "Notebook",
        folder: space,
        binding: { prefix: "/notebook" },
        revisions: "managed",
        indexPage: "Sample",
      },
    }),
  );
  const port = await getFreePort();
  serverProcess = spawn(
    "./target/debug/silverbullet",
    [join(root, "server"), "-p", String(port), "-L", "127.0.0.1"],
    {
      cwd,
      stdio: "ignore",
      env: {
        ...process.env,
        SB_DISABLE_SERVICE_WORKER: "1",
        SB_RUNTIME_API: "0",
      },
    },
  );
  base = `http://127.0.0.1:${port}`;
  await waitForServer(`${base}/.spaces`);
});

test.afterAll(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    const exited = new Promise<void>((resolve) =>
      serverProcess.once("exit", () => resolve()),
    );
    serverProcess.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
});

test("checked activation, pause, automatic text recovery and explicit binary recovery use the real server", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`${base}/.spaces/login`);
  await page.getByLabel("Username").fill(ADMIN_USER);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(`${base}/.spaces/`);
  await page.goto(`${base}/.spaces/sample/git`);
  await page
    .getByRole("button", { name: "Connect repository", exact: true })
    .click();
  await page
    .getByLabel("Authentication", { exact: true })
    .selectOption("manual");
  await page
    .getByLabel("Repository", { exact: true })
    .fill(join(root, "remote.git"));
  await page
    .getByRole("button", { name: "Check connection", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Connection check" }),
  ).toContainText("Push preflight passed");
  expect(git(join(root, "notebook"), "remote")).toBe("");
  await page.getByRole("button", { name: "Enable sync", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Git sync status" }),
  ).toContainText("Up to date");
  const statusUrl = `${base}/.spaces/api/admin/spaces/sample/git`;
  const success = (await (await page.request.get(statusUrl)).json())
    .lastSuccess;
  expect(success).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Pause sync", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Git sync status" }),
  ).toHaveText("Sync paused");
  expect((await (await page.request.get(statusUrl)).json()).lastSuccess).toBe(
    success,
  );
  await page
    .getByRole("button", { name: "Edit connection", exact: true })
    .click();
  await page
    .getByLabel("Repository", { exact: true })
    .fill(join(root, "unused.git"));
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(git(join(root, "notebook"), "remote", "get-url", "origin")).toBe(
    join(root, "remote.git"),
  );

  const remoteWork = join(root, "remote-work");
  execFileSync("git", [
    "clone",
    "-q",
    "--branch",
    "main",
    join(root, "remote.git"),
    remoteWork,
  ]);
  await writeFile(
    join(root, "notebook", "Sample.md"),
    "This space sentence.\n",
  );
  await writeFile(
    join(root, "notebook", "Picture.bin"),
    Buffer.from("local\0bytes"),
  );
  commit(join(root, "notebook"), "Local edits");
  await writeFile(join(remoteWork, "Sample.md"), "Remote sentence.\n");
  await writeFile(
    join(remoteWork, "Picture.bin"),
    Buffer.from("remote\0bytes"),
  );
  commit(remoteWork, "Remote edits");
  git(remoteWork, "push", "-q", "origin", "main");
  await page.getByRole("button", { name: "Resume sync", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "Git sync status" }),
  ).toContainText("2 files need conflict resolution");
  await page.goto(`${base}/notebook/Sample`);
  await expect(
    page.getByRole("button", { name: "Edit manually", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit manually", exact: true })
    .click();
  await page.locator(".cm-content").click();
  await page.keyboard.press(`${mod}+a`);
  await page.keyboard.insertText("Combined sentence after manual review.\n");
  await expect
    .poll(() => git(join(root, "notebook"), "ls-files", "-u"))
    .not.toContain("Sample.md");
  expect(git(join(root, "notebook"), "ls-files", "-u")).toContain(
    "Picture.bin",
  );
  await page.goto(`${base}/notebook/Sample?gitConflicts=1`);
  await page
    .getByRole("button", { name: "Keep Remote repository", exact: true })
    .click();
  await expect
    .poll(() => git(join(root, "remote.git"), "show", "main:Sample.md"))
    .toBe("Combined sentence after manual review.");
  expect(await readFile(join(root, "notebook", "Picture.bin"))).toEqual(
    Buffer.from("remote\0bytes"),
  );
  await page.goto(`${base}/.spaces/sample/git`);
  await expect(
    page.getByRole("status", { name: "Git sync status" }),
  ).toContainText("Up to date");
});
