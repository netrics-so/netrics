import {
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 20_000 });

import {
  connectionResponseSchema,
  connectorListResponseSchema,
  errorResponseSchema,
  signedKeyPairResponseSchema,
  workspaceListResponseSchema,
  type SignedKeyPairResponse,
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
import {
  createCredentialKeyring,
  decryptCredentials,
  decryptPendingSignedKey,
} from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { capturingLogger } from "./oauth/test-provider.js";
import { PENDING_KEY_UNUSABLE } from "./signed-keys/pending-keys.js";
import { appStoreConnectProvider } from "./signed-keys/providers/index.js";
import { SignedKeyProviders } from "./signed-keys/registry.js";
import { pemBody } from "./signed-keys/test-keys.js";
import {
  createFakeTokenExchange,
  createFixtureConnector,
  FIXTURE_CONNECTOR_ID,
  FIXTURE_PROVIDER_ID,
  fixtureClient,
  fixtureExchangeProvider,
  type FixtureClient,
} from "./signed-keys/test-token-exchange.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";

// #371 (ADR 0020 §3) through the API, with the fixture exchange provider of
// #369 (no Apple Ads code): netrics generates the key pair, the user gets
// the public key only, and a connection created (or a key replaced) with
// the pending key's id signs with the generated key. Another workspace,
// another user, an expired or a used pending key is refused; the private
// key is in no response, log line or job payload; a pasted SEC1 key is
// stored as PKCS#8.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const fake = createFakeTokenExchange([]);

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(createFixtureConnector(fake, { pages: 1 }));
  return registry;
}

const signedKeys = new SignedKeyProviders({
  definitions: new Map([
    [FIXTURE_PROVIDER_ID, fixtureExchangeProvider],
    [appStoreConnectProvider.id, appStoreConnectProvider],
  ]),
  http: () => (url, init) => fake.fetch(url, init),
});

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string; // A: owner of W1
let editor: string; // B: editor in W1
let viewer: string; // V: viewer in W1
let other: string; // C: owner of W2
let w1: string;
let w2: string;
const logs: string[] = [];
const bodies: string[] = [];
/** Every generated private key, read from the database for the assertions. */
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

  owner = await signUp("pairs-owner@example.com");
  editor = await signUp("pairs-editor@example.com");
  viewer = await signUp("pairs-viewer@example.com");
  other = await signUp("pairs-other@example.com");
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
  for (const [email, role] of [
    ["pairs-editor@example.com", "editor"],
    ["pairs-viewer@example.com", "viewer"],
  ] as const) {
    const added = await addMemberViaInvitation(app, db, owner, w1, email, role);
    expect(added.statusCode).toBe(200);
  }
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
  method: "GET" | "POST" | "PATCH",
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
 * Generates a pair as `cookie` in `workspaceId` and registers its public
 * key with the fake provider under fresh IDs, as the user would paste it.
 */
async function generate(
  cookie = owner,
  workspaceId = w1,
): Promise<{ pair: SignedKeyPairResponse; client: FixtureClient }> {
  const response = await call(
    cookie,
    workspaceId,
    "POST",
    `/signed-keys/${FIXTURE_PROVIDER_ID}/key-pairs`,
  );
  expect(response.statusCode).toBe(200);
  const pair = signedKeyPairResponseSchema.parse(response.json());
  const client = fixtureClient({
    privateKeyPem: "",
    publicKey: createPublicKey(pair.publicKey),
  });
  fake.clients.push(client);
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
  return { pair, client };
}

/** The non-secret fields of a fixture client: no private key. */
function idsOf(client: FixtureClient) {
  return {
    clientId: client.clientId,
    teamId: client.teamId,
    keyId: client.keyId,
  };
}

async function pendingRows(id: string) {
  return admin`select id from signed_key_pending_keys where id = ${id}`;
}

