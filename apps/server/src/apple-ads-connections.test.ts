import { randomBytes, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionPreviewResponseSchema,
  connectionResourcesResponseSchema,
  connectionResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import {
  createAppleAdsConnector,
  createDemoConnector,
} from "@netrics/connectors";
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
import { INVALID_CLIENT_MESSAGE } from "./signed-keys/providers/apple-ads.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  apiUserCredentials,
  createFakeAppleAdsServer,
  fakeApiUserKey,
  type FakeAdAccount,
} from "./signed-keys/test-apple-ads.js";
import { p256KeyPair, pemBody } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// #373 through the API and the sync engine: the real Apple Ads provider
// (token exchange, access probe) and connector against an offline fake of
// Apple's token endpoint and Platform API. One API user's key reads two ad
// accounts; each becomes its own connection in one workspace, and every
// call of a connection carries only its own ad account as X-AP-Context.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
/** Sync windows run on a pinned clock, never the real one. */
const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);

const US: FakeAdAccount = {
  id: "4100000001",
  name: "Example Apps US",
  orgId: "4000000001",
  currency: "USD",
  timezone: "America/Los_Angeles",
  productFeatures: ["APPSTORE_APP_MANUAL"],
  campaigns: [
    { id: "5100000001", name: "Wurfel – Brand", appId: "1000000001" },
  ],
};
const EU: FakeAdAccount = {
  id: "4100000002",
  name: "Example Apps EU",
  orgId: "4000000001",
  currency: "EUR",
  timezone: "Europe/Berlin",
  productFeatures: ["APPSTORE_APP_MANUAL"],
  campaigns: [
    { id: "5200000001", name: "Wurfel – DE Brand", appId: "1000000001" },
  ],
};
const MAPS: FakeAdAccount = {
  ...US,
  id: "4100000003",
  name: "Example Cafés on Maps",
  productFeatures: ["BUSINESS_BRAND_MANUAL"],
  campaigns: [],
};

const USER = fakeApiUserKey(p256KeyPair(), {
  [US.id]: ["API Account Read Only"],
  [EU.id]: ["Limited Access: API Read Only"],
  [MAPS.id]: ["API Account Read Only"],
});
const apple = createFakeAppleAdsServer([US, EU, MAPS], [USER]);

/** The real connector, its runtime.fetch pointed at the fake API. */
function towardsFake(connector: Connector): Connector {
  const rewrite = (runtime: ConnectorRuntime): ConnectorRuntime => ({
    signal: runtime.signal,
    fetch: (url, init) => apple.fetch(url, init),
  });
  return {
    manifest: connector.manifest,
    check: (context, runtime) => connector.check(context, rewrite(runtime)),
    discover: (context, runtime) =>
      connector.discover(context, rewrite(runtime)),
    sync: (context, request, runtime) =>
      connector.sync(context, request, rewrite(runtime)),
  };
}

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(towardsFake(createAppleAdsConnector({ now: () => NOW })));
  return registry;
}

const signedKeys = new SignedKeyProviders({
  http: () => (url, init) => apple.fetch(url, init),
});

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
const connections: Record<string, string> = {};
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
      email: "apple-ads-owner@example.com",
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
    payload: { workspaceName: "Apple Ads" },
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

