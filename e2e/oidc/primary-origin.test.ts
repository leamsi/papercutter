import { ADMIN_USER, ADMIN_PASSWORD } from "../fixtures.ts";
import { expect, test } from "@playwright/test";
import { coreApi, startCoreOidcFixture } from "./core-fixture.ts";

test("primary manager rejects space-origin administration and keeps local logout working", async () => {
  test.setTimeout(180_000);
  const fixture = await startCoreOidcFixture({ disableServiceWorker: false });
  const { adminPage, oidc, browser } = fixture;
  const serverRequest = (url: string) => {
    const parsed = new URL(url);
    return adminPage.request.get(
      `http://127.0.0.1:${fixture.corePort}${parsed.pathname}`,
      {
        headers: { Host: parsed.host, "X-Forwarded-Proto": "https" },
        maxRedirects: 0,
      },
    );
  };
  try {
    const sibling = new URL(oidc.centralOrigin);
    sibling.hostname = "space.sb.test";
    for (const host of ["space.sb.test", "notes.test"]) {
      await coreApi(adminPage, "POST", "admin/spaces", {
        name: host,
        binding: { host },
        access: "read",
      });
    }
    await coreApi(adminPage, "POST", "admin/spaces", {
      name: "Shared notes",
      binding: { prefix: "/shared" },
      access: "read",
    });
    await adminPage.goto(`${oidc.centralOrigin}/.spaces/admin?section=server`);
    await expect(
      adminPage.getByLabel("Primary URL", { exact: true }),
    ).toHaveValue(oidc.centralOrigin);
    await expect(adminPage.getByRole("checkbox")).toHaveCount(0);
    await expect(
      adminPage.getByLabel("Server Name", { exact: true }),
    ).toHaveValue("SilverBullet");
    await adminPage
      .getByLabel("Server Name", { exact: true })
      .fill("Team Notebook");
    await adminPage.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      adminPage.getByText("Server settings saved.", { exact: true }),
    ).toBeVisible();
    await expect(adminPage.locator(".sb-wordmark")).toHaveText("Team Notebook");
    await expect(adminPage.locator(".sb-notifications")).toHaveCount(0);
    await adminPage.screenshot({
      path: test.info().outputPath("server-save-confirmation.png"),
      fullPage: true,
    });
    await adminPage.reload();
    await expect(adminPage.locator(".sb-wordmark")).toHaveText("Team Notebook");
    await adminPage.screenshot({
      path: test.info().outputPath("primary-server-settings.png"),
      fullPage: true,
    });
    expect(
      (await serverRequest(`${oidc.centralOrigin}/shared/.config`)).status(),
    ).toBe(200);
    await coreApi(adminPage, "POST", "admin/spaces", {
      name: "Later notes",
      binding: { prefix: "/later" },
      seedIndex: true,
    });
    expect(
      (await serverRequest(`${oidc.centralOrigin}/later/.config`)).status(),
    ).toBe(401);
    const prefixContext = await browser.newContext();
    try {
      const prefixPage = await prefixContext.newPage();
      await prefixPage.goto(`${oidc.centralOrigin}/later/`);
      await expect(
        prefixPage.getByRole("heading", { name: "Team Notebook", exact: true }),
      ).toBeVisible();
      await expect(
        prefixPage.getByLabel("Username", { exact: true }),
      ).toBeVisible();
      await prefixPage.getByLabel("Username", { exact: true }).fill(ADMIN_USER);
      await prefixPage
        .getByLabel("Password", { exact: true })
        .fill(ADMIN_PASSWORD);
      await prefixPage
        .getByRole("button", { name: "Log in", exact: true })
        .click();
      await expect(prefixPage.locator("#sb-editor .cm-editor")).toBeVisible();
      expect(
        await prefixPage.evaluate(async () =>
          (await fetch(location.href)).text(),
        ),
      ).toContain("<title>Team Notebook</title>");
    } finally {
      await prefixContext.close();
    }
    const originConfig = await serverRequest(
      `${oidc.notesOrigin}/.auth/central/public`,
    );
    expect((await originConfig.json()).primaryUrl).toBe(oidc.centralOrigin);
    for (const space of [sibling.origin, oidc.notesOrigin]) {
      const direct = await serverRequest(`${space}/.spaces/api/admin/users`);
      expect(direct.status()).toBe(403);
      const sso = await serverRequest(
        `${space}/.spaces/api/admin/authentication`,
      );
      expect(sso.status()).toBe(403);
      const navigation = await serverRequest(`${space}/.spaces/profile`);
      expect(navigation.headers().location).toBe(
        `${oidc.centralOrigin}/.spaces/profile`,
      );
      const hostile = await adminPage.context().newPage();
      await hostile.route(`${space}/probe`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Space script probe</title>",
        }),
      );
      await hostile.goto(`${space}/probe`);
      const results = await hostile.evaluate(async (primary) => {
        const read = await fetch(`${primary}/.spaces/api/admin/users`, {
          credentials: "include",
        })
          .then((r) => r.status)
          .catch(() => "blocked");
        const write = await fetch(
          `${primary}/.spaces/api/admin/server-config`,
          {
            method: "PUT",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              primaryUrl: "https://changed.example.test",
            }),
          },
        )
          .then((r) => r.status)
          .catch(() => "blocked");
        const logout = await fetch(`${primary}/.spaces/api/logout`, {
          credentials: "include",
        })
          .then((r) => r.status)
          .catch(() => "blocked");
        return { read, write, logout };
      }, oidc.centralOrigin);
      expect(results).toEqual({
        read: "blocked",
        write: "blocked",
        logout: "blocked",
      });
      await hostile.close();
    }
    expect(
      (
        await coreApi<{ primaryUrl: string }>(
          adminPage,
          "GET",
          "admin/server-config",
        )
      ).primaryUrl,
    ).toBe(oidc.centralOrigin);
    expect(
      (await serverRequest(`${oidc.centralOrigin}/.config`)).status(),
    ).toBe(404);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.route(`${sibling.origin}/probe`, (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Probe</title>",
        }),
      );
      await page.goto(`${sibling.origin}/probe`);
      await page.evaluate(() =>
        localStorage.setItem("enableEncryption", "true"),
      );
      await page.goto(`${sibling.origin}/.auth/central/signed-out`);
      await expect(page.getByText("No logout is pending.")).toBeVisible();
      expect(
        await page.evaluate(() => localStorage.getItem("enableEncryption")),
      ).toBe("true");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(page).toHaveURL(
        new RegExp(`${new URL(oidc.centralOrigin).hostname}.*`),
      );
    } finally {
      await context.close();
    }
  } finally {
    await fixture.stop();
  }
});
