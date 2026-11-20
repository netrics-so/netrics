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
// without NETRICS_PREVIEW_CONNECTORS, and with a leftover
// NETRICS_PREVIEW_CONNECTORS=apple-ads from before Apple Ads left the
// previews. The bundle has no preview at the moment, so a third app marks
// a test-only preview to keep the catalog badge covered. All share one
// database and auth secret, so one session works on each.

const ORIGIN = "https://netrics.example.com";
const secrets = {
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
};

let db: Database;
let appUrl: string;
let plain: FastifyInstance;
let leftover: FastifyInstance;
let withPreview: FastifyInstance;
let cookie: string;
const logLines: string[] = [];
const testPreview = "google-play";

async function productionApp(
  env: Record<string, string>,
  log?: string[],
  preview?: string,
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
  // The operator's opt-in, as the config carries it for a real preview.
  const withOptIn =
    preview !== undefined
      ? { ...config, previewConnectors: new Set([preview]) }
      : config;
  return buildApp(withOptIn, {
    db,
    ...(preview !== undefined ? { previews: new Set([preview]) } : {}),
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
  leftover = await productionApp(
    { NETRICS_PREVIEW_CONNECTORS: "apple-ads" },
    logLines,
  );
  withPreview = await productionApp({}, undefined, testPreview);
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
  await leftover?.close();
  await withPreview?.close();
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
  it("lists Apple Ads, not as a preview, without NETRICS_PREVIEW_CONNECTORS", async () => {
    const connectors = await catalog(plain);
    expect(connectors.map((entry) => entry.id)).toContain("apple-ads");
    expect(connectors.some((entry) => entry.preview)).toBe(false);
  });

  it("starts with a leftover NETRICS_PREVIEW_CONNECTORS=apple-ads and lists it as before", async () => {
    const connectors = await catalog(leftover);
    expect(connectors.map((entry) => entry.id)).toEqual(
      (await catalog(plain)).map((entry) => entry.id),
    );
    expect(connectors.some((entry) => entry.preview)).toBe(false);
  });

  it("only warns about the leftover apple-ads entry", () => {
    const entries = logLines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const registered = entries.find(
      (entry) => entry.msg === "connectors registered",
    );
    expect(registered).toMatchObject({
      connectors: expect.arrayContaining(["demo", "apple-ads"]),
      previews: [],
    });
    const warnings = entries.filter((entry) => Number(entry.level) >= 40);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ ignored: ["apple-ads"], level: 40 });
    expect(String(warnings[0]!.msg)).toMatch(
      /^NETRICS_PREVIEW_CONNECTORS names/,
    );
  });

  it("marks an opted-in preview connector in the catalog", async () => {
    const connectors = await catalog(withPreview);
    expect(
      connectors.filter((entry) => entry.preview).map((entry) => entry.id),
    ).toEqual([testPreview]);
  });
});
