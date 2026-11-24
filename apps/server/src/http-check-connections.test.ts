import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createHttpCheckConnector,
  httpCheckId as checkId,
} from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// HTTP check connections through the API (#874 review): their resources
// are their configuration. A check list is saved with its names known at
// once, a removed check's freshness goes with it, and a resource selection
// (which the sync could not honor) is refused.

type Response = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let workspaceId: string;

function registry(): ConnectorRegistry {
  const result = new ConnectorRegistry();
  result.register(createHttpCheckConnector());
  return result;
}

async function signUp(email: string, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: unknown,
): Promise<Response> {
  return app.inject({
    method,
    url,
    headers: { cookie: owner },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

const check = (name: string, host = "status.example.com") => ({
  name,
  url: `https://${host}/health`,
});

async function create(checks: unknown[], extra: object = {}) {
  return call("POST", `/v1/workspaces/${workspaceId}/connections`, {
    connectorId: "http-check",
    name: "Checks",
    config: { checks },
    ...extra,
  });
}

async function resourceNames(connectionId: string) {
  const rows = await admin`
    select resource_id, name from connection_resources
    where connection_id = ${connectionId} order by name`;
  return rows.map((row) => [row.resource_id, row.name]);
}

async function freshnessResources(connectionId: string) {
  const rows = await admin`
    select resource from connection_freshness
    where connection_id = ${connectionId} order by resource`;
  return rows.map((row) => row.resource as string);
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  const catalogOwner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(catalogOwner, registry());
  await catalogOwner.$client.end({ timeout: 5 });
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, {
    db,
    authService,
    registry: registry(),
    checkDb: async () => true,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("checks-owner@example.com", "Ada Owner");
  expect(
    (await call("POST", "/v1/bootstrap", { workspaceName: "Checks" }))
      .statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces")).json(),
  ).workspaces[0]!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

describe("HTTP check connections (#874 review)", () => {
  it("refuses a resource selection: a check is removed from the list instead", async () => {
    const refused = await create([check("Site"), check("Api")], {
      resources: [checkId("Site")],
    });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({
      error: expect.stringMatching(/remove a check/i),
    });

    const created = await create([check("Site 2")]);
    expect(created.statusCode, created.body).toBe(200);
    const connectionId = connectionResponseSchema.parse(created.json())
      .connection.id;
    const patched = await call(
      "PATCH",
      `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
      { resources: [checkId("Site 2")] },
    );
    expect(patched.statusCode, patched.body).toBe(400);
  });

  it("names new and renamed checks when the list is saved, and retires the freshness of checks it no longer has", async () => {
    const created = await create([check("Site"), check("Api")]);
    expect(created.statusCode, created.body).toBe(200);
    const connectionId = connectionResponseSchema.parse(created.json())
      .connection.id;
    // As a finished run leaves them: one row per check, and the
    // connection's own (resource '').
    for (const resource of [checkId("Site"), checkId("Api"), ""]) {
      await admin`
        insert into connection_freshness
          (workspace_id, connection_id, stream, resource, checked_at)
        values (${workspaceId}, ${connectionId}, 'checks', ${resource}, now())`;
    }

    const saved = await call(
      "PATCH",
      `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
      {
        config: {
          checks: [check("Site"), check("Status page", "other.example.org")],
        },
      },
    );
    expect(saved.statusCode, saved.body).toBe(200);

    expect(await resourceNames(connectionId)).toEqual(
      expect.arrayContaining([
        [checkId("Site"), "Site"],
        [checkId("Status page"), "Status page"],
      ]),
    );
    expect(await freshnessResources(connectionId)).toEqual(
      ["", checkId("Site")].sort(),
    );
  });
});
