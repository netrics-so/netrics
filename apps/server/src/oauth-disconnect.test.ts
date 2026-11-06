import { randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  deleteConnectionResponseSchema,
  errorResponseSchema,
  workspaceListResponseSchema,
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
  capturingLogger,
  seedOAuthConnection,
  startTestOAuthProvider,
  TEST_CLIENT_SECRET,
  TEST_PROVIDER_EGRESS,
  TEST_PROVIDER_ID,
  testOAuthProviders,
  type TestOAuthProvider,
} from "./oauth/test-provider.js";
import { createOAuthTokenService } from "./oauth/tokens.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";

// ADR 0012 disconnect, #133: deleting the last connection that uses an
// account's grant revokes it at the provider; deleting one while another
// connection (same or another workspace) uses the grant only deletes the
// stored tokens; concurrent disconnects of the last two revoke exactly
// once; a failed revocation still deletes and is reported.

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const KEYRING = createCredentialKeyring(ENCRYPTION_KEY);
const SCOPE = "https://example.test/auth/readonly";
const CONNECTOR_ID = "oauth-disconnect";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let provider: TestOAuthProvider;
let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceA: string;
let workspaceB: string;
const logs: string[] = [];
/** Every API response body of this file. */
const bodies: string[] = [];
let subCounter = 0;

function connector(): Connector {
  const manifest: ConnectorManifest = {
    ...demoManifest,
    id: CONNECTOR_ID,
    sdkVersion: "^0.2.1",
    authStrategies: [
      { strategy: "oauth2", provider: TEST_PROVIDER_ID, scopes: [SCOPE] },
    ],
  };
  return { ...createDemoConnector(), manifest };
}

async function oauthConnection(workspaceId: string, sub: string) {
  const refreshToken = provider.grant({ sub, scopes: [SCOPE] });
  return seedOAuthConnection(db, KEYRING, {
    workspaceId,
    connectorId: CONNECTOR_ID,
    refreshToken,
    sub,
    grantedScopes: [SCOPE],
  });
}

function nextSub(): string {
  subCounter += 1;
  return `disconnect-sub-${subCounter}`;
}

