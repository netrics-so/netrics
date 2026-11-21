import { defineConfig, devices } from "@playwright/test";
import {
  CUSTOM_API_ORIGIN,
  CUSTOM_API_TLS,
  ensureCustomApiCertificate,
} from "./e2e/support/custom-api-origin.ts";
import { API, API_PORT, ORIGIN, WEB_PORT } from "./e2e/support/origin.ts";

// The custom API builder journey (#807) reads a local https fixture server
// with a self-signed certificate made here. The API it tests against must
// trust it and may reach 127.0.0.1: a reused local `pnpm dev` API needs
// the same two variables, NETRICS_CUSTOM_API_PRIVATE_HOSTS=127.0.0.1 and
// NODE_EXTRA_CA_CERTS=node_modules/.cache/netrics-e2e/custom-api-tls/cert.pem.
ensureCustomApiCertificate();

/**
 * Browser journeys against the real web app and API (#570). Locally, a
 * running `pnpm dev` (web :3000, api :3001) is reused; otherwise, and always
 * in CI, the built server and web app are started (`pnpm build` first). Both
 * need a migrated database (`pnpm db:migrate`). Chromium only.
 * NETRICS_E2E_WEB_PORT / NETRICS_E2E_API_PORT move both ports (see
 * e2e/support/origin.ts); the started servers are told about each other,
 * unless BETTER_AUTH_URL, WEB_ORIGIN or NETRICS_API_URL are already set,
 * which win over the moved ports.
 */
export default defineConfig({
  testDir: "e2e",
  // vitest's include never matches e2e/, and these never run under vitest.
  testMatch: "**/*.spec.ts",
  // Journeys run in parallel, each in its own workspace. On a database this
  // small their serializable data transactions still conflict now and then
  // (shared index pages, sequential scans); the API retries those with
  // backoff (#598).
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: ORIGIN,
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
      url: `${API}/health/live`,
      env: {
        PORT: String(API_PORT),
        BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? API,
        WEB_ORIGIN: process.env.WEB_ORIGIN ?? ORIGIN,
        NETRICS_CUSTOM_API_PRIVATE_HOSTS: "127.0.0.1",
        NODE_EXTRA_CA_CERTS: CUSTOM_API_TLS.cert,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @netrics/web start --port ${WEB_PORT}`,
      url: `${ORIGIN}/healthz`,
      env: { NETRICS_API_URL: process.env.NETRICS_API_URL ?? API },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "node e2e/support/custom-api-fixture.ts",
      url: `${CUSTOM_API_ORIGIN}/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
