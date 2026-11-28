import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionConfigOptionsResponseSchema,
  connectionErrorResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type {
  Connector,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";
import { createPostHogConnector } from "@netrics/connectors";
import { createDatabase, type Database } from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// The PostHog insight picker (#891): the choices of the `insights` field
// are listed per project from PostHog's insight list, before a connection
// exists (draft credentials) and for a stored one (its stored key), and
// what the config chooses comes back as picker values, pasted links
// included. Offline: the real connector reads a stand-in for PostHog.

const HOST = "posthog.picker.example";
const KEY = "phx_server_picker_test_key_0001";
const ORG = "0190b4c2-7d1e-7000-8000-000000000001";

/** Every request the stand-in for PostHog saw. */
const seen: Array<{ host: string; path: string; method: string }> = [];

function answer(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json" },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

const trends = { kind: "InsightVizNode", source: { kind: "TrendsQuery" } };

const provider: ConnectorRuntime = {
  signal: new AbortController().signal,
  fetch: async (raw, init) => {
    const url = new URL(raw);
    seen.push({
      host: url.host,
      path: url.pathname,
      method: init?.method ?? "GET",
    });
    if (init?.headers?.authorization !== `Bearer ${KEY}`)
      return answer(401, {
        type: "authentication_error",
        code: "authentication_failed",
        detail: "Invalid personal API key.",
      });
    const page = (results: unknown[]) => ({
      count: results.length,
      next: null,
      results,
    });
    if (url.pathname === "/api/organizations/")
      return answer(200, page([{ id: ORG, name: "Acme" }]));
    if (url.pathname === `/api/organizations/${ORG}/projects/`)
      return answer(200, page([{ id: 1000, name: "Site" }]));
    if (url.pathname === "/api/projects/1000/query/")
      return answer(200, { results: [[1]], columns: ["1"] });
    if (url.pathname === "/api/projects/1000/insights/")
      return answer(
        200,
        page([
          { id: 1, short_id: "AbCd1234", name: "Signups", query: trends },
          { id: 2, short_id: "EfGh5678", name: "Revenue", query: trends },
        ]),
      );
    if (url.pathname === "/api/projects/1001/insights/")
      return answer(403, {
        type: "authentication_error",
        code: "permission_denied",
        detail: "You don't have access to the project.",
      });
    return answer(404, { detail: "Not found." });
  },
};

function registry(): ConnectorRegistry {
  const posthog = createPostHogConnector({ sleep: async () => {} });
  const offline: Connector = {
    manifest: posthog.manifest,
    check: (context) => posthog.check(context, provider),
    discover: (context) => posthog.discover(context, provider),
    sync: (context, request) => posthog.sync(context, request, provider),
    configOptions: (context, request) =>
      posthog.configOptions!(context, request, provider),
  };
  const result = new ConnectorRegistry();
  result.register(offline);
  return result;
}

let app: FastifyInstance;
let db: Database;
let owner: postgres.Sql;
let cookie: string;
let workspaceId: string;
let connectionId: string;

function call(method: "GET" | "POST", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

const base = () => `/v1/workspaces/${workspaceId}/connections`;

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => {} });
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
  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Picker Owner",
      email: "posthog-picker@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  expect(
    (await call("POST", "/v1/bootstrap", { workspaceName: "Picker" }))
      .statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces")).json(),
  ).workspaces[0]!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("PostHog insight picker (#891)", () => {
  it("names the picked field in the catalog", async () => {
    const response = await call("GET", "/v1/connectors");
    expect(response.statusCode, response.body).toBe(200);
    const posthog = connectorListResponseSchema
      .parse(response.json())
      .connectors.find((entry) => entry.id === "posthog");
    expect(posthog?.configOptions).toEqual([
      { key: "insights", maxSelected: 20 },
    ]);
  });

  it("lists a project's insights with draft credentials, none chosen, and stores nothing", async () => {
    seen.length = 0;
    const response = await call("POST", `${base()}/config-options`, {
      connectorId: "posthog",
      config: { host: HOST },
      credentials: { token: KEY },
      key: "insights",
      resourceId: "1000",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(
      connectionConfigOptionsResponseSchema.parse(response.json()),
    ).toEqual({
      options: [
        { value: "1000/AbCd1234", label: "Signups", description: "AbCd1234" },
        { value: "1000/EfGh5678", label: "Revenue", description: "EfGh5678" },
      ],
      selected: [],
    });
    // One listing request on the configured host, no query.
    expect(seen).toEqual([
      { host: HOST, path: "/api/projects/1000/insights/", method: "GET" },
    ]);
    expect(response.body).not.toContain(KEY);
    const [row] = await owner`
      select count(*)::int as count from connections
      where workspace_id = ${workspaceId}`;
    expect(row!.count).toBe(0);
  });

  it("refuses a field without a picker and names a refused project by its code", async () => {
    const other = await call("POST", `${base()}/config-options`, {
      connectorId: "posthog",
      config: { host: HOST },
      credentials: { token: KEY },
      key: "projects",
      resourceId: "1000",
    });
    expect(other.statusCode, other.body).toBe(400);
    const refused = await call("POST", `${base()}/config-options`, {
      connectorId: "posthog",
      config: { host: HOST },
      credentials: { token: KEY },
      key: "insights",
      resourceId: "1001",
    });
    expect(refused.statusCode, refused.body).toBe(400);
    const error = connectionErrorResponseSchema.parse(refused.json());
    expect(error.errorCode).toBe("posthog.insights_unavailable");
    expect(refused.body).not.toContain("have access to the project");
    const wrongKey = await call("POST", `${base()}/config-options`, {
      connectorId: "posthog",
      config: { host: HOST },
      credentials: { token: "phx_wrong_key_for_picker_test" },
      key: "insights",
      resourceId: "1000",
    });
    expect(wrongKey.statusCode).toBe(400);
    expect(connectionErrorResponseSchema.parse(wrongKey.json()).errorCode).toBe(
      "posthog.key_rejected",
    );
    expect(wrongKey.body).not.toContain("phx_wrong_key_for_picker_test");
  });

  it("lists for a stored connection, its pasted links read as chosen", async () => {
    const created = await call("POST", base(), {
      connectorId: "posthog",
      name: "Self-hosted",
      config: {
        host: HOST,
        insights: `https://${HOST}/project/1000/insights/AbCd1234`,
      },
      credentials: { token: KEY },
    });
    expect(created.statusCode, created.body).toBe(200);
    connectionId = connectionResponseSchema.parse(created.json()).connection.id;
    seen.length = 0;
    const response = await call(
      "POST",
      `${base()}/${connectionId}/config-options`,
      {
        config: {
          host: HOST,
          insights: `https://${HOST}/project/1000/insights/AbCd1234`,
        },
        key: "insights",
        resourceId: "1000",
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    const listing = connectionConfigOptionsResponseSchema.parse(
      response.json(),
    );
    expect(listing.selected).toEqual([
      { value: "1000/AbCd1234", resourceId: "1000" },
    ]);
    expect(listing.options).toHaveLength(2);
    expect(seen.every((request) => request.host === HOST)).toBe(true);
    // The picker's value is a valid config, and the sync reads it.
    const saved = await app.inject({
      method: "PATCH",
      url: `${base()}/${connectionId}`,
      headers: { cookie },
      payload: {
        config: { host: HOST, insights: "1000/AbCd1234 1000/EfGh5678" },
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
  });

  it("keeps the stored connection's host fixed", async () => {
    const created = await call("POST", base(), {
      connectorId: "posthog",
      name: "Fixed host",
      config: { host: HOST },
      credentials: { token: KEY },
    });
    expect(created.statusCode, created.body).toBe(200);
    const fixed = connectionResponseSchema.parse(created.json()).connection.id;
    seen.length = 0;
    const response = await call("POST", `${base()}/${fixed}/config-options`, {
      config: { host: "posthog.other.example" },
      key: "insights",
      resourceId: "1000",
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(connectionErrorResponseSchema.parse(response.json()).error).toBe(
      "connection_host_fixed",
    );
    expect(seen).toEqual([]);
  });
});
