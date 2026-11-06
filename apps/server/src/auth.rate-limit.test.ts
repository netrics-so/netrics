import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { CLIENT_IP_HEADER } from "./auth/rate-limit.js";
import { loadConfig } from "./env.js";
import type { Mailer } from "./mail/mailer.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Sign-in allows 10 requests per client IP per minute (auth/rate-limit.ts).
const SIGN_IN_MAX = 10;

const silentMailer: Mailer = {
  delivers: true,
  async sendVerificationEmail() {},
  async sendPasswordResetEmail() {},
  async sendInvitationEmail() {},
};

let testDb: TestDatabase;
let db: Database;
let admin: Sql;
// Two API instances on one database, like two replicas behind a proxy.
let apiA: FastifyInstance;
let apiB: FastifyInstance;

async function buildInstance(): Promise<FastifyInstance> {
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    NETRICS_SIGNUP: "open",
    NETRICS_AUTH_RATE_LIMIT: "on",
  });
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
    mailer: silentMailer,
  });
  return buildApp(config, { db, authService, checkDb: async () => true });
}

function signIn(
  app: FastifyInstance,
  remoteAddress: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    remoteAddress,
    headers,
    payload: { email: "nobody@example.com", password: "wrong-password-1" },
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDatabase(testDb.appUrl);
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  apiA = await buildInstance();
  apiB = await buildInstance();
}, 30_000);

afterAll(async () => {
  await apiA.close();
  await apiB.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("auth rate limiting", () => {
  it("ignores a forged X-Forwarded-For from an untrusted client", async () => {
    const client = "203.0.113.9";
    for (let i = 0; i < SIGN_IN_MAX; i++) {
      const response = await signIn(apiA, client, {
        // A fresh forged address on every attempt, in every header the
        // client could try.
        "x-forwarded-for": `198.51.100.${i}`,
        "x-real-ip": `198.51.100.${i}`,
        [CLIENT_IP_HEADER]: `198.51.100.${i}`,
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await signIn(apiA, client, {
      "x-forwarded-for": "198.51.100.200",
    });
    expect(limited.statusCode).toBe(429);
  });

  it("holds across two API instances sharing the database", async () => {
    const client = "203.0.113.20";
    for (let i = 0; i < SIGN_IN_MAX; i++) {
      const api = i % 2 === 0 ? apiA : apiB;
      expect((await signIn(api, client)).statusCode).toBe(401);
    }
    expect((await signIn(apiA, client)).statusCode).toBe(429);
    expect((await signIn(apiB, client)).statusCode).toBe(429);
  });

  it("limits each client separately behind a trusted proxy hop", async () => {
    // The web app reaches the API from a private address and forwards the
    // one client address its own proxy saw.
    const web = "10.0.0.2";
    for (let i = 0; i < SIGN_IN_MAX; i++) {
      const response = await signIn(apiA, web, {
        "x-forwarded-for": "198.51.100.1",
      });
      expect(response.statusCode).toBe(401);
    }
    expect(
      (await signIn(apiA, web, { "x-forwarded-for": "198.51.100.1" }))
        .statusCode,
    ).toBe(429);
    expect(
      (await signIn(apiA, web, { "x-forwarded-for": "198.51.100.2" }))
        .statusCode,
    ).toBe(401);
  });

  it("leaves the web server's session checks unthrottled", async () => {
    for (let i = 0; i < 120; i++) {
      const response = await apiA.inject({
        method: "GET",
        url: "/api/auth/get-session",
        remoteAddress: "10.0.0.2",
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it("records the resolved client address on the session", async () => {
    const response = await apiA.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      remoteAddress: "203.0.113.30",
      headers: {
        "x-forwarded-for": "198.51.100.77",
        [CLIENT_IP_HEADER]: "198.51.100.78",
      },
      payload: {
        name: "Ada",
        email: "ada@example.com",
        password: "password-12345",
      },
    });
    expect(response.statusCode).toBe(200);
    const rows = await admin`
      select s.ip_address from auth.session s
      join auth."user" u on u.id = s.user_id
      where u.email = 'ada@example.com'
    `;
    expect(rows.map((row) => row.ip_address)).toEqual(["203.0.113.30"]);
  });
});
