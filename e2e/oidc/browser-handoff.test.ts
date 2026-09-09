import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const password = "invented-local-unlock-password";
const fingerprint = (page: Page) =>
  page.evaluate(() => (window as any).fixture.fingerprint());
const start = async (page: Page) => {
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open central login" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  return popup;
};
const transfer = async (popup: Page) => {
  await popup.getByLabel("Password", { exact: true }).fill(password);
  await popup.getByRole("button", { name: "Transfer key" }).click();
};

test("all HTTPS fixture origins support service workers and isolate cookies", async ({
  page,
  oidc,
}) => {
  for (const origin of [
    oidc.centralOrigin,
    oidc.notesOrigin,
    oidc.researchOrigin,
  ]) {
    await page.goto(origin);
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    expect(await page.evaluate(() => document.cookie)).toBe("");
    await page.evaluate(async () => {
      await fetch("/cookie");
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
  }
  for (const origin of [
    oidc.centralOrigin,
    oidc.notesOrigin,
    oidc.researchOrigin,
  ]) {
    await page.goto(origin);
    expect(await page.evaluate(() => document.cookie)).toBe(
      `fixture=${new URL(origin).hostname}`,
    );
  }
});

test("bound browser messages transfer a nonextractable key without persistence or network leakage", async ({
  page,
  context,
  oidc,
}) => {
  const requests: string[] = [];
  context.on("request", (request) =>
    requests.push(
      `${request.url()} ${request.postData() ?? ""} ${JSON.stringify(request.headers())}`,
    ),
  );
  await page.goto(oidc.notesOrigin);
  const popup = await start(page);
  await transfer(popup);
  await expect.poll(() => fingerprint(page)).not.toBeNull();
  const expected = await popup.evaluate(async (value) => {
    const key = await (window as any).fixture.derive(value);
    return btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: new Uint8Array(12) },
            key,
            new TextEncoder().encode("fixture key identity"),
          ),
        ),
      ),
    );
  }, password);
  expect(await fingerprint(page)).toBe(expected);
  await expect(
    page.evaluate(() => (window as any).fixture.exportKey()),
  ).rejects.toThrow();
  for (const surface of [page, popup]) {
    expect(
      await surface.evaluate(() =>
        [
          location.href,
          JSON.stringify(localStorage),
          JSON.stringify(sessionStorage),
        ].join(" "),
      ),
    ).not.toContain(password);
    expect(
      await surface.evaluate(() =>
        [JSON.stringify(localStorage), JSON.stringify(sessionStorage)].join(
          " ",
        ),
      ),
    ).toBe("{} {}");
  }
  expect(requests.join("\n")).not.toContain(password);
  expect(requests.join("\n")).not.toContain(expected);
  await transfer(popup);
  expect(await page.evaluate(() => (window as any).fixture.accepted())).toBe(1);
});

test("wrong window, wrong origin and wrong attempt cannot supply an unlock key", async ({
  page,
  context,
  oidc,
}) => {
  await page.goto(oidc.notesOrigin);
  const popup = await start(page);
  const binding = await page.evaluate(() => (window as any).fixture.attempt());
  await popup.evaluate(() => {
    const button = document.createElement("button");
    button.textContent = "Open intruder";
    button.onclick = () => {
      window.open("/intruder", "_blank");
    };
    document.body.append(button);
  });
  const intruderPromise = popup.waitForEvent("popup");
  await popup.getByRole("button", { name: "Open intruder" }).click();
  const intruder = await intruderPromise;
  await intruder.waitForLoadState();
  await intruder.evaluate(
    async ({ origin, binding }) =>
      (window as any).fixture.send(window.opener.opener, origin, binding),
    { origin: oidc.notesOrigin, binding },
  );
  await expect(page.locator("#status")).toHaveText("opened");
  expect(await fingerprint(page)).toBeNull();
  await popup.evaluate(
    async (origin) =>
      (window as any).fixture.send(window.opener, origin, "wrong-attempt"),
    oidc.notesOrigin,
  );
  await popup.evaluate((origin) => {
    const frame = document.createElement("iframe");
    frame.src = `${origin}/intruder`;
    document.body.append(frame);
  }, oidc.researchOrigin);
  await expect
    .poll(() =>
      popup
        .frames()
        .find((frame) => frame.url().startsWith(oidc.researchOrigin)),
    )
    .toBeTruthy();
  await popup
    .frames()
    .find((frame) => frame.url().startsWith(oidc.researchOrigin))!
    .evaluate(
      async ({ origin, binding }) =>
        (window as any).fixture.send(window.parent.opener, origin, binding),
      { origin: oidc.notesOrigin, binding },
    );
  await page.waitForTimeout(100);
  expect(await fingerprint(page)).toBeNull();
  expect(context.pages().length).toBeGreaterThan(1);
});

test("simultaneous destinations keep separate keys and fresh contexts contain no unlock state", async ({
  page,
  context,
  browser,
  oidc,
}) => {
  await page.goto(oidc.notesOrigin);
  const research = await context.newPage();
  await research.goto(oidc.researchOrigin);
  const first = await start(page);
  const second = await start(research);
  await transfer(first);
  await expect.poll(() => fingerprint(page)).not.toBeNull();
  expect(await fingerprint(research)).toBeNull();
  await transfer(second);
  await expect.poll(() => fingerprint(research)).not.toBeNull();
  const fresh = await browser.newContext();
  try {
    const freshPage = await fresh.newPage();
    await freshPage.goto(oidc.notesOrigin);
    expect(await fingerprint(freshPage)).toBeNull();
  } finally {
    await fresh.close();
  }
});

