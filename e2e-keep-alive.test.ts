import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  JOURNEY_TIMEOUT_MS,
  WEB_KEEP_ALIVE_MS,
} from "./e2e/support/keep-alive.ts";

// The browser journeys' web server keeps idle connections open for longer
// than a journey, so `page.request`, which ignores the server's keep-alive
// hint, never reuses a connection the server is closing (#897).
const config = readFileSync("playwright.config.ts", "utf8");

describe("e2e web server keep-alive", () => {
  it("outlasts a whole journey", () => {
    expect(WEB_KEEP_ALIVE_MS).toBeGreaterThan(JOURNEY_TIMEOUT_MS);
    expect(config).toContain("timeout: JOURNEY_TIMEOUT_MS,");
  });

  it("is passed to the web server the journeys start", () => {
    expect(config).toMatch(
      /command: `pnpm --filter @netrics\/web start --port \$\{WEB_PORT\} --keepAliveTimeout \$\{WEB_KEEP_ALIVE_MS\}`/,
    );
  });
});