async function runSync(id: string) {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    signedKeys,
    now: () => new Date(NOW),
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

/** API calls made with the given connection's cached token. */
async function callsOf(id: string) {
  const [row] = await admin`
    select count(*)::int as count from connection_signed_key_tokens
    where connection_id = ${id}
  `;
  expect(row).toEqual({ count: 1 });
  return apple.calls;
}

describe("Apple Ads connections", () => {
  it("previews the key: lists the API user's ad accounts, Apple Maps not selectable", async () => {
    const response = await call("POST", "/connections/preview", {
      connectorId: "apple-ads",
      config: {},
      credentials: apiUserCredentials(USER),
    });
    expect(response.statusCode).toBe(200);
    const preview = connectionPreviewResponseSchema.parse(response.json());
    expect(preview.check).toEqual({ ok: true });
    expect(
      preview.resources.map(({ id, kind, metadata }) => [
        id,
        kind,
        metadata?.selectable,
        metadata?.currency,
        metadata?.timeZone,
      ]),
    ).toEqual([
      [US.id, "ad_account", true, "USD", "America/Los_Angeles"],
      [EU.id, "ad_account", true, "EUR", "Europe/Berlin"],
      [MAPS.id, "ad_account", false, "USD", "America/Los_Angeles"],
    ]);
  });

  it("refuses to connect an Apple Maps ad account", async () => {
    const response = await call("POST", "/connections", {
      connectorId: "apple-ads",
      name: "Maps",
      config: { adAccountId: MAPS.id },
      credentials: apiUserCredentials(USER),
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toContain(
      "Apple Maps ads are not supported yet",
    );
  });

  it("connects two ad accounts with one key, as two connections in one workspace", async () => {
    for (const account of [US, EU]) {
      const response = await call("POST", "/connections", {
        connectorId: "apple-ads",
        name: account.name,
        config: {
          adAccountId: account.id,
          currency: account.currency,
          timeZone: account.timezone,
        },
        credentials: apiUserCredentials(USER),
      });
      expect(response.statusCode).toBe(200);
      connections[account.id] = connectionResponseSchema.parse(
        response.json(),
      ).connection.id;
    }
    expect(new Set(Object.values(connections)).size).toBe(2);
  });

  it("syncs each connection in its own ad account context only", async () => {
    for (const account of [US, EU]) {
      apple.calls.length = 0;
      await runSync(connections[account.id]!);
      const calls = await callsOf(connections[account.id]!);
      const scoped = calls.filter((entry) => entry.path !== "/v1/acls");
      expect(scoped.length).toBeGreaterThan(0);
      for (const entry of scoped) {
        expect(entry.context).toBe(`adAccountId=${account.id}`);
      }
      const [state] = await admin`
        select auth_state from connection_state
        where connection_id = ${connections[account.id]!}
      `;
      expect(state).toMatchObject({ auth_state: "ok" });
    }
    // Two connections, two cached tokens: neither reuses the other's.
    const rows = await admin`
      select connection_id from connection_signed_key_tokens
    `;
    expect(rows).toHaveLength(2);
  });

  it("names each connection's own campaigns and apps", async () => {
    for (const account of [US, EU]) {
      const response = await call(
        "GET",
        `/connections/${connections[account.id]!}/resources`,
      );
      expect(response.statusCode).toBe(200);
      const { resources } = connectionResourcesResponseSchema.parse(
        response.json(),
      );
      expect(resources.map(({ id, kind }) => [id, kind])).toEqual([
        ["1000000001", "app"],
        [account.campaigns[0]!.id, "campaign"],
      ]);
    }
  });

  it("puts a connection whose ad account left the API user's ACL in auth_failed", async () => {
    USER.acl.delete(EU.id);
    await expect(runSync(connections[EU.id]!)).rejects.toThrow(
      `no longer has access to ad account ${EU.id}`,
    );
    const [state] = await admin`
      select auth_state from connection_state
      where connection_id = ${connections[EU.id]!}
    `;
    expect(state).toMatchObject({ auth_state: "auth_failed" });
    // The other connection is unaffected.
    await runSync(connections[US.id]!);
    const [other] = await admin`
      select auth_state from connection_state
      where connection_id = ${connections[US.id]!}
    `;
    expect(other).toMatchObject({ auth_state: "ok" });
    USER.acl.set(EU.id, ["Limited Access: API Read Only"]);
  });

  it("refuses a key whose IDs do not match the public key", async () => {
    const response = await call("POST", "/connections/preview", {
      connectorId: "apple-ads",
      config: {},
      credentials: { ...apiUserCredentials(USER), keyId: randomUUID() },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      INVALID_CLIENT_MESSAGE,
    );
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
    expect(apple.clientSecrets.length).toBeGreaterThan(0);
    for (const secret of [...apple.clientSecrets, ...apple.issued]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain(pemBody(USER.key.privateKeyPem).slice(20, 60));
    expect(text).not.toContain("apple-ads-test-");
  });
});
