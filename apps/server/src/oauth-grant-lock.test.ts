import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  deleteConnectionResponseSchema,
  oauthCallbackResponseSchema,
  startOAuthAuthorizationResponseSchema,
  workspaceListResponseSchema,
  type OAuthCallbackResponse,
} from "@netrics/contracts";
import type { Connector, ConnectorManifest } from "@netrics/connector-sdk";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  findUserByEmail,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createDefaultRegistry } from "./connectors.js";
import { createCredentialKeyring } from "./credentials.js";
import { loadConfig } from "./env.js";
import {
  seedOAuthConnection,
  startTestOAuthProvider,
  TEST_PROVIDER_ID,
  testOAuthProviders,
  type TestOAuthProvider,
} from "./oauth/test-provider.js";
import { openOAuthCredentials } from "./oauth/tokens.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// ADR 0012, "Grant lock": the provider revokes per account (and project),
// so every check of "does another connection hold this account's grant"
// and the revocation or store that follows it run under one lock per
// provider account. Disconnects hold it across the revocation HTTP call;
// callbacks hold it from the liveness check of a fresh grant through its
// store and any revocation of a refused or released grant; account changes
// lock both accounts in a fixed order. Concurrency cases run 5 rounds.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const SCOPE = "https://example.test/auth/readonly";
const CONNECTOR_ID = "oauth-grant-lock";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let provider: TestOAuthProvider;
let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceA: string;
let workspaceB: string;
let subCounter = 0;
/** Credentials every connector check received. */
const checked: Array<Record<string, unknown>> = [];

function connector(): Connector {
  const demo = createDemoConnector();
  const manifest: ConnectorManifest = {
    ...demoManifest,
    id: CONNECTOR_ID,
    sdkVersion: "^0.2.1",
    authStrategies: [
      { strategy: "oauth2", provider: TEST_PROVIDER_ID, scopes: [SCOPE] },
    ],
  };
  return {
    ...demo,
    manifest,
    async check(context, runtime) {
      checked.push({ ...context.credentials });
      return demo.check(context, runtime);
    },
  };
}

function nextSub(label: string): string {
  subCounter += 1;
  return `lock-${label}-${subCounter}`;
}

function account(sub: string) {
  return { sub, email: `${sub}@example.com` };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("until: timed out");
    }
    await sleep(2);
  }
}

async function seeded(workspaceId: string, sub: string): Promise<string> {
  return seedOAuthConnection(db, KEYRING, {
    workspaceId,
    connectorId: CONNECTOR_ID,
    refreshToken: provider.grant({ sub, scopes: [SCOPE] }),
    sub,
    grantedScopes: [SCOPE],
  });
}

async function startUrl(
  workspaceId: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/oauth/authorizations`,
    headers: { cookie },
    payload: { connectorId: CONNECTOR_ID, ...body },
  });
  expect(response.statusCode, response.body).toBe(200);
  return startOAuthAuthorizationResponseSchema.parse(response.json())
    .authorizationUrl;
}

async function callback(
  query: Record<string, string | undefined>,
): Promise<OAuthCallbackResponse> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/oauth/${TEST_PROVIDER_ID}/callback`,
    headers: { cookie },
    payload: query,
  });
  expect(response.statusCode, response.body).toBe(200);
  return oauthCallbackResponseSchema.parse(response.json());
}

