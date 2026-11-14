import { defineConfig, devices } from "@playwright/test";

/**
 * Browser journeys against the real web app and API (#570). Locally, a
 * running `pnpm dev` (web :3000, api :3001) is reused; otherwise, and always
 * in CI, the built server and web app are started (`pnpm build` first). Both
 * need a migrated database (`pnpm db:migrate`). Chromium only.
 */
export default defineConfig({
  testDir: "e2e",
  // vitest's include never matches e2e/, and these never run under vitest.
  testMatch: "**/*.spec.ts",
  // One test at a time: the API's serializable data transactions retry a
  // bounded number of times, and on a database this small (sequential
  // scans) concurrent journeys in separate workspaces can still exhaust
  // those retries and fail with version_conflict.
  // TODO(#598): go back to parallel workers once the API retries enough.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "en",
      use: { ...devices["Desktop Chrome"], locale: "en-US" },
    },
    {
      name: "de",
      use: { ...devices["Desktop Chrome"], locale: "de-DE" },
    },
  ],
  webServer: [
    {
      command: "node apps/server/dist/index.js",
      url: "http://localhost:3001/health/live",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @netrics/web start",
      url: "http://localhost:3000/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
