import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { expect, test } from "./fixtures.ts";

let javascript: string;
test.beforeAll(async () => {
  const built = await build({
    entryPoints: ["client/spaces_ui/spaces.tsx"],
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    jsxImportSource: "preact",
  });
  javascript = built.outputFiles[0].text;
});

test("wizard UI tests a saved draft before activation and preserves the local administrator", async ({
  page,
  context,
  oidc,
}, testInfo) => {
  let draft: any = null;
  let active: any = null;
  const changes: string[] = [];
  const submittedSecrets: string[] = [];
  let testOutcome = "error";
  await context.route(`${oidc.centralOrigin}/.spaces/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (pathname.endsWith("assets/spaces.js"))
      return route.fulfill({
        contentType: "text/javascript",
        body: javascript,
      });
    if (pathname.endsWith("assets/app.css"))
      return route.fulfill({
        path: "client_bundle/client/.client/app.css",
        contentType: "text/css",
      });
    if (pathname.endsWith("logo-dock-96x96.png"))
      return route.fulfill({
        path: "client/images/logo-dock-96x96.png",
        contentType: "image/png",
      });
    if (pathname.includes("/assets/")) return route.fulfill({ status: 204 });
    if (pathname.endsWith("/api/session") || pathname.endsWith("/api/profile"))
      return route.fulfill({
        json: { username: "fixture-admin", admin: true, fullName: null },
      });
    if (pathname.endsWith("/api/admin/authentication") && method === "GET")
      return route.fulfill({
        json: {
          revision: draft ? 1 : 0,
          enabled: !!active,
          active,
          draft,
          tested: false,
        },
      });
    if (pathname.endsWith("/authentication/draft")) {
      changes.push("save");
      submittedSecrets.push(route.request().postDataJSON().clientSecret);
      draft = {
        ...route.request().postDataJSON(),
        clientSecret: "",
        hasClientSecret: true,
        providerId: "fixture-provider",
      };
      return route.fulfill({ json: { revision: 1 } });
    }
    if (pathname.endsWith("/authentication/test") && method === "POST") {
      changes.push("test");
      return route.fulfill({
        json: {
          id: "fixture-test",
          proof: "fixture-proof",
          url: `${oidc.centralOrigin}/provider-test`,
        },
      });
    }
    if (pathname.endsWith("/authentication/test/fixture-test"))
      return route.fulfill({
        json: {
          status: testOutcome,
          error: testOutcome === "error" ? "Email is not verified" : undefined,
          email: "fixture-user@example.test",
          emailVerified: true,
          admissionAllowed: true,
          provisionedUsername: null,
        },
      });
    if (pathname.endsWith("/authentication/activate")) {
      expect(route.request().postDataJSON().revision).toBe(1);
      changes.push("activate");
      active = draft;
      return route.fulfill({ json: {} });
    }
    return route.fulfill({
      contentType: "text/html",
      body: await readFile("client/html/spaces.html", "utf8"),
    });
  });
  await page.goto(`${oidc.centralOrigin}/.spaces/authentication`);
  await page.getByRole("button", { name: "Set up SSO" }).click();
  await page.getByLabel("Provider", { exact: true }).selectOption("pocket-id");
  await page.getByLabel("Issuer URL").fill(oidc.issuerOrigin);
  await page.getByLabel("Central login URL").fill(oidc.centralOrigin);
  await page.getByLabel("Client ID", { exact: true }).fill("fixture-client");
  await page
    .getByLabel("Client secret", { exact: true })
    .fill("fixture-secret");
  await expect(page.getByLabel("Callback URL")).toHaveValue(
    `${oidc.centralOrigin}/.auth/central/oidc/callback`,
  );
  await expect(page.getByRole("button", { name: "Enable SSO" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save and test sign-in" }).click();
  await expect(
    page.getByText("Email is not verified", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Enable SSO" })).toHaveCount(0);
  expect(changes).toEqual(["save", "test"]);
  testOutcome = "success";
  await page.getByRole("button", { name: "Save and test sign-in" }).click();
  await expect(
    page.getByText("fixture-user@example.test", { exact: true }),
  ).toBeVisible();
  expect(changes).toEqual(["save", "test", "save", "test"]);
  await page.getByLabel("Sign-in button label").fill("Continue with Pocket ID");
  await expect(page.getByRole("button", { name: "Enable SSO" })).toHaveCount(0);
  await page.getByRole("button", { name: "Save and test sign-in" }).click();
  await expect(page.getByRole("button", { name: "Enable SSO" })).toBeVisible();
  await expect(
    page.getByText("Only accounts added by an administrator can sign in.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("wizard-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Enable SSO" }).click();
  await expect(
    page.getByText("SSO is enabled.", { exact: true }),
  ).toBeVisible();
  expect(changes).toEqual([
    "save",
    "test",
    "save",
    "test",
    "save",
    "test",
    "activate",
  ]);
  expect(submittedSecrets).toEqual(["fixture-secret", "", ""]);
  await page.getByRole("button", { name: "Profile menu" }).click();
  await expect(page.getByText("fixture-admin", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByLabel("Client secret", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    page.getByLabel("Client secret", { exact: true }),
  ).toHaveAttribute("placeholder", "Saved secret — leave blank to keep");
});
