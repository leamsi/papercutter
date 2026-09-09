import { expect, test } from "@playwright/test";
import { ADMIN_PASSWORD, ADMIN_USER } from "../fixtures.ts";
import {
  coreApi,
  newPocketUserPage,
  signInWithPocketId,
  startCoreOidcFixture,
} from "./core-fixture.ts";

test("repeated manager-only SSO logins and logouts with Chrome back-forward cache enabled", async () => {
  test.setTimeout(180_000);
  const fixture = await startCoreOidcFixture({ backForwardCache: true });
  try {
    const provider = await coreApi<{ active: { providerId: string } }>(
      fixture.adminPage,
      "GET",
      "admin/authentication",
    );
    await coreApi(fixture.adminPage, "POST", "admin/users", {
      username: "river",
      loginMethod: "sso",
      providerId: provider.active.providerId,
      expectedEmail: "fixture-user@example.test",
      admin: false,
    });
    const { page, context } = await newPocketUserPage(fixture);
    try {
      await page.goto(`${fixture.oidc.centralOrigin}/.spaces/login`);
      await page.getByLabel("Username", { exact: true }).fill(ADMIN_USER);
      await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Log in", exact: true }).click();
      for (let iteration = 0; iteration < 3; iteration++) {
        await page
          .getByRole("button", { name: "Profile menu", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Log out", exact: true })
          .click();
        await expect(
          page.getByText(
            "Local space data has been removed from this browser.",
          ),
        ).toBeVisible();
        if (iteration < 2) {
          await page
            .getByRole("button", { name: "Sign in", exact: true })
            .click();
          if (iteration === 0) await signInWithPocketId(page);
          else
            await page
              .getByRole("button", {
                name: "Sign in with Pocket ID",
                exact: true,
              })
              .click();
          await expect(
            page.getByRole("heading", { name: "Spaces", exact: true }),
          ).toBeVisible();
          expect(
            await page.evaluate(async () =>
              (await fetch("/.spaces/api/session")).json(),
            ),
          ).toEqual({ username: "river", admin: false });
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await fixture.stop();
  }
});
