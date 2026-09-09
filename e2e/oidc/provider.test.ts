import { expect, test } from "./fixtures.ts";
import { createPocketIdClient, provisionPocketIdUser } from "./provider.ts";
import { installPasskeyAuthenticator } from "./passkeys.ts";

test("real Pocket ID provisions and authenticates a passkey through its UI", async ({
  page,
  oidc,
}) => {
  const uninstall = await installPasskeyAuthenticator(page);
  try {
    await provisionPocketIdUser(page, oidc.issuerOrigin);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    const identity = () =>
      page.evaluate(async () => (await fetch("/api/users/me")).json());
    expect(await identity()).toMatchObject({
      username: "fixture-user",
      email: "fixture-user@example.test",
    });
    const client = await createPocketIdClient(
      page,
      `${oidc.centralOrigin}/.auth/central/oidc/callback`,
    );
    expect(client.clientId).toBeTruthy();
    expect(client.clientSecret.length).toBeGreaterThan(15);
    await page.goto(`${oidc.issuerOrigin}/logout`);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login/);
    await page
      .getByRole("button", { name: "Authenticate", exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings/);
    expect(await identity()).toMatchObject({
      username: "fixture-user",
      email: "fixture-user@example.test",
    });
  } finally {
    await uninstall();
  }
});
