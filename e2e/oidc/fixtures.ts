import { test as base } from "@playwright/test";
import { type OidcEnvironment, startOidcEnvironment } from "./environment.ts";

export const test = base.extend<{}, { oidc: OidcEnvironment }>({
  oidc: [
    async ({ playwright: _playwright }, use) => {
      const environment = await startOidcEnvironment();
      try {
        await use(environment);
      } finally {
        await environment.stop();
      }
    },
    { scope: "worker", timeout: 180_000 },
  ],
  browser: [
    async ({ playwright, oidc }, use) => {
      const browser = await playwright.chromium.launch({
        channel: "chromium",
        args: oidc.browserArgs,
        ignoreDefaultArgs: ["--disable-popup-blocking"],
      });
      try {
        await use(browser);
      } finally {
        await browser.close();
      }
    },
    { scope: "worker" },
  ],
});
export { expect } from "@playwright/test";
