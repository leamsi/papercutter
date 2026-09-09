import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/oidc",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  outputDir: "test-results/oidc",
  use: {
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