async function storedCredentials(connectionId: string) {
  const [row] = await admin`
    select workspace_id, credentials_encrypted from connections
    where id = ${connectionId}`;
  return JSON.parse(
    decryptCredentials(
      (row!.credentials_encrypted as Buffer).toString("utf8"),
      KEYRING,
      { workspaceId: row!.workspace_id as string, connectionId },
    ),
  ) as Record<string, string>;
}

async function runSync(workspaceId: string, connectionId: string) {
  const handlers = createJobHandlers({
    registry: registry(),
    credentialKeyring: KEYRING,
    signedKeys,
  });
  return handlers["connection.sync"]!({
    job: {
      id: randomUUID(),
      kind: "connection.sync",
      workspaceId,
      connectionId,
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

function expectUnusable(response: { statusCode: number; json(): unknown }) {
  expect(response.statusCode).toBe(400);
  expect(errorResponseSchema.parse(response.json()).error).toBe(
    PENDING_KEY_UNUSABLE,
  );
}

describe("key pairs generated by netrics", () => {
  it("tells the wizard which providers netrics generates key pairs for", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/connectors",
      headers: { cookie: owner },
    });
    const fixture = connectorListResponseSchema
      .parse(response.json())
      .connectors.find((entry) => entry.id === FIXTURE_CONNECTOR_ID)!;
    expect(fixture.authStrategies[0]).toMatchObject({
      strategy: "signed-key",
      generatedKeyPair: true,
    });
  });

  it("generates a P-256 pair: the public key and an id in the answer, the private key sealed to its row", async () => {
    const before = Date.now();
    const { pair } = await generate();
    expect(pair.publicKey).toMatch(
      /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/,
    );
    const publicKey = createPublicKey(pair.publicKey);
    expect(publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const expires = Date.parse(pair.expiresAt) - before;
    expect(expires).toBeGreaterThan(24 * 3600_000 - 60_000);
    expect(expires).toBeLessThanOrEqual(24 * 3600_000 + 60_000);
    const [row] = await admin`
      select workspace_id, provider, private_key_encrypted::text as stored
      from signed_key_pending_keys where id = ${pair.pendingKeyId}`;
    expect(row).toMatchObject({
      workspace_id: w1,
      provider: FIXTURE_PROVIDER_ID,
    });
    expect(String(row!.stored)).not.toContain(
      pemBody(privateKeys.at(-1)!).slice(0, 24),
    );
    // The stored private key belongs to the public key handed out.
    expect(
      createPublicKey(privateKeys.at(-1)!).export({
        format: "pem",
        type: "spki",
      }),
    ).toBe(pair.publicKey);
  });

  it("refuses a provider that gives out its own keys, and an unknown provider", async () => {
    const appStore = await call(
      owner,
      w1,
      "POST",
      `/signed-keys/${appStoreConnectProvider.id}/key-pairs`,
    );
    expect(appStore.statusCode).toBe(400);
    const unknown = await call(
      owner,
      w1,
      "POST",
      "/signed-keys/nope/key-pairs",
    );
    expect(unknown.statusCode).toBe(404);
    const malformed = await call(
      owner,
      w1,
      "POST",
      "/signed-keys/NO_PE/key-pairs",
    );
    expect(malformed.statusCode).toBe(404);
  });

  it("lets editors generate, not viewers or non-members", async () => {
    await generate(editor);
    const byViewer = await call(
      viewer,
      w1,
      "POST",
      `/signed-keys/${FIXTURE_PROVIDER_ID}/key-pairs`,
    );
    expect(byViewer.statusCode).toBe(403);
    const byOutsider = await call(
      other,
      w1,
      "POST",
      `/signed-keys/${FIXTURE_PROVIDER_ID}/key-pairs`,
    );
    expect(byOutsider.statusCode).toBe(404);
    expect(errorResponseSchema.parse(byOutsider.json()).error).toBe(
      "workspace_not_found",
    );
  });

  it("previews with the pending key and keeps it", async () => {
    const { pair, client } = await generate();
    const response = await call(owner, w1, "POST", "/connections/preview", {
      connectorId: FIXTURE_CONNECTOR_ID,
      config: {},
      credentials: idsOf(client),
      pendingKeyId: pair.pendingKeyId,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ check: { ok: true } });
    expect(await pendingRows(pair.pendingKeyId)).toHaveLength(1);
  });

  it("creates a connection that signs with the generated key, and the pending key is gone", async () => {
    const { pair, client } = await generate();
    const response = await call(owner, w1, "POST", "/connections", {
      connectorId: FIXTURE_CONNECTOR_ID,
      name: "Generated",
      config: {},
      credentials: idsOf(client),
      pendingKeyId: pair.pendingKeyId,
    });
    expect(response.statusCode).toBe(200);
    const connection = connectionResponseSchema.parse(
      response.json(),
    ).connection;
    expect(await pendingRows(pair.pendingKeyId)).toHaveLength(0);
    expect((await storedCredentials(connection.id)).privateKey).toBe(
      privateKeys.at(-1),
    );

    // The sync's exchange is signed with the generated key (the fake
    // provider verifies the client secret with the pasted public key).
    const before = fake.exchanges;
    await runSync(w1, connection.id);
    expect(fake.exchanges).toBe(before + 1);
    const [state] = await admin`
      select auth_state from connection_state where connection_id = ${connection.id}`;
    expect(state).toMatchObject({ auth_state: "ok" });

    // Used once: the same id is refused afterwards.
    expectUnusable(
      await call(owner, w1, "POST", "/connections", {
        connectorId: FIXTURE_CONNECTOR_ID,
        name: "Again",
        config: {},
        credentials: idsOf(client),
        pendingKeyId: pair.pendingKeyId,
      }),
    );
  });

  it("replaces a connection's key with a generated pair", async () => {
    const first = await generate();
    const created = await call(owner, w1, "POST", "/connections", {
      connectorId: FIXTURE_CONNECTOR_ID,
      name: "Rotated",
      config: {},
      credentials: idsOf(first.client),
      pendingKeyId: first.pair.pendingKeyId,
    });
    const connectionId = connectionResponseSchema.parse(created.json())
      .connection.id;
    const next = await generate();
    const replaced = await call(
      owner,
      w1,
      "PATCH",
      `/connections/${connectionId}`,
      {
        credentials: idsOf(next.client),
        pendingKeyId: next.pair.pendingKeyId,
      },
    );
    expect(replaced.statusCode).toBe(200);
    expect(await pendingRows(next.pair.pendingKeyId)).toHaveLength(0);
    expect(await storedCredentials(connectionId)).toMatchObject({
      ...idsOf(next.client),
      privateKey: privateKeys.at(-1),
    });
  });

  it("lets only one of two concurrent creates use a pending key", async () => {
    const { pair, client } = await generate();
    const body = {
      connectorId: FIXTURE_CONNECTOR_ID,
      name: "Race",
      config: {},
      credentials: idsOf(client),
      pendingKeyId: pair.pendingKeyId,
    };
    const responses = await Promise.all([
      call(owner, w1, "POST", "/connections", body),
      call(owner, w1, "POST", "/connections", body),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    const [count] = await admin`
      select count(*)::int as count from connections where name = 'Race'`;
    expect(count).toEqual({ count: 1 });
  });

  it("refuses another workspace's pending key (cross-workspace)", async () => {
    const { pair, client } = await generate(owner, w1);
    for (const path of ["/connections/preview", "/connections"]) {
      expectUnusable(
        await call(other, w2, "POST", path, {
          connectorId: FIXTURE_CONNECTOR_ID,
          name: "Foreign",
          config: {},
          credentials: idsOf(client),
          pendingKeyId: pair.pendingKeyId,
        }),
      );
    }
    // W2's own pending key does not work in W1 either.
    const foreign = await generate(other, w2);
    expectUnusable(
      await call(owner, w1, "POST", "/connections/preview", {
        connectorId: FIXTURE_CONNECTOR_ID,
        config: {},
        credentials: idsOf(foreign.client),
        pendingKeyId: foreign.pair.pendingKeyId,
      }),
    );
    expect(await pendingRows(pair.pendingKeyId)).toHaveLength(1);
    expect(await pendingRows(foreign.pair.pendingKeyId)).toHaveLength(1);
  });

  it("refuses another user's pending key in the same workspace", async () => {
    const { pair, client } = await generate(owner);
    expectUnusable(
      await call(editor, w1, "POST", "/connections", {
        connectorId: FIXTURE_CONNECTOR_ID,
        name: "Not mine",
        config: {},
        credentials: idsOf(client),
        pendingKeyId: pair.pendingKeyId,
      }),
    );
    expect(await pendingRows(pair.pendingKeyId)).toHaveLength(1);
  });

  it("refuses an expired pending key, and the scheduler's prune deletes it", async () => {
    const { pair, client } = await generate();
    await admin`
      update signed_key_pending_keys set expires_at = now() - interval '1 second'
      where id = ${pair.pendingKeyId}`;
    expectUnusable(
      await call(owner, w1, "POST", "/connections/preview", {
        connectorId: FIXTURE_CONNECTOR_ID,
        config: {},
        credentials: idsOf(client),
        pendingKeyId: pair.pendingKeyId,
      }),
    );
    const [pruned] = await admin`
      select prune_signed_key_pending_keys(100) as deleted`;
    expect(pruned!.deleted).toBeGreaterThanOrEqual(1);
    expect(await pendingRows(pair.pendingKeyId)).toHaveLength(0);
    // Unexpired keys stay.
    expect(
      (
        await admin`select count(*)::int as count from signed_key_pending_keys`
      )[0]!.count,
    ).toBeGreaterThan(0);
  });

  it("refuses a pending key together with a private key, and on a connector without generated pairs", async () => {
    const { pair, client } = await generate();
    const both = await call(owner, w1, "POST", "/connections/preview", {
      connectorId: FIXTURE_CONNECTOR_ID,
      config: {},
      credentials: { ...idsOf(client), privateKey: privateKeys.at(-1) },
      pendingKeyId: pair.pendingKeyId,
    });
    expect(both.statusCode).toBe(400);
    expect(errorResponseSchema.parse(both.json()).error).toMatch(/not both/);
    const demo = await call(owner, w1, "POST", "/connections/preview", {
      connectorId: "demo",
      config: {},
      pendingKeyId: pair.pendingKeyId,
    });
    expect(demo.statusCode).toBe(400);
    expect(await pendingRows(pair.pendingKeyId)).toHaveLength(1);
  });

  it("stores a pasted SEC1 key (openssl ecparam) as PKCS#8", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const sec1 = privateKey.export({ format: "pem", type: "sec1" }) as string;
    const client = fixtureClient({ privateKeyPem: sec1, publicKey });
    fake.clients.push(client);
    const response = await call(owner, w1, "POST", "/connections", {
      connectorId: FIXTURE_CONNECTOR_ID,
      name: "Pasted SEC1",
      config: {},
      credentials: { ...idsOf(client), privateKey: sec1 },
    });
    expect(response.statusCode).toBe(200);
    const connection = connectionResponseSchema.parse(
      response.json(),
    ).connection;
    expect((await storedCredentials(connection.id)).privateKey).toBe(
      privateKey.export({ format: "pem", type: "pkcs8" }),
    );
  });

  it("puts no generated private key in any response, log line or job payload", async () => {
    const jobs =
      await admin`select payload::text as payload, last_error from jobs`;
    const audit =
      await admin`select metadata::text as metadata from audit_events`;
    const text = [
      ...bodies,
      ...logs,
      ...jobs.map((row) => `${row.payload} ${row.last_error ?? ""}`),
      ...audit.map((row) => String(row.metadata)),
    ].join("\n");
    expect(privateKeys.length).toBeGreaterThan(5);
    for (const pem of privateKeys) {
      const body = pemBody(pem);
      expect(text).not.toContain(body.slice(0, 32));
      expect(text).not.toContain(body.slice(-32));
    }
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(text).not.toContain("BEGIN EC PRIVATE KEY");
  });
});