function disconnect(
  workspaceId: string,
  connectionId: string,
): Promise<InjectResponse> {
  return app.inject({
    method: "DELETE",
    url: `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    headers: { cookie },
  });
}

function revocationOf(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  return deleteConnectionResponseSchema.parse(response.json()).revocation
    ?.status;
}

/** Connections holding a grant of `sub`, with their sealed refresh token. */
async function holders(sub: string) {
  return admin<
    {
      connection_id: string;
      workspace_id: string;
      credentials_encrypted: Buffer;
    }[]
  >`
    select o.connection_id, o.workspace_id, c.credentials_encrypted
    from connection_oauth o join connections c on c.id = o.connection_id
    where o.provider = ${TEST_PROVIDER_ID} and o.account_sub = ${sub}`;
}

/** Every stored grant of `sub` works at the provider. */
async function storedGrantsLive(sub: string): Promise<boolean> {
  for (const row of await holders(sub)) {
    const refreshToken = openOAuthCredentials(
      row.credentials_encrypted,
      KEYRING,
      { workspaceId: row.workspace_id, connectionId: row.connection_id },
    );
    if (!provider.isActive(refreshToken)) {
      return false;
    }
  }
  return true;
}

async function linkedSub(connectionId: string): Promise<string | null> {
  const [row] = await admin<{ account_sub: string }[]>`
    select account_sub from connection_oauth
    where connection_id = ${connectionId}::uuid`;
  return row?.account_sub ?? null;
}

beforeAll(async () => {
  provider = await startTestOAuthProvider();
  const testDb = await createTestDatabase();
  const registry = createDefaultRegistry();
  registry.register(connector());
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry);
  await owner.$client.end({ timeout: 5 });

  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: ENCRYPTION_KEY,
  });
  db = createDatabase(testDb.appUrl);
  admin = createRawSqlClient(testDb.adminUrl, { max: 2 });
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry,
    checkDb: async () => true,
    oauthProviders: testOAuthProviders(provider),
    // One in-process provider for the flow and the token service.
    oauthHttp: () => provider.http,
  });

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "grant-lock-owner@example.com",
      password: "password-12345",
    },
  });
  expect(signUp.statusCode).toBe(200);
  const header = signUp.headers["set-cookie"];
  cookie = (Array.isArray(header) ? header : [header])
    .find((value) => value?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/v1/bootstrap",
        headers: { cookie },
        payload: { workspaceName: "Lock A" },
      })
    ).statusCode,
  ).toBe(200);
  workspaceA = workspaceListResponseSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { cookie },
      })
    ).json(),
  ).workspaces[0]!.id;
  const user = await findUserByEmail(db, "grant-lock-owner@example.com");
  workspaceB = await createWorkspace(db, {
    name: "Lock B",
    ownerUserId: user!.id,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  await provider?.close();
});

beforeEach(() => {
  provider.tokenDelayMs = 0;
  provider.revokeDelayMs = 0;
  provider.nextRevokeFailures.length = 0;
  provider.nextTokenErrors.length = 0;
});

describe("disconnect and callback of one account", () => {
  it("a callback arriving during the revocation waits, then refuses the revoked grant and stores nothing (5 rounds)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const sub = nextSub("revoking");
      const last = await seeded(workspaceA, sub);
      const query = provider.consent(await startUrl(workspaceA), {
        account: account(sub),
      });
      // The revocation is in flight (received, not yet applied) when the
      // callback exchanges its code: the provider will kill that grant too.
      provider.revokeDelayMs = 300;
      const revocations = provider.revocations.length;
      const deleting = disconnect(workspaceA, last);
      await until(() => provider.revocations.length > revocations);
      const result = await callback(query);

      expect(revocationOf(await deleting)).toBe("revoked");
      expect(result.outcome).toBe("failed");
      expect(await holders(sub)).toHaveLength(0);
      expect(provider.isRevoked(sub)).toBe(true);
      provider.revokeDelayMs = 0;
    }
  });

  it("a callback holding the lock first makes the disconnect keep the grant (5 rounds)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const sub = nextSub("storing");
      const last = await seeded(workspaceA, sub);
      const query = provider.consent(await startUrl(workspaceB), {
        account: account(sub),
      });
      // The callback's liveness refresh runs under the lock; the disconnect
      // starts while it is in flight.
      provider.tokenDelayMs = 100;
      const refreshes = provider.refreshRequests;
      const connecting = callback(query);
      await until(() => provider.refreshRequests > refreshes);
      const revocations = provider.revocations.length;
      const deleting = disconnect(workspaceA, last);

      expect((await connecting).outcome).toBe("connected");
      expect(revocationOf(await deleting)).toBe("kept");
      expect(provider.revocations.length).toBe(revocations);
      const stored = await holders(sub);
      expect(stored.map((row) => row.workspace_id)).toEqual([workspaceB]);
      expect(await storedGrantsLive(sub)).toBe(true);
      provider.tokenDelayMs = 0;
    }
  });

  it("never leaves a stored grant revoked, however a disconnect and a callback interleave (5 rounds)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const sub = nextSub("interleave");
      const last = await seeded(workspaceA, sub);
      const query = provider.consent(await startUrl(workspaceB), {
        account: account(sub),
      });
      provider.revokeDelayMs = 20 + round * 10;
      const [deleted, result] = await Promise.all([
        disconnect(workspaceA, last),
        sleep(round * 7).then(() => callback(query)),
      ]);
      const status = revocationOf(deleted);
      // The callback stored first (the disconnect kept the grant), or its
      // code was exchanged after the revocation (a new, live grant), or the
      // revocation killed its grant and it refused to store it.
      if (result.outcome === "connected") {
        expect(["kept", "revoked"]).toContain(status);
        expect(await holders(sub)).toHaveLength(1);
      } else {
        expect(result.outcome).toBe("failed");
        expect(status).toBe("revoked");
        expect(await holders(sub)).toHaveLength(0);
      }
      expect(await storedGrantsLive(sub)).toBe(true);
    }
  });
});

describe("account change on reauthorization", () => {
  async function reauthorize(
    workspaceId: string,
    connectionId: string,
    sub: string,
  ): Promise<OAuthCallbackResponse> {
    const url = await startUrl(workspaceId, {
      connectionId,
      allowAccountChange: true,
    });
    return callback(provider.consent(url, { account: account(sub) }));
  }

  it("revokes the previous account's grant when this connection held the last one", async () => {
    const previous = nextSub("previous");
    const next = nextSub("next");
    const connectionId = await seeded(workspaceA, previous);
    const revocations = provider.revocations.length;
    expect((await reauthorize(workspaceA, connectionId, next)).outcome).toBe(
      "reauthorized",
    );
    expect(await linkedSub(connectionId)).toBe(next);
    expect(provider.revocations.length - revocations).toBe(1);
    expect(provider.isRevoked(previous)).toBe(true);
    expect(provider.isRevoked(next)).toBe(false);
    expect(await storedGrantsLive(next)).toBe(true);
    const [audit] = await admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events
      where action = 'connection.oauth_account_changed' and target = ${connectionId}`;
    expect(audit!.metadata).toMatchObject({ previousGrant: "released" });
  });

  it("keeps the previous account's grant while another connection uses it", async () => {
    const previous = nextSub("previous");
    const next = nextSub("next");
    const connectionId = await seeded(workspaceA, previous);
    const other = await seeded(workspaceB, previous);
    const revocations = provider.revocations.length;
    expect((await reauthorize(workspaceA, connectionId, next)).outcome).toBe(
      "reauthorized",
    );
    expect(provider.revocations.length).toBe(revocations);
    expect(provider.isRevoked(previous)).toBe(false);
    expect((await holders(previous)).map((row) => row.connection_id)).toEqual([
      other,
    ]);
    expect(await storedGrantsLive(previous)).toBe(true);
  });

  it("with a concurrent disconnect of the previous account's other connection, revokes it exactly once (5 rounds)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const previous = nextSub("previous");
      const next = nextSub("next");
      const moving = await seeded(workspaceA, previous);
      const other = await seeded(workspaceB, previous);
      const url = await startUrl(workspaceA, {
        connectionId: moving,
        allowAccountChange: true,
      });
      const query = provider.consent(url, { account: account(next) });
      const revocations = provider.revocations.length;
      provider.tokenDelayMs = 10;
      const [result, deleted] = await Promise.all([
        callback(query),
        sleep(round * 5).then(() => disconnect(workspaceB, other)),
      ]);
      expect(result.outcome).toBe("reauthorized");
      expect(["kept", "revoked"]).toContain(revocationOf(deleted));
      expect(provider.revocations.length - revocations).toBe(1);
      expect(provider.isRevoked(previous)).toBe(true);
      expect(await holders(previous)).toHaveLength(0);
      expect(await linkedSub(moving)).toBe(next);
      expect(await storedGrantsLive(next)).toBe(true);
      provider.tokenDelayMs = 0;
    }
  });

  it("two connections swapping accounts concurrently do not deadlock, and no stored grant is dead (5 rounds)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const a = nextSub("swap-a");
      const b = nextSub("swap-b");
      const first = await seeded(workspaceA, a);
      const second = await seeded(workspaceA, b);
      const queries = [
        provider.consent(
          await startUrl(workspaceA, {
            connectionId: first,
            allowAccountChange: true,
          }),
          { account: account(b) },
        ),
        provider.consent(
          await startUrl(workspaceA, {
            connectionId: second,
            allowAccountChange: true,
          }),
          { account: account(a) },
        ),
      ];
      provider.tokenDelayMs = 20;
      const results = await Promise.race([
        Promise.all(queries.map((query) => callback(query))),
        sleep(15_000).then(() => {
          throw new Error("deadlock: callbacks did not finish");
        }),
      ]);
      provider.tokenDelayMs = 0;
      // Serialized: the first releases its last grant of one account (and
      // revokes it); the second then finds its new grant of that account
      // revoked and refuses it. Nothing dead is stored.
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "failed",
        "reauthorized",
      ]);
      expect(await storedGrantsLive(a)).toBe(true);
      expect(await storedGrantsLive(b)).toBe(true);
    }
  });
});

describe("config changes of an OAuth connection", () => {
  it("are checked by the connector with only { accessToken }, never the refresh token", async () => {
    const sub = nextSub("config");
    const connectionId = await seeded(workspaceA, sub);
    checked.length = 0;
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceA}/connections/${connectionId}`,
      headers: { cookie },
      payload: { config: { seed: 7 } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(checked).toHaveLength(1);
    expect(Object.keys(checked[0]!)).toEqual(["accessToken"]);
    expect(checked[0]!.accessToken).toBe(provider.accessTokens.at(-1));
    const [row] = await holders(sub);
    const refreshToken = openOAuthCredentials(
      row!.credentials_encrypted,
      KEYRING,
      { workspaceId: workspaceA, connectionId },
    );
    expect(JSON.stringify(checked)).not.toContain(refreshToken);
  });
});
