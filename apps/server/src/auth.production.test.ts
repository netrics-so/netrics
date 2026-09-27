import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

// The API as configured for production: https public URLs, real secrets and
// no SMTP transport.

let app: FastifyInstance;
let db: Database;
const logLines: string[] = [];

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: testDb.appUrl,
    BETTER_AUTH_URL: "https://netrics.example.com",
    WEB_ORIGIN: "https://netrics.example.com",
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    LOG_LEVEL: "silent",
  });
  db = createDatabase(testDb.appUrl);
  const logger = pino(
    { level: "info" },
    { write: (line: string) => logLines.push(line) },
  );
  app = await buildApp(config, {
    db,
    checkDb: async () => true,
    // No mailer override: production without SMTP must pick the refusing one.
    authService: createAuthService(config, db, { logger }),
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("production auth configuration", () => {
  it("issues a Secure session cookie", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { origin: "https://netrics.example.com" },
      payload: {
        name: "Prod User",
        email: "prod-user@example.com",
        password: "password-12345",
      },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    const cookies = (Array.isArray(header) ? header : [header]).filter(
      (c): c is string => typeof c === "string",
    );
    const session = cookies.find((c) => c.includes("session_token="));
    expect(session).toBeDefined();
    expect(session).toMatch(/;\s*Secure/i);
  });

  it("does not send or log a password reset link without SMTP", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      headers: { origin: "https://netrics.example.com" },
      payload: {
        email: "prod-user@example.com",
        redirectTo: "https://netrics.example.com/reset",
      },
    });
    // better-auth answers uniformly (no account enumeration); what matters is
    // that the refusing mailer ran and the link never reached the logs.
    expect(response.statusCode).toBeLessThan(500);
    const logs = logLines.join("\n");
    expect(logs).toContain("SMTP not configured");
    expect(logs).not.toMatch(/reset-password\/[A-Za-z0-9]/);
    expect(logs).not.toMatch(/token=/);
  });
});
