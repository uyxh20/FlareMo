import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const siteRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Opt-in browser regression coverage for the statically generated site.
 * Run from the repository root with:
 *   pnpm exec playwright test --config apps/site/playwright.config.ts
 */
export default defineConfig({
  testDir: fileURLToPath(new URL("./tests", import.meta.url)),
  testMatch: /docs-routes\.pw\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "python3 -m http.server 4173 --directory dist/site",
    cwd: siteRoot,
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
});
