import { createPublicKey, randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionDetailResponseSchema,
  connectionPreviewResponseSchema,
  connectionResponseSchema,
  connectionsResponseSchema,
  errorResponseSchema,
  signedKeyPairResponseSchema,
  workspaceListResponseSchema,
  type SignedKeyPairResponse,
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
import {
  createCredentialKeyring,
  decryptCredentials,
  decryptPendingSignedKey,
} from "./credentials.js";
import { loadConfig } from "./env.js";
import { capturingLogger } from "./oauth/test-provider.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  createFakeAppleAdsServer,
  fakeApiUserKey,
  type FakeAdAccount,
  type FakeApiUserKey,
} from "./signed-keys/test-apple-ads.js";
import { pemBody } from "./signed-keys/test-keys.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// #375 through the API: the guided Apple Ads setup. netrics generates the
// key pair, the API user "pastes" the public key at a fake Apple Ads, the
// preview lists the ad accounts, and one request creates a connection per
// chosen ad account from one pending key, all or none. Replacing the key of
// one of them replaces it in every connection that shares it, after each
// is checked with the new key. A second workspace can use none of it.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);

const US: FakeAdAccount = {
  id: "4100000001",
  name: "Example Apps US",
  orgId: "4000000001",
  currency: "USD",
  timezone: "America/Los_Angeles",
  productFeatures: ["APPSTORE_APP_MANUAL"],
  campaigns: [{ id: "5100000001", name: "Brand", appId: "1000000001" }],
};
const EU: FakeAdAccount = {
  ...US,
  id: "4100000002",
  name: "Example Apps EU",
  currency: "EUR",
  timezone: "Europe/Berlin",
  campaigns: [{ id: "5200000001", name: "DE Brand", appId: "1000000001" }],
};
const MAPS: FakeAdAccount = {
  ...US,
  id: "4100000003",
  name: "Example Cafés on Maps",
  productFeatures: ["BUSINESS_BRAND_MANUAL"],
  campaigns: [],
};
const ACL = {
  [US.id]: ["API Account Read Only"],
  [EU.id]: ["Limited Access: API Read Only"],
  [MAPS.id]: ["API Account Read Only"],
};

const apple = createFakeAppleAdsServer([US, EU, MAPS], []);

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
  registry.register(towardsFake(createAppleAdsConnector()));
  return registry;
}

const signedKeys = new SignedKeyProviders({
  http: () => (url, init) => apple.fetch(url, init),
});

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let other: string;
let w1: string;
let w2: string;
const logs: string[] = [];
const bodies: string[] = [];
const privateKeys: string[] = [];

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(ownerDb, registry());
  await ownerDb.$client.end({ timeout: 5 });
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

  owner = await signUp("wizard-owner@example.com");
  other = await signUp("wizard-other@example.com");
  await app.inject({
    method: "POST",
    url: "/v1/bootstrap",
    headers: { cookie: owner },
    payload: { workspaceName: "W1" },
  });
  w1 = workspaceListResponseSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { cookie: owner },
      })
    ).json(),
  ).workspaces[0]!.id;
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: other },
    payload: { name: "W2" },
  });
  expect(created.statusCode).toBe(200);
  w2 = (created.json() as { workspace: { id: string } }).workspace.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

