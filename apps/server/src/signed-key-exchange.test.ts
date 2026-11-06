import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionResourcesResponseSchema,
  connectionResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import { createDemoConnector } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring } from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { capturingLogger } from "./oauth/test-provider.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import { p256KeyPair, pemBody } from "./signed-keys/test-keys.js";
import {
  createFakeTokenExchange,
  createFixtureConnector,
  FIXTURE_CONNECTOR_ID,
  FIXTURE_INVALID_CLIENT,
  FIXTURE_PROVIDER_ID,
  fixtureClient,
  fixtureCredentials,
  fixtureExchangeProvider,
} from "./signed-keys/test-token-exchange.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// #369 (ADR 0020 §2) through the API and the sync engine, with a fixture
// provider that exchanges a signed client secret for an access token (no
// Apple Ads code): the wizard's candidate key exchanges without caching,
// a stored connection's sync pages share one cached token, key rotation
// and deletion clear it, a refused key is auth_failed, and no client
// secret, private key or token reaches a response, a log line, a job
// payload or a stored error.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);

const CLIENT = fixtureClient(p256KeyPair());
const ROTATED = { ...fixtureClient(p256KeyPair()) };
const fake = createFakeTokenExchange([CLIENT, ROTATED]);

function registry(pages = 3): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(createFixtureConnector(fake, { pages }));
  return registry;
}

