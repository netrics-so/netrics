import { createPublicKey, randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionDetailResponseSchema,
  connectionResponseSchema,
  connectionsResponseSchema,
  errorResponseSchema,
  sharedKeyResourcesResponseSchema,
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

// #395 through the API: an Apple Ads connection lends its stored key to
// new connections for other ad accounts of the same API user. The list is
// a preview with the stored key, marking what the workspace connected; the
// create is the batch path with that key, all or none, and the new
// connections then share the key (sharedWith, key replacement). Only a
// connection of the same workspace lends its key; the key never leaves
// the server.

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
const JP: FakeAdAccount = {
  ...US,
  id: "4100000004",
  name: "Example Apps JP",
  currency: "JPY",
  timezone: "Asia/Tokyo",
  campaigns: [{ id: "5400000001", name: "JP Brand", appId: "1000000001" }],
};
const ACL = {
  [US.id]: ["API Account Read Only"],
  [EU.id]: ["Limited Access: API Read Only"],
  [MAPS.id]: ["API Account Read Only"],
  [JP.id]: ["API Account Read Only"],
};

const apple = createFakeAppleAdsServer([US, EU, MAPS, JP], []);

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

  owner = await signUp("lend-owner@example.com");
  other = await signUp("lend-other@example.com");
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

async function connectionCount(workspaceId: string): Promise<number> {
  const [row] = await admin`
    select count(*)::int as count from connections
    where workspace_id = ${workspaceId}`;
  return (row as { count: number }).count;
}

const ids = { us: "", eu: "", jp: "", demo: "" };
let lender: FakeApiUserKey;

describe("Apple Ads: add another ad account with a connection's key (#395)", () => {
  it("starts from one connection made in the wizard", async () => {
    const { pair, user } = await generate();
    lender = user;
    const response = await call(owner, w1, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
      connections: [{ name: "Apple Ads · US", config: accountConfig(US) }],
    });
    expect(response.statusCode).toBe(200);
    ids.us = connectionsResponseSchema.parse(
      response.json(),
    ).connections[0]!.id;
  });

  it("lists the ad accounts the stored key reads, marking the connected one", async () => {
    const response = await call(
      owner,
      w1,
      "GET",
      `/connections/${ids.us}/shared-key/resources`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const listed = sharedKeyResourcesResponseSchema.parse(response.json());
    expect(listed.check.ok).toBe(true);
    expect(listed.resources.map((r) => [r.id, r.kind])).toEqual([
      [US.id, "ad_account"],
      [EU.id, "ad_account"],
      [MAPS.id, "ad_account"],
      [JP.id, "ad_account"],
    ]);
    expect(listed.resources[1]!.metadata).toMatchObject({
      selectable: true,
      currency: "EUR",
      timeZone: "Europe/Berlin",
    });
    expect(listed.connected).toEqual([
      {
        resourceId: US.id,
        connectionId: ids.us,
        connectionName: "Apple Ads · US",
      },
    ]);
  });

  it("creates nothing when one chosen ad account is refused", async () => {
    const response = await call(
      owner,
      w1,
      "POST",
      `/connections/${ids.us}/shared-key/connections`,
      {
        connections: [
          { name: "EU", config: accountConfig(EU) },
          { name: "Maps", config: accountConfig(MAPS) },
        ],
      },
    );
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toMatch(/^Maps: /);
    expect(await connectionCount(w1)).toBe(1);
  });

  it("refuses an ad account the workspace connected already", async () => {
    const response = await call(
      owner,
      w1,
      "POST",
      `/connections/${ids.us}/shared-key/connections`,
      {
        connections: [
          { name: "EU", config: accountConfig(EU) },
          { name: "US again", config: accountConfig(US) },
        ],
      },
    );
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      "US again: this account is connected already, as “Apple Ads · US”.",
    );
    expect(await connectionCount(w1)).toBe(1);
  });

  it("creates the chosen ad accounts with the same stored key, in one request", async () => {
    const response = await call(
      owner,
      w1,
      "POST",
      `/connections/${ids.us}/shared-key/connections`,
      {
        connections: [
          { name: "Apple Ads · EU", config: accountConfig(EU) },
          { name: "Apple Ads · JP", config: accountConfig(JP) },
        ],
      },
    );
    expect(response.statusCode).toBe(200);
    const { connections } = connectionsResponseSchema.parse(response.json());
    expect(connections.map((c) => c.config)).toEqual([
      accountConfig(EU),
      accountConfig(JP),
    ]);
    ids.eu = connections[0]!.id;
    ids.jp = connections[1]!.id;
    expect(connections[0]!.signedKey?.sharedWith).toEqual(
      expect.arrayContaining([
        { id: ids.us, name: "Apple Ads · US" },
        { id: ids.jp, name: "Apple Ads · JP" },
      ]),
    );
    expect(connections[0]!.signedKey?.sharedWith).toHaveLength(2);
    expect(await storedKeyId(ids.eu)).toBe(lender.keyId);
    expect(await storedKeyId(ids.jp)).toBe(lender.keyId);
    const jobs = await admin`
      select connection_id from jobs where kind = 'connection.backfill'
      and connection_id in (${ids.eu}, ${ids.jp})`;
    expect(jobs).toHaveLength(2);

    // The lending connection now lists them as sharing its key.
    const detail = await call(owner, w1, "GET", `/connections/${ids.us}`);
    const { connection } = connectionDetailResponseSchema.parse(detail.json());
    expect(
      connection.signedKey?.sharedWith?.map((other) => other.id).sort(),
    ).toEqual([ids.eu, ids.jp].sort());

    // And the list marks all three as connected.
    const listed = sharedKeyResourcesResponseSchema.parse(
      (
        await call(
          owner,
          w1,
          "GET",
          `/connections/${ids.eu}/shared-key/resources`,
        )
      ).json(),
    );
    expect(listed.connected.map((entry) => entry.resourceId)).toEqual([
      US.id,
      EU.id,
      JP.id,
    ]);
  });

  it("says in the audit trail that the key was shared, and from where", async () => {
    const created = await admin`
      select target, metadata from audit_events
      where action = 'connection.created' and target in (${ids.eu}, ${ids.jp})`;
    expect(created).toHaveLength(2);
    for (const row of created) {
      expect(row.metadata).toMatchObject({
        connectorId: "apple-ads",
        sharedCredential: true,
        keySharedFrom: ids.us,
      });
    }
    const [shared] = await admin`
      select target, metadata from audit_events
      where action = 'connection.key_shared'`;
    expect(shared).toMatchObject({ target: ids.us });
    expect(
      (shared!.metadata as { connectionIds: string[] }).connectionIds.sort(),
    ).toEqual([ids.eu, ids.jp].sort());
  });

  it("replaces the key in the new connections too", async () => {
    const { pair, user } = await generate();
    const response = await call(owner, w1, "PATCH", `/connections/${ids.us}`, {
      credentials: idsOf(user),
      pendingKeyId: pair.pendingKeyId,
    });
    expect(response.statusCode).toBe(200);
    connectionResponseSchema.parse(response.json());
    expect(await storedKeyId(ids.us)).toBe(user.keyId);
    expect(await storedKeyId(ids.eu)).toBe(user.keyId);
    expect(await storedKeyId(ids.jp)).toBe(user.keyId);
  });

  it("lends only a signed key of a connector that shares one", async () => {
    const demo = await call(owner, w1, "POST", "/connections", {
      connectorId: "demo",
      name: "Demo",
      config: {},
      credentials: { token: "demo-token-12345" },
    });
    expect(demo.statusCode).toBe(200);
    ids.demo = connectionResponseSchema.parse(demo.json()).connection.id;
    const listed = await call(
      owner,
      w1,
      "GET",
      `/connections/${ids.demo}/shared-key/resources`,
    );
    expect(listed.statusCode).toBe(400);
    expect(errorResponseSchema.parse(listed.json()).error).toBe(
      "shared_key_unsupported",
    );
    const created = await call(
      owner,
      w1,
      "POST",
      `/connections/${ids.demo}/shared-key/connections`,
      { connections: [{ name: "More demo", config: {} }] },
    );
    expect(created.statusCode).toBe(400);
  });

  it("keeps another workspace out: its connections lend nothing, and W1's lend nothing to it", async () => {
    const before = await connectionCount(w1);
    // W1's connection through W2's path: not found, as any foreign id.
    const list = await call(
      other,
      w2,
      "GET",
      `/connections/${ids.us}/shared-key/resources`,
    );
    expect(list.statusCode).toBe(404);
    expect(errorResponseSchema.parse(list.json()).error).toBe(
      "connection_not_found",
    );
    const create = await call(
      other,
      w2,
      "POST",
      `/connections/${ids.us}/shared-key/connections`,
      { connections: [{ name: "Stolen", config: accountConfig(MAPS) }] },
    );
    expect(create.statusCode).toBe(404);
    // W2's member on W1's path: not a member there.
    const direct = await call(
      other,
      w1,
      "POST",
      `/connections/${ids.us}/shared-key/connections`,
      { connections: [{ name: "Stolen", config: accountConfig(MAPS) }] },
    );
    expect([403, 404]).toContain(direct.statusCode);
    const directList = await call(
      other,
      w1,
      "GET",
      `/connections/${ids.us}/shared-key/resources`,
    );
    expect([403, 404]).toContain(directList.statusCode);
    expect(await connectionCount(w2)).toBe(0);
    expect(await connectionCount(w1)).toBe(before);

    // W2's own Apple Ads connection lists W2's connections only: W1 has
    // the US ad account connected, W2 has not.
    const own = await generate(ACL, other, w2);
    const createdInW2 = await call(other, w2, "POST", "/connections/batch", {
      connectorId: "apple-ads",
      credentials: idsOf(own.user),
      pendingKeyId: own.pair.pendingKeyId,
      connections: [{ name: "W2 EU", config: accountConfig(EU) }],
    });
    expect(createdInW2.statusCode).toBe(200);
    const w2Id = connectionsResponseSchema.parse(createdInW2.json())
      .connections[0]!.id;
    const listed = sharedKeyResourcesResponseSchema.parse(
      (
        await call(
          other,
          w2,
          "GET",
          `/connections/${w2Id}/shared-key/resources`,
        )
      ).json(),
    );
    expect(listed.connected).toEqual([
      { resourceId: EU.id, connectionId: w2Id, connectionName: "W2 EU" },
    ]);
  });

  it("answers 404 for an unknown connection", async () => {
    const unknown = await call(
      owner,
      w1,
      "GET",
      "/connections/00000000-0000-4000-8000-000000000000/shared-key/resources",
    );
    expect(unknown.statusCode).toBe(404);
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