async function call(
  cookie: string,
  workspaceId: string,
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

/**
 * Generates a pair, and "pastes" its public key in the fake Apple Ads: a
 * new API user key with the given ACL and fresh IDs.
 */
async function generate(
  acl: Record<string, string[]> = ACL,
  cookie = owner,
  workspaceId = w1,
): Promise<{ pair: SignedKeyPairResponse; user: FakeApiUserKey }> {
  const response = await call(
    cookie,
    workspaceId,
    "POST",
    "/signed-keys/apple-ads/key-pairs",
  );
  expect(response.statusCode).toBe(200);
  const pair = signedKeyPairResponseSchema.parse(response.json());
  const user = fakeApiUserKey(
    { privateKeyPem: "", publicKey: createPublicKey(pair.publicKey) },
    acl,
  );
  apple.users.push(user);
  const [row] = await admin`
    select workspace_id, private_key_encrypted from signed_key_pending_keys
    where id = ${pair.pendingKeyId}`;
  privateKeys.push(
    decryptPendingSignedKey(
      (row!.private_key_encrypted as Buffer).toString("utf8"),
      KEYRING,
      {
        workspaceId: row!.workspace_id as string,
        pendingKeyId: pair.pendingKeyId,
      },
    ),
  );
  return { pair, user };
}

function idsOf(user: FakeApiUserKey) {
  return { clientId: user.clientId, teamId: user.teamId, keyId: user.keyId };
}

function accountConfig(account: FakeAdAccount) {
  return {
    adAccountId: account.id,
    adAccountName: account.name,
    currency: account.currency,
    timeZone: account.timezone,
  };
}

async function pendingCount(id: string): Promise<number> {
  const [row] = await admin`
    select count(*)::int as count from signed_key_pending_keys where id = ${id}`;
  return (row as { count: number }).count;
}

async function storedKeyId(connectionId: string): Promise<string> {
  const [row] = await admin`
    select workspace_id, credentials_encrypted from connections
    where id = ${connectionId}`;
  const envelope = JSON.parse(
    decryptCredentials(
      (row!.credentials_encrypted as Buffer).toString("utf8"),
      KEYRING,
      { workspaceId: row!.workspace_id as string, connectionId },
    ),
  ) as Record<string, string>;
  return envelope.keyId!;
}

const created = { us: "", eu: "" };

describe("Apple Ads guided setup (#375)", () => {
  it("offers a generated key pair for Apple Ads", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/connectors",
      headers: { cookie: owner },
    });
    const strategy = (
      response.json() as {
        connectors: Array<{
          id: string;
          authStrategies: Array<{ generatedKeyPair?: boolean }>;
        }>;
      }
    ).connectors.find((entry) => entry.id === "apple-ads")!.authStrategies[0]!;
    expect(strategy.generatedKeyPair).toBe(true);
  });

  it("lists the ad accounts with a generated key, without consuming it", async () => {
    const { pair, user } = await generate();
    const response = await call(owner, w1, "POST", "/connections/preview", {
      connectorId: "apple-ads",
      config: {},
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
    });
    expect(response.statusCode).toBe(200);
    const preview = connectionPreviewResponseSchema.parse(response.json());
    expect(preview.check.ok).toBe(true);
    expect(preview.resources.map((r) => r.id)).toEqual([US.id, EU.id, MAPS.id]);
    expect(await pendingCount(pair.pendingKeyId)).toBe(1);
  });

  it("creates nothing when one chosen ad account is refused, and keeps the pending key", async () => {
    const { pair, user } = await generate();
    const response = await call(owner, w1, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
      connections: [
        { name: "US", config: accountConfig(US) },
        { name: "Maps", config: accountConfig(MAPS) },
      ],
    });
    expect(response.statusCode).toBe(400);
    const { error } = errorResponseSchema.parse(response.json());
    expect(error).toMatch(/^Maps: /);
    expect(error).toContain("Apple Maps ads are not supported yet");
    const [count] = await admin`
      select count(*)::int as count from connections where workspace_id = ${w1}`;
    expect(count).toEqual({ count: 0 });
    expect(await pendingCount(pair.pendingKeyId)).toBe(1);
  });

  it("refuses the same ad account twice in one request", async () => {
    const { pair, user } = await generate();
    const response = await call(owner, w1, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
      connections: [
        { name: "US", config: accountConfig(US) },
        { name: "US again", config: accountConfig(US) },
      ],
    });
    expect(response.statusCode).toBe(400);
    expect(await pendingCount(pair.pendingKeyId)).toBe(1);
  });

  it("creates one connection per chosen ad account from one generated key, in one request", async () => {
    const { pair, user } = await generate();
    const response = await call(owner, w1, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
      connections: [
        { name: "Apple Ads · US", config: accountConfig(US) },
        { name: "Apple Ads · EU", config: accountConfig(EU) },
      ],
    });
    expect(response.statusCode).toBe(200);
    const { connections } = connectionsResponseSchema.parse(response.json());
    expect(connections.map((c) => c.config)).toEqual([
      accountConfig(US),
      accountConfig(EU),
    ]);
    created.us = connections[0]!.id;
    created.eu = connections[1]!.id;
    expect(connections[0]!.signedKey?.sharedWith).toEqual([
      { id: created.eu, name: "Apple Ads · EU" },
    ]);
    expect(connections[0]!.signedKey?.fields.map((field) => field.key)).toEqual(
      ["clientId", "teamId", "keyId"],
    );
    // The pending key moved into both connections and is gone.
    expect(await pendingCount(pair.pendingKeyId)).toBe(0);
    expect(await storedKeyId(created.us)).toBe(user.keyId);
    expect(await storedKeyId(created.eu)).toBe(user.keyId);
    const jobs = await admin`
      select connection_id from jobs where kind = 'connection.backfill'
      order by connection_id`;
    expect(jobs.map((row) => row.connection_id).sort()).toEqual(
      [created.us, created.eu].sort(),
    );

    // The used pending key cannot create more.
    const again = await call(owner, w1, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
      connections: [{ name: "Again", config: accountConfig(US) }],
    });
    expect(again.statusCode).toBe(400);
  });

  it("shows on each connection page which other connections share its key", async () => {
    const response = await call(owner, w1, "GET", `/connections/${created.eu}`);
    expect(response.statusCode).toBe(200);
    const { connection } = connectionDetailResponseSchema.parse(
      response.json(),
    );
    expect(connection.config).toEqual(accountConfig(EU));
    expect(connection.signedKey?.sharedWith).toEqual([
      { id: created.us, name: "Apple Ads · US" },
    ]);
  });

  it("refuses a new key that does not work for a connection sharing the old one, and changes nothing", async () => {
    // The new API user cannot read the EU ad account.
    const { pair, user } = await generate({ [US.id]: ACL[US.id]! });
    const before = await storedKeyId(created.us);
    const response = await call(
      owner,
      w1,
      "PATCH",
      `/connections/${created.us}`,
      { credentials: idsOf(user), pendingKeyId: pair.pendingKeyId },
    );
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toContain(
      "“Apple Ads · EU”",
    );
    expect(await storedKeyId(created.us)).toBe(before);
    expect(await storedKeyId(created.eu)).toBe(before);
    expect(await pendingCount(pair.pendingKeyId)).toBe(1);
  });

  it("replaces the key in every connection that shares it, and recovers auth_failed", async () => {
    await admin`
      update connection_state set auth_state = 'auth_failed'
      where connection_id = ${created.eu}`;
    const { pair, user } = await generate();
    const response = await call(
      owner,
      w1,
      "PATCH",
      `/connections/${created.us}`,
      { credentials: idsOf(user), pendingKeyId: pair.pendingKeyId },
    );
    expect(response.statusCode).toBe(200);
    const { connection } = connectionResponseSchema.parse(response.json());
    expect(
      connection.signedKey?.fields.find((f) => f.key === "keyId")?.value,
    ).toBe(user.keyId);
    expect(connection.signedKey?.sharedWith).toEqual([
      { id: created.eu, name: "Apple Ads · EU" },
    ]);
    expect(await storedKeyId(created.us)).toBe(user.keyId);
    expect(await storedKeyId(created.eu)).toBe(user.keyId);
    const [state] = await admin`
      select auth_state from connection_state where connection_id = ${created.eu}`;
    expect(state).toEqual({ auth_state: "ok" });
    const audit = await admin`
      select target, metadata from audit_events
      where action = 'connection.credentials_updated' order by created_at`;
    expect(audit.map((row) => row.target)).toEqual([created.us, created.eu]);
    expect(audit[1]!.metadata).toMatchObject({ sharedKeyOf: created.us });
  });

  it("keeps another workspace out: no batch with its pending key, none into its workspace", async () => {
    const { pair, user } = await generate();
    const foreignKey = await call(other, w2, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
      connections: [{ name: "Stolen", config: accountConfig(US) }],
    });
    expect(foreignKey.statusCode).toBe(400);
    const foreignWorkspace = await call(
      other,
      w1,
      "POST",
      "/connections/batch",
      {
        connectorId: "apple-ads",
        credentials: idsOf(user),
        pendingKeyId: pair.pendingKeyId,
        connections: [{ name: "Stolen", config: accountConfig(US) }],
      },
    );
    expect([403, 404]).toContain(foreignWorkspace.statusCode);
    const [count] = await admin`
      select count(*)::int as count from connections where workspace_id = ${w2}`;
    expect(count).toEqual({ count: 0 });
    expect(await pendingCount(pair.pendingKeyId)).toBe(1);

    // A connection in W2 with its own key never lists W1's as sharing it.
    const own = await generate(ACL, other, w2);
    const createdInW2 = await call(other, w2, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(own.user),
      pendingKeyId: own.pair.pendingKeyId,
      connections: [{ name: "W2 US", config: accountConfig(US) }],
    });
    expect(createdInW2.statusCode).toBe(200);
    const [w2Connection] = connectionsResponseSchema.parse(
      createdInW2.json(),
    ).connections;
    expect(w2Connection!.signedKey?.sharedWith).toEqual([]);
    const detail = await call(
      other,
      w2,
      "GET",
      `/connections/${w2Connection!.id}`,
    );
    expect(
      connectionDetailResponseSchema.parse(detail.json()).connection.signedKey
        ?.sharedWith,
    ).toEqual([]);
    // W1's connections are not readable from W2.
    const foreign = await call(other, w2, "GET", `/connections/${created.us}`);
    expect(foreign.statusCode).toBe(404);
  });

  it("puts no private key, client secret or access token in responses or logs", async () => {
    const text = [...bodies, ...logs].join("\n");
    expect(privateKeys.length).toBeGreaterThan(0);
    for (const key of privateKeys) {
      expect(text).not.toContain(pemBody(key).slice(20, 60));
    }
    expect(apple.clientSecrets.length).toBeGreaterThan(0);
    for (const secret of [...apple.clientSecrets, ...apple.issued]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("PRIVATE KEY");
  });
});