const signedKeys = new SignedKeyProviders({
  definitions: new Map([[FIXTURE_PROVIDER_ID, fixtureExchangeProvider]]),
  http: () => (url, init) => fake.fetch(url, init),
});

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
let connectionId: string;
const logs: string[] = [];
const bodies: string[] = [];

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry());
  await owner.$client.end({ timeout: 5 });
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "debug",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry: registry(),
    signedKeys,
    checkDb: async () => true,
    logger: capturingLogger(logs),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "exchange-owner@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  await app.inject({
    method: "POST",
    url: "/v1/bootstrap",
    headers: { cookie },
    payload: { workspaceName: "Exchange" },
  });
  workspaceId = workspaceListResponseSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { cookie },
      })
    ).json(),
  ).workspaces[0]!.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  payload?: Record<string, unknown>,
) {
  const response = await app.inject({
    method,
    url: `/v1/workspaces/${workspaceId}${path}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
  bodies.push(response.body);
  return response;
}

async function runSync(id: string, pages = 3) {
  const handlers = createJobHandlers({
    registry: registry(pages),
    credentialKeyring: KEYRING,
    signedKeys,
  });
  return handlers["connection.sync"]!({
    job: {
      id: randomUUID(),
      kind: "connection.sync",
      workspaceId,
      connectionId: id,
      payload: {},
      runAt: new Date(),
      attempts: 0,
      maxAttempts: 8,
      status: "running",
      lockedBy: "test",
      lockedAt: new Date(),
      lastError: null,
      idempotencyKey: null,
      createdAt: new Date(),
    },
    appDb: db,
    schedulerDb: db,
    logger: capturingLogger(logs),
  });
}

async function cachedTokenRows(id: string) {
  return admin`
    select access_token_encrypted from connection_signed_key_tokens
    where connection_id = ${id}
  `;
}

describe("signed-key connections with a token exchange", () => {
  it("previews a candidate key with exchanged tokens and caches nothing", async () => {
    const response = await call("POST", "/connections/preview", {
      connectorId: FIXTURE_CONNECTOR_ID,
      config: {},
      credentials: fixtureCredentials(CLIENT),
    });
    expect(response.statusCode).toBe(200);
    // Probe, check and discover: each with an exchange, none stored.
    expect(fake.exchanges).toBe(3);
    expect(
      await admin`select count(*)::int as count from connection_signed_key_tokens`,
    ).toEqual([{ count: 0 }]);
  });

  it("creates a connection without caching the candidate key's token", async () => {
    const response = await call("POST", "/connections", {
      connectorId: FIXTURE_CONNECTOR_ID,
      name: "Test Ads",
      config: {},
      credentials: fixtureCredentials(CLIENT),
    });
    expect(response.statusCode).toBe(200);
    connectionId = connectionResponseSchema.parse(response.json()).connection
      .id;
    expect(await cachedTokenRows(connectionId)).toHaveLength(0);
  });

  it("syncs every page and the check with one exchange, and reuses the token in the next run", async () => {
    const before = fake.exchanges;
    await runSync(connectionId);
    expect(fake.exchanges).toBe(before + 1);
    // check + three pages, all with the one exchanged token.
    const token = fake.issued.at(-1)!;
    expect(fake.apiCalls.slice(-4)).toEqual([token, token, token, token]);
    expect(await cachedTokenRows(connectionId)).toHaveLength(1);

    await runSync(connectionId);
    expect(fake.exchanges).toBe(before + 1);

    const resources = await call(
      "GET",
      `/connections/${connectionId}/resources`,
    );
    expect(
      connectionResourcesResponseSchema.parse(resources.json()).resources,
    ).toHaveLength(1);
    expect(fake.apiCalls.at(-1)).toBe(token);
    expect(fake.exchanges).toBe(before + 1);

    const [state] = await admin`
      select auth_state, consecutive_failures from connection_state
      where connection_id = ${connectionId}
    `;
    expect(state).toMatchObject({ auth_state: "ok", consecutive_failures: 0 });
  });

  it("re-exchanges once when the provider drops the cached token mid-life", async () => {
    const before = fake.exchanges;
    fake.revoke(fake.issued.at(-1)!);
    await runSync(connectionId, 1);
    expect(fake.exchanges).toBe(before + 1);
    const [state] = await admin`
      select auth_state from connection_state where connection_id = ${connectionId}
    `;
    expect(state).toMatchObject({ auth_state: "ok" });
  });

  it("clears the cached token when the key is replaced", async () => {
    expect(await cachedTokenRows(connectionId)).toHaveLength(1);
    const rotated = await call("PATCH", `/connections/${connectionId}`, {
      credentials: fixtureCredentials(ROTATED),
    });
    expect(rotated.statusCode).toBe(200);
    expect(await cachedTokenRows(connectionId)).toHaveLength(0);
    const before = fake.exchanges;
    await runSync(connectionId, 1);
    expect(fake.exchanges).toBe(before + 1);
  });

  it("puts a connection whose key was removed at the provider in auth_failed", async () => {
    // The provider forgets the key: the cached token is refused, the
    // re-exchange answers invalid_client.
    fake.clients.splice(fake.clients.indexOf(ROTATED), 1);
    fake.revoke(fake.issued.at(-1)!);
    await expect(runSync(connectionId, 1)).rejects.toThrow(
      FIXTURE_INVALID_CLIENT,
    );
    const [state] = await admin`
      select auth_state from connection_state
      where connection_id = ${connectionId}
    `;
    expect(state).toMatchObject({ auth_state: "auth_failed" });
    const [run] = await admin`
      select error_message from sync_runs where connection_id = ${connectionId}
      order by started_at desc limit 1
    `;
    expect(run).toMatchObject({ error_message: FIXTURE_INVALID_CLIENT });
    fake.clients.push(ROTATED);
  });

  it("refuses a candidate key the provider does not know, with the provider's message", async () => {
    const stranger = fixtureClient(p256KeyPair());
    const response = await call("POST", "/connections/preview", {
      connectorId: FIXTURE_CONNECTOR_ID,
      config: {},
      credentials: fixtureCredentials(stranger),
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      FIXTURE_INVALID_CLIENT,
    );
  });

  it("deletes the cached token with the connection", async () => {
    await call("PATCH", `/connections/${connectionId}`, {
      credentials: fixtureCredentials(CLIENT),
    });
    await runSync(connectionId, 1);
    expect(await cachedTokenRows(connectionId)).toHaveLength(1);
    const deleted = await call("DELETE", `/connections/${connectionId}`);
    expect(deleted.statusCode).toBeLessThan(300);
    expect(await cachedTokenRows(connectionId)).toHaveLength(0);
  });

  it("puts no client secret, private key or access token in responses, logs, job payloads or stored errors", async () => {
    const jobs =
      await admin`select payload::text as payload, last_error from jobs`;
    const runs = await admin`select error_message from sync_runs`;
    const text = [
      ...bodies,
      ...logs,
      ...jobs.map((row) => `${row.payload} ${row.last_error ?? ""}`),
      ...runs.map((row) => String(row.error_message ?? "")),
    ].join("\n");
    expect(fake.clientSecrets.length).toBeGreaterThan(0);
    expect(fake.issued.length).toBeGreaterThan(0);
    for (const secret of [...fake.clientSecrets, ...fake.issued]) {
      expect(text).not.toContain(secret);
    }
    for (const client of [CLIENT, ROTATED]) {
      expect(text).not.toContain(
        pemBody(client.key.privateKeyPem).slice(20, 60),
      );
    }
    expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    expect(text).not.toContain("fixture-access-");
  });
});
