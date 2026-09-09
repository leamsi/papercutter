import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
  type CoreOidcFixture,
  coreApi,
  newPocketUserPage,
  signInWithPocketId,
  startCoreOidcFixture,
} from "./core-fixture.ts";

type AuthenticationStatus = {
  active: { providerId: string };
};

type UserInfo = {
  disabled: boolean;
  email: string | null;
  loginMethod: "local" | "sso";
  sso: {
    expectedEmail: string;
    identity?: { issuer: string; subject: string };
  } | null;
};

async function configStatus(context: BrowserContext, origin: string) {
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/.auth/central/public`);
    return await page.evaluate(async () => (await fetch("/.config")).status);
  } finally {
    await page.close();
  }
}

test.describe.configure({ timeout: 300_000 });

test("Core keeps OIDC admission explicit and revokes disabled sessions", async ({
  browserName: _browserName,
}, testInfo) => {
  testInfo.setTimeout(300_000);
  let fixture: CoreOidcFixture | undefined;
  try {
    fixture = await startCoreOidcFixture();
    const provider = await coreApi<AuthenticationStatus>(
      fixture.adminPage,
      "GET",
      "admin/authentication",
    );
    await coreApi(fixture.adminPage, "POST", "admin/spaces", {
      name: "Research",
      binding: { host: "research.test" },
      members: {},
      seedIndex: true,
    });

    await test.step("a verified but non-enrolled identity is denied", async () => {
      const user = await newPocketUserPage(fixture!);
      try {
        await user.page.goto(`${fixture!.oidc.researchOrigin}/?headless=1`);
        await signInWithPocketId(user.page);
        await expect(
          user.page.getByText(
            "Your account hasn't been added to this server or is disabled. Contact your administrator.",
          ),
        ).toBeVisible();
        const users = await coreApi<Record<string, UserInfo>>(
          fixture!.adminPage,
          "GET",
          "admin/users",
        );
        expect(Object.keys(users)).toEqual(["admin"]);
      } finally {
        await user.context.close();
      }
    });

    await test.step("a matching local-account email is never linked", async () => {
      await coreApi(fixture!.adminPage, "POST", "admin/users", {
        username: "morgan",
        password: "morganpw123",
        loginMethod: "local",
        email: "fixture-user@example.test",
        admin: false,
      });
      const user = await newPocketUserPage(fixture!);
      try {
        await user.page.goto(`${fixture!.oidc.researchOrigin}/?headless=1`);
        await signInWithPocketId(user.page);
        await expect(
          user.page.getByText(
            "Your account hasn't been added to this server or is disabled. Contact your administrator.",
          ),
        ).toBeVisible();
        const local = await coreApi<UserInfo>(
          fixture!.adminPage,
          "GET",
          "admin/users/morgan",
        );
        expect(local).toMatchObject({
          email: "fixture-user@example.test",
          loginMethod: "local",
          sso: null,
        });
      } finally {
        await user.context.close();
      }
    });

    await coreApi(fixture.adminPage, "POST", "admin/users", {
      username: "river",
      loginMethod: "sso",
      providerId: provider.active.providerId,
      expectedEmail: "fixture-user@example.test",
      admin: false,
    });
    await coreApi(fixture.adminPage, "POST", "admin/spaces", {
      name: "Notes",
      binding: { host: "notes.test" },
      members: { river: {} },
      seedIndex: true,
    });

    let admittedUser: { context: BrowserContext; page: Page } | undefined;
    try {
      await test.step("an authenticated SSO account has no implicit space access", async () => {
        admittedUser = await newPocketUserPage(fixture!);
        await admittedUser.page.goto(
          `${fixture!.oidc.researchOrigin}/?headless=1`,
        );
        await signInWithPocketId(admittedUser.page);
        await expect(admittedUser.page).toHaveURL(
          (url) =>
            url.origin === fixture!.oidc.researchOrigin && url.pathname === "/",
        );
        const cookies = await admittedUser.context.cookies();
        expect(
          cookies.some(
            (cookie) =>
              cookie.name.startsWith("auth_") &&
              cookie.domain === "research.test",
          ),
        ).toBe(true);
        expect(
          await configStatus(
            admittedUser.context,
            fixture!.oidc.researchOrigin,
          ),
        ).toBe(403);

        await admittedUser.page.goto(
          `${fixture!.oidc.notesOrigin}/?headless=1`,
        );
        await expect(
          admittedUser.page.locator("#sb-editor .cm-editor"),
        ).toBeVisible();
      });

      await test.step("disabling an SSO account revokes its active session", async () => {
        await coreApi(
          fixture!.adminPage,
          "POST",
          "admin/users/river/disabled",
          { disabled: true },
        );
        expect(
          await configStatus(admittedUser!.context, fixture!.oidc.notesOrigin),
        ).toBe(401);
        await admittedUser!.page.goto(
          `${fixture!.oidc.notesOrigin}/?headless=1`,
        );
        await expect(
          admittedUser!.page.getByLabel("Username", { exact: true }),
        ).toBeVisible();
        const account = await coreApi<UserInfo>(
          fixture!.adminPage,
          "GET",
          "admin/users/river",
        );
        expect(account.disabled).toBe(true);
        expect(account.sso?.identity).toEqual({
          issuer: fixture!.oidc.issuerOrigin,
          subject: expect.any(String),
        });
      });
    } finally {
      await admittedUser?.context.close();
    }
  } catch (error) {
    if (fixture) {
      await fixture.adminPage
        .screenshot({
          path: "test-results/oidc/core-negative-failure.png",
          fullPage: true,
        })
        .catch(() => {});
      throw new Error(`${error}\nCore output:\n${fixture.output()}`);
    }
    throw error;
  } finally {
    await fixture?.stop();
  }
});
