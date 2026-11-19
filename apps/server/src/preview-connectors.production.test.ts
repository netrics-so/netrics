import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectorListResponseSchema } from "@netrics/contracts";
import { createDatabase, type Database } from "@netrics/database";

import { buildApp } from "./app.js";
import { loadConfig } from "./env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// The API as a production instance builds it from its environment (#378):
// without NETRICS_PREVIEW_CONNECTORS, and with it naming Apple Ads. Both
// share one database and auth secret, so one session works on both.

const ORIGIN = "https://netrics.example.com";
const secrets = {
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

let db: Database;
let appUrl: string;
let plain: FastifyInstance;
let optedIn: FastifyInstance;
let cookie: string;
const logLines: string[] = [];

async function productionApp(
  env: Record<string, string>,
  log?: string[],
): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: "production",
    NETRICS_SIGNUP: "open",
    DATABASE_URL: appUrl,
    BETTER_AUTH_URL: ORIGIN,
    WEB_ORIGIN: ORIGIN,
    LOG_LEVEL: "silent",
    ...secrets,
    ...env,
  });
  return buildApp(config, {
    db,
    checkDb: async () => true,
    ...(log
      ? {
          logger: pino(
            { level: "info" },
            { write: (line: string) => log.push(line) },
          ),
        }
      : {}),
  });
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  appUrl = testDb.appUrl;
  db = createDatabase(testDb.appUrl);
  plain = await productionApp({});
  optedIn = await productionApp(
    { NETRICS_PREVIEW_CONNECTORS: "apple-ads,demo" },
    logLines,
  );
  const signUp = await plain.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: { origin: ORIGIN },
    payload: {
      name: "Operator",
      email: "operator@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode, signUp.body).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .filter((c): c is string => typeof c === "string")
    .map((c) => c.split(";")[0])
    .join("; ");
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await plain?.close();
  await optedIn?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

async function catalog(app: FastifyInstance) {
  const response = await app.inject({
    method: "GET",
    url: "/v1/connectors",
    headers: { cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return connectorListResponseSchema.parse(response.json()).connectors;
}

describe("preview connectors in production (#378)", () => {
  it("lists no Apple Ads without NETRICS_PREVIEW_CONNECTORS", async () => {
    const connectors = await catalog(plain);
    expect(connectors.map((entry) => entry.id)).not.toContain("apple-ads");
    expect(connectors.some((entry) => entry.preview)).toBe(false);
  });

  it("lists Apple Ads as a preview when the operator turns it on", async () => {
    const connectors = await catalog(optedIn);
    expect(
      connectors.filter((entry) => entry.preview).map((entry) => entry.id),
    ).toEqual(["apple-ads"]);
  });

  it("logs the registered connectors and the ignored finished one", () => {
    const entries = logLines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const registered = entries.find(
      (entry) => entry.msg === "connectors registered",
    );
    expect(registered).toMatchObject({
      connectors: expect.arrayContaining(["demo", "apple-ads"]),
      previews: ["apple-ads"],
    });
    const warning = entries.find((entry) =>
      String(entry.msg).startsWith("NETRICS_PREVIEW_CONNECTORS names"),
    );
    expect(warning).toMatchObject({ ignored: ["demo"], level: 40 });
  });
});
