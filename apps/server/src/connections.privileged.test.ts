import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionListResponseSchema,
  connectionResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { createDefaultRegistry } from "./connectors.js";
import { createDatabase, type Database } from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

// Runs the connection routes on a superuser connection, where PostgreSQL
// skips row-level security entirely. Isolation must then come from the
// explicit workspace predicates in the queries alone.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let aliceCookie: string;
let aliceWorkspaceId: string;
let bobConnectionId: string;

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined ? { payload } : {}),
  };
  return app.inject(options);
}

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function onlyWorkspaceId(cookie: string): Promise<string> {
  const response = await call("GET", "/v1/workspaces", cookie);
  return workspaceListResponseSchema.parse(response.json()).workspaces[0]!.id;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.adminUrl,
    LOG_LEVEL: "silent",
  });
  db = createDatabase(testDb.adminUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, {
    db,
    authService,
    registry: createDefaultRegistry(),
    checkDb: async () => true,
  });

  aliceCookie = await signUp("alice-privileged@example.com");
  expect(
    (
      await call("POST", "/v1/bootstrap", aliceCookie, {
        workspaceName: "Alice",
      })
    ).statusCode,
  ).toBe(200);
  aliceWorkspaceId = await onlyWorkspaceId(aliceCookie);

  const bobCookie = await signUp("bob-privileged@example.com");
  expect(
    (await call("POST", "/v1/workspaces", bobCookie, { name: "Bob" }))
      .statusCode,
  ).toBe(200);
  const bobWorkspaceId = await onlyWorkspaceId(bobCookie);
  const created = await call(
    "POST",
    `/v1/workspaces/${bobWorkspaceId}/connections`,
    bobCookie,
    { connectorId: "demo", name: "Bob's connection" },
  );
  expect(created.statusCode).toBe(200);
  bobConnectionId = connectionResponseSchema.parse(created.json()).connection
    .id;
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("connection routes without RLS (superuser connection)", () => {
  it("never lists another workspace's connections", async () => {
    const response = await call(
      "GET",
      `/v1/workspaces/${aliceWorkspaceId}/connections`,
      aliceCookie,
    );
    expect(response.statusCode).toBe(200);
    expect(
      connectionListResponseSchema.parse(response.json()).connections,
    ).toEqual([]);
  });

  it("treats another workspace's connection id as not found", async () => {
    const base = `/v1/workspaces/${aliceWorkspaceId}/connections/${bobConnectionId}`;
    for (const [method, url, payload] of [
      ["GET", base, undefined],
      ["PATCH", base, { name: "hijack" }],
      ["POST", `${base}/sync`, undefined],
      ["GET", `${base}/observations`, undefined],
      ["DELETE", base, undefined],
    ] as const) {
      const response = await call(method, url, aliceCookie, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(errorResponseSchema.parse(response.json())).toEqual({
        error: "connection_not_found",
      });
    }
  });
});