async function disconnect(
  workspaceId: string,
  connectionId: string,
): Promise<InjectResponse> {
  const response = await app.inject({
    method: "DELETE",
    url: `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    headers: { cookie },
  });
  bodies.push(response.body);
  return response;
}

async function exists(connectionId: string): Promise<boolean> {
  const [row] = await admin<{ count: number }[]>`
    select (select count(*)::int from connections where id = ${connectionId}::uuid)
      + (select count(*)::int from connection_oauth where connection_id = ${connectionId}::uuid)
      as count`;
  return row!.count > 0;
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
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  const providers = testOAuthProviders(provider);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry,
    checkDb: async () => true,
    oauthProviders: providers,
    oauthTokens: createOAuthTokenService({
      db,
      credentialKeyring: KEYRING,
      providers,
      logger: capturingLogger(logs),
      egress: TEST_PROVIDER_EGRESS,
    }),
  });

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: {
      name: "Owner",
      email: "disconnect-owner@example.com",
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
        payload: { workspaceName: "Disconnect A" },
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
  const user = await findUserByEmail(db, "disconnect-owner@example.com");
  workspaceB = await createWorkspace(db, {
    name: "Disconnect B",
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
  provider.nextRevokeFailures.length = 0;
});

describe("disconnecting an OAuth connection", () => {
  it("revokes the grant when it was the last connection for the account", async () => {
    const sub = nextSub();
    const connectionId = await oauthConnection(workspaceA, sub);
    const before = provider.revocations.length;
    const response = await disconnect(workspaceA, connectionId);
    expect(response.statusCode).toBe(200);
    expect(deleteConnectionResponseSchema.parse(response.json())).toEqual({
      revocation: {
        provider: TEST_PROVIDER_ID,
        status: "revoked",
        accountPermissionsUrl: provider.definition.accountPermissionsUrl,
      },
    });
    expect(provider.revocations.length - before).toBe(1);
    expect(provider.isRevoked(sub)).toBe(true);
    expect(await exists(connectionId)).toBe(false);
  });

  it("keeps the grant while a connection in the same workspace uses it", async () => {
    const sub = nextSub();
    const first = await oauthConnection(workspaceA, sub);
    const second = await oauthConnection(workspaceA, sub);
    const before = provider.revocations.length;
    const response = await disconnect(workspaceA, first);
    expect(response.json()).toMatchObject({ revocation: { status: "kept" } });
    expect(provider.revocations.length).toBe(before);
    expect(provider.isRevoked(sub)).toBe(false);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(true);
  });

  it("keeps the grant while a connection in another workspace uses it, then revokes with the last", async () => {
    const sub = nextSub();
    const mine = await oauthConnection(workspaceA, sub);
    const theirs = await oauthConnection(workspaceB, sub);
    const before = provider.revocations.length;
    expect((await disconnect(workspaceA, mine)).json()).toMatchObject({
      revocation: { status: "kept" },
    });
    expect(provider.revocations.length).toBe(before);
    expect((await disconnect(workspaceB, theirs)).json()).toMatchObject({
      revocation: { status: "revoked" },
    });
    expect(provider.revocations.length - before).toBe(1);
    expect(provider.isRevoked(sub)).toBe(true);
  });

  it("revokes exactly once when the last two connections are disconnected concurrently (5 rounds)", async () => {
    for (let round = 0; round < 5; round += 1) {
      const sub = nextSub();
      const first = await oauthConnection(workspaceA, sub);
      const second = await oauthConnection(workspaceB, sub);
      const before = provider.revocations.length;
      const responses = await Promise.all([
        disconnect(workspaceA, first),
        disconnect(workspaceB, second),
      ]);
      const statuses = responses
        .map((response) =>
          deleteConnectionResponseSchema.parse(response.json()),
        )
        .map((body) => body.revocation?.status)
        .sort();
      expect(statuses).toEqual(["kept", "revoked"]);
      expect(provider.revocations.length - before).toBe(1);
      expect(provider.isRevoked(sub)).toBe(true);
      expect(await exists(first)).toBe(false);
      expect(await exists(second)).toBe(false);
    }
  });

  it("still deletes when the revocation fails, and reports it", async () => {
    const sub = nextSub();
    const connectionId = await oauthConnection(workspaceA, sub);
    provider.nextRevokeFailures.push(503);
    const response = await disconnect(workspaceA, connectionId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      revocation: {
        provider: TEST_PROVIDER_ID,
        status: "failed",
        accountPermissionsUrl: provider.definition.accountPermissionsUrl,
      },
    });
    expect(await exists(connectionId)).toBe(false);
    // The grant is still live at the provider; the user removes it there.
    expect(provider.isRevoked(sub)).toBe(false);
  });

  it("audits the disconnect without token material", async () => {
    const [row] = await admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events
      where action = 'connection.deleted' order by created_at desc limit 1`;
    expect(row!.metadata).toMatchObject({
      connectorId: CONNECTOR_ID,
      oauthProvider: TEST_PROVIDER_ID,
      oauthGrant: "released",
    });
  });
});

describe("credentials of OAuth connections", () => {
  it("cannot be replaced through PATCH (reauthorization only)", async () => {
    const connectionId = await oauthConnection(workspaceA, nextSub());
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceA}/connections/${connectionId}`,
      headers: { cookie },
      payload: { credentials: { token: "pasted-token" } },
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      "oauth_authorization_required",
    );
  });

  it("checks a config change with a fresh access token, never the refresh token", async () => {
    const connectionId = await oauthConnection(workspaceA, nextSub());
    const before = provider.refreshRequests;
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceA}/connections/${connectionId}`,
      headers: { cookie },
      payload: { config: {} },
    });
    expect(response.statusCode).toBe(200);
    bodies.push(response.body);
    expect(provider.refreshRequests - before).toBe(1);
  });

  it("never returns or logs token material", async () => {
    const secrets = [
      TEST_CLIENT_SECRET,
      ...provider.accessTokens,
      ...provider.revocations,
    ];
    const [audit] = await admin<{ text: string }[]>`
      select coalesce(string_agg(metadata::text, ' '), '') as text from audit_events`;
    expect(bodies.length).toBeGreaterThan(5);
    const haystack = [logs.join("\n"), audit!.text, ...bodies].join("\n");
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
    }
  });
});