test("cancellation and expiry permit a fresh successful attempt", async ({
  page,
  oidc,
}) => {
  await page.goto(`${oidc.notesOrigin}/?ttl=50`);
  const expired = await start(page);
  await expired.waitForTimeout(100);
  await transfer(expired);
  expect(await fingerprint(page)).toBeNull();
  await expired.close();
  await page.goto(oidc.notesOrigin);
  const cancelled = await start(page);
  await cancelled.close();
  expect(await fingerprint(page)).toBeNull();
  const retried = await start(page);
  await transfer(retried);
  await expect.poll(() => fingerprint(page)).not.toBeNull();
});

test("popup blocking and COOP isolation expose the required user-flow constraints", async ({
  page,
  oidc,
}) => {
  await page.goto(oidc.notesOrigin);
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts", "allow-same-origin");
    frame.src = "/blocked";
    document.body.append(frame);
  });
  const blocked = page.frameLocator("iframe");
  await blocked.getByRole("button", { name: "Open central login" }).click();
  await expect(blocked.locator("#status")).toHaveText("blocked");
  await page.goto(`${oidc.notesOrigin}/?popupCoop=1`);
  const isolated = await start(page);
  await transfer(isolated);
  await expect(isolated.locator("#status")).toHaveText("isolated");
  expect(await fingerprint(page)).toBeNull();
});

test("fixture CA and process proxy validate the exact issuer without host DNS changes", async ({
  oidc,
  playwright,
}) => {
  const { stdout } = await promisify(execFile)("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--max-time",
    "15",
    "--proxy",
    oidc.outboundProxy,
    "--cacert",
    oidc.certificatePath,
    `${oidc.issuerOrigin}/.well-known/openid-configuration`,
  ]);
  expect(JSON.parse(stdout).issuer).toBe(oidc.issuerOrigin);
  const untrusted = await playwright.chromium.launch({
    args: oidc.browserArgs.filter(
      (argument) =>
        !argument.startsWith("--ignore-certificate-errors-spki-list="),
    ),
  });
  try {
    const page = await untrusted.newPage();
    await expect(page.goto(oidc.notesOrigin)).rejects.toThrow(
      /ERR_CERT_AUTHORITY_INVALID/,
    );
  } finally {
    await untrusted.close();
  }
});

test("central-held popup publishes the key before closing and returning the original window", async ({
  page,
  context,
  oidc,
}) => {
  await context.addInitScript(({ centralOrigin, notesOrigin }) => {
    if (
      location.origin !== notesOrigin ||
      location.pathname !== "/key-receiver"
    )
      return;
    const attempt = new URLSearchParams(location.search).get("attempt");
    const source = window.opener;
    addEventListener("message", async (event) => {
      if (
        event.source !== source ||
        event.origin !== centralOrigin ||
        event.data?.attempt !== attempt ||
        !(event.data.key instanceof CryptoKey)
      )
        return;
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        source.postMessage({ type: "published", attempt }, centralOrigin);
        window.close();
      };
      registration.active!.postMessage(
        { type: "unlock", key: event.data.key },
        [channel.port2],
      );
    });
    source.postMessage({ type: "ready", attempt }, centralOrigin);
  }, oidc);
  await page.goto(oidc.centralOrigin);
  await page.evaluate(
    ({ notesOrigin, password }) => {
      const button = document.createElement("button");
      button.textContent = "Complete encrypted login";
      button.onclick = () => {
        const attempt = crypto.randomUUID();
        const popup = window.open(
          `${notesOrigin}/key-receiver?attempt=${attempt}`,
          "_blank",
          "popup,width=600,height=700",
        );
        addEventListener("message", async (event) => {
          if (
            event.source !== popup ||
            event.origin !== notesOrigin ||
            event.data?.attempt !== attempt
          )
            return;
          if (event.data.type === "ready") {
            popup!.postMessage(
              { attempt, key: await (window as any).fixture.derive(password) },
              notesOrigin,
            );
          } else if (event.data.type === "published") {
            location.assign(notesOrigin);
          }
        });
      };
      document.body.append(button);
    },
    { notesOrigin: oidc.notesOrigin, password },
  );
  await page.getByRole("button", { name: "Complete encrypted login" }).click();
  await expect(page).toHaveURL(`${oidc.notesOrigin}/`);
  const actual = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const channel = new MessageChannel();
    const result = new Promise<number[] | null>((done) => {
      channel.port1.onmessage = (event) => done(event.data);
    });
    registration.active!.postMessage({ type: "fingerprint" }, [channel.port2]);
    return result;
  });
  const expected = await page.evaluate(
    async (value) =>
      Array.from(
        new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: new Uint8Array(12) },
            await (window as any).fixture.derive(value),
            new TextEncoder().encode("fixture key identity"),
          ),
        ),
      ),
    password,
  );
  expect(actual).toEqual(expected);
  await expect.poll(() => context.pages().length).toBe(1);
});
