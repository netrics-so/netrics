import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionResponseSchema,
  storedConnectionPreviewResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  findResourceNames,
  resourceNameKey,
  upsertConnectionResources,
  withWorkspace,
  type Database,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// The app picker of a stored connection names apps (#623): a connector that
// can only list IDs right now (Google Play without the Reporting API lists
// package names) keeps the names an earlier sync stored.

const CONNECTOR = "unnamed-demo";

function registry(): ConnectorRegistry {
  const demo = createDemoConnector();
  const result = new ConnectorRegistry();
  result.register({
    ...demo,
    manifest: {
      ...demoManifest,
      id: CONNECTOR,
      name: "Unnamed demo",
      translations: {},
    },
    // Like Google Play without names: every app is listed by its ID.
    async discover(context, runtime) {
      const resources = await demo.discover!(context, runtime);
      return resources.map((resource) => ({ ...resource, name: resource.id }));
    },
  });
  return result;
}

let app: FastifyInstance;
let db: Database;
let owner: string;
let workspaceId: string;
let connectionId: string;

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

function call(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie: owner },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

async function preview() {
  const response = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/preview`,
    { config: { resources: 2 } },
  );
  expect(response.statusCode, response.body).toBe(200);
  return storedConnectionPreviewResponseSchema.parse(response.json()).resources;
}

function store(resources: { id: string; name: string }[]) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    upsertConnectionResources(tx, {
      workspaceId,
      connectionId,
      resources: resources.map((resource) => ({ ...resource, kind: "site" })),
      now: new Date(),
    }),
  );
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
  owner = await signUp("names-owner@example.com", "Ada Owner");
  expect(
    (await call("POST", "/v1/bootstrap", { workspaceName: "Names" }))
      .statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces")).json(),
  ).workspaces[0]!.id;
  const created = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/connections`,
    { connectorId: CONNECTOR, name: "Store", config: { resources: 2 } },
  );
  expect(created.statusCode, created.body).toBe(200);
  connectionId = connectionResponseSchema.parse(created.json()).connection.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("app picker names", () => {
  it("lists the IDs while no name is known", async () => {
    expect(await preview()).toMatchObject([
      { id: "demo-site-1", name: "demo-site-1" },
      { id: "demo-site-2", name: "demo-site-2" },
    ]);
  });

  it("names apps with the names an earlier sync stored", async () => {
    await store([{ id: "demo-site-1", name: "Puzzle Quest" }]);
    expect(await preview()).toMatchObject([
      { id: "demo-site-1", name: "Puzzle Quest" },
      { id: "demo-site-2", name: "demo-site-2" },
    ]);
  });

  it("a discover that only repeats the ID keeps the stored name", async () => {
    await store([
      { id: "demo-site-1", name: "demo-site-1" },
      { id: "demo-site-2", name: "Road Racer" },
    ]);
    const names = await withWorkspace(db, { workspaceId }, (tx) =>
      findResourceNames(tx, workspaceId, [
        { connectionId, resourceId: "demo-site-1" },
        { connectionId, resourceId: "demo-site-2" },
      ]),
    );
    expect(names.get(resourceNameKey(connectionId, "demo-site-1"))).toBe(
      "Puzzle Quest",
    );
    expect(names.get(resourceNameKey(connectionId, "demo-site-2"))).toBe(
      "Road Racer",
    );
    // A real new name still replaces the stored one.
    await store([{ id: "demo-site-1", name: "Puzzle Quest 2" }]);
    expect((await preview())[0]).toMatchObject({ name: "Puzzle Quest 2" });
  });
});
