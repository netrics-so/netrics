import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabase,
  createWorkspace,
  findConnectionOAuth,
  schema,
  withWorkspace,
  type Database,
} from "@netrics/database";

import {
  createCredentialKeyring,
  decryptCredentials,
  decryptOAuthAccessToken,
} from "../credentials.js";
import { Secret } from "../secret.js";
import { createTestDatabase } from "../test-db.js";
import { OAuthProviders } from "./config.js";
import {
  capturingLogger,
  seedOAuthConnection,
  startTestOAuthProvider,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_PROVIDER_EGRESS,
  testOAuthProviders,
  type TestOAuthProvider,
} from "./test-provider.js";
import {
  createOAuthTokenService,
  OAuthTokenError,
  REFRESH_MARGIN_MS,
  type OAuthTokenService,
} from "./tokens.js";

// ADR 0012 token service, #133: cached tokens, refresh serialized per
// connection, rotation, invalid_grant and scope_missing, egress, and no
// token material in logs or errors.

const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
const SCOPE = "https://example.test/auth/readonly";
const OTHER_SCOPE = "https://example.test/auth/other";

let provider: TestOAuthProvider;
let db: Database;
let workspaceId: string;
let tokens: OAuthTokenService;
const logs: string[] = [];
let subCounter = 0;

function nextSub(): string {
  subCounter += 1;
  return `token-sub-${subCounter}`;
}

/** A connection whose cached token (if any) expires in `expiresInMs`. */
async function connection(
  options: {
    expiresInMs?: number;
    grantedScopes?: string[];
  } = {},
) {
  const sub = nextSub();
  const refreshToken = provider.grant({ sub, scopes: [SCOPE] });
  const accessToken =
    options.expiresInMs === undefined
      ? undefined
      : {
          value: `cached-at-${randomBytes(12).toString("base64url")}`,
          expiresAt: new Date(Date.now() + options.expiresInMs),
        };
  const connectionId = await seedOAuthConnection(db, KEYRING, {
    workspaceId,
    connectorId: "demo",
    refreshToken,
    sub,
    grantedScopes: options.grantedScopes ?? [SCOPE],
    ...(accessToken ? { accessToken } : {}),
  });
  return {
    sub,
    refreshToken,
    accessToken: accessToken?.value,
    binding: { workspaceId, connectionId },
  };
}

async function authState(connectionId: string) {
  return withWorkspace(db, { workspaceId }, async (tx) => {
    const [row] = await tx
      .select({
        authState: schema.connectionState.authState,
        authReason: schema.connectionState.authReason,
      })
      .from(schema.connectionState)
      .where(eq(schema.connectionState.connectionId, connectionId));
    return row;
  });
}

async function grantRow(connectionId: string) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    findConnectionOAuth(tx, workspaceId, connectionId),
  );
}

beforeAll(async () => {
  provider = await startTestOAuthProvider();
  const testDb = await createTestDatabase();
  db = createDatabase(testDb.appUrl, { max: 20 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "tokens@example.com", displayName: "Tokens" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(db, {
    name: "Tokens",
    ownerUserId: user!.id,
  });
  tokens = createOAuthTokenService({
    db,
    credentialKeyring: KEYRING,
    providers: testOAuthProviders(provider),
    logger: capturingLogger(logs),
    egress: TEST_PROVIDER_EGRESS,
  });
}, 60_000);

afterAll(async () => {
  await provider?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

beforeEach(() => {
  provider.tokenDelayMs = 0;
  provider.rotateRefreshTokens = false;
  provider.nextTokenErrors.length = 0;
});

describe("cached access tokens", () => {
  it("uses a token valid for at least 5 more minutes without refreshing", async () => {
    const { binding, accessToken } = await connection({
      expiresInMs: REFRESH_MARGIN_MS + 60_000,
    });
    const before = provider.refreshRequests;
    const result = await tokens.getAccessToken(binding, {
      requiredScopes: [SCOPE],
    });
    expect(result).toEqual({ ok: true, accessToken, refreshed: false });
    expect(provider.refreshRequests).toBe(before);
  });

  it("refreshes a token with less than 5 minutes left and stores it", async () => {
    const { binding, accessToken } = await connection({
      expiresInMs: REFRESH_MARGIN_MS - 1_000,
    });
    const result = await tokens.getAccessToken(binding, {
      requiredScopes: [SCOPE],
    });
    expect(result).toMatchObject({ ok: true, refreshed: true });
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.accessToken).not.toBe(accessToken);
    expect(provider.accessTokens).toContain(result.accessToken);
    const row = await grantRow(binding.connectionId);
    expect(
      decryptOAuthAccessToken(
        row!.accessTokenEncrypted!.toString("utf8"),
        KEYRING,
        binding,
      ),
    ).toBe(result.accessToken);
    expect(row!.accessTokenExpiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 3500 * 1000,
    );
    // The next call uses the stored token.
    const again = await tokens.getAccessToken(binding, {
      requiredScopes: [SCOPE],
    });
    expect(again).toEqual({
      ok: true,
      accessToken: result.accessToken,
      refreshed: false,
    });
  });
});

describe("serialized refresh", () => {
  it("refreshes exactly once for many parallel callers with an expired token (5 rounds)", async () => {
    provider.tokenDelayMs = 100;
    for (let round = 0; round < 5; round += 1) {
      const { binding } = await connection({ expiresInMs: -1_000 });
      const before = provider.refreshRequests;
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          tokens.getAccessToken(binding, { requiredScopes: [SCOPE] }),
        ),
      );
      expect(provider.refreshRequests - before).toBe(1);
      const issued = new Set(
        results.map((result) => (result.ok ? result.accessToken : null)),
      );
      expect(issued.size).toBe(1);
      expect([...issued][0]).toBe(provider.accessTokens.at(-1));
      expect(
        results.filter((result) => result.ok && result.refreshed),
      ).toHaveLength(1);
    }
  });

  it("stores a rotated refresh token and uses it next time", async () => {
    provider.rotateRefreshTokens = true;
    const { binding, refreshToken } = await connection({ expiresInMs: -1 });
    expect(
      await tokens.getAccessToken(binding, { requiredScopes: [SCOPE] }),
    ).toMatchObject({ ok: true, refreshed: true });
    const [stored] = await withWorkspace(db, { workspaceId }, (tx) =>
      tx
        .select({ credentials: schema.connections.credentialsEncrypted })
        .from(schema.connections)
        .where(eq(schema.connections.id, binding.connectionId)),
    );
    const rotated = JSON.parse(
      decryptCredentials(
        stored!.credentials!.toString("utf8"),
        KEYRING,
        binding,
      ),
    ) as { refreshToken: string };
    expect(rotated.refreshToken).not.toBe(refreshToken);
    // The old refresh token is dead at the provider; the stored one works.
    await tokens.invalidateAccessToken(binding, provider.accessTokens.at(-1)!);
    expect(
      await tokens.getAccessToken(binding, { requiredScopes: [SCOPE] }),
    ).toMatchObject({ ok: true, refreshed: true });
  });

  it("invalidates only the token that was rejected", async () => {
    const { binding, accessToken } = await connection({
      expiresInMs: 3600_000,
    });
    // A stale rejection (another caller already refreshed) changes nothing.
    await tokens.invalidateAccessToken(binding, "some-older-token");
    expect(
      await tokens.getAccessToken(binding, { requiredScopes: [SCOPE] }),
    ).toEqual({ ok: true, accessToken, refreshed: false });
    await tokens.invalidateAccessToken(binding, accessToken!);
    expect(
      await tokens.getAccessToken(binding, { requiredScopes: [SCOPE] }),
    ).toMatchObject({ ok: true, refreshed: true });
  });
});

describe("reauthorization states", () => {
  it("moves the connection to needs_reauthorization on invalid_grant", async () => {
    const { binding, sub } = await connection({ expiresInMs: -1 });
    provider.revokeAccount(sub);
    const result = await tokens.getAccessToken(binding, {
      requiredScopes: [SCOPE],
    });
    expect(result).toEqual({ ok: false, reason: "invalid_grant" });
    expect(await authState(binding.connectionId)).toEqual({
      authState: "needs_reauthorization",
      authReason: "invalid_grant",
    });
    const row = await grantRow(binding.connectionId);
    expect(row!.accessTokenEncrypted).toBeNull();
  });

  it("moves the connection to needs_reauthorization when the grant lacks a required scope", async () => {
    const { binding } = await connection({ expiresInMs: 3600_000 });
    const before = provider.refreshRequests;
    // A connector upgrade now needs OTHER_SCOPE too.
    const result = await tokens.getAccessToken(binding, {
      requiredScopes: [SCOPE, OTHER_SCOPE],
    });
    expect(result).toEqual({ ok: false, reason: "scope_missing" });
    expect(provider.refreshRequests).toBe(before);
    expect(await authState(binding.connectionId)).toEqual({
      authState: "needs_reauthorization",
      authReason: "scope_missing",
    });
  });

  it("detects scopes the provider no longer reports on refresh", async () => {
    const { binding, sub } = await connection({ expiresInMs: -1 });
    provider.setGrantedScopes(sub, ["openid"]);
    const result = await tokens.getAccessToken(binding, {
      requiredScopes: [SCOPE],
    });
    expect(result).toEqual({ ok: false, reason: "scope_missing" });
    expect((await grantRow(binding.connectionId))!.grantedScopes).toEqual([
      "openid",
    ]);
    expect(await authState(binding.connectionId)).toMatchObject({
      authReason: "scope_missing",
    });
  });
});

describe("refresh failures", () => {
  it("reports provider outages as transient without changing the state", async () => {
    const { binding } = await connection({ expiresInMs: -1 });
    provider.nextTokenErrors.push({
      status: 503,
      error: "temporarily_unavailable",
    });
    const error = await tokens
      .getAccessToken(binding, { requiredScopes: [SCOPE] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OAuthTokenError);
    expect(error).toMatchObject({
      kind: "transient",
      message:
        "oauth token refresh failed: provider answered 503 (temporarily_unavailable)",
    });
    expect(await authState(binding.connectionId)).toEqual({
      authState: "ok",
      authReason: null,
    });
  });

  it("reports a rejected client as a configuration error", async () => {
    const { binding } = await connection({ expiresInMs: -1 });
    const wrongSecret = createOAuthTokenService({
      db,
      credentialKeyring: KEYRING,
      providers: new OAuthProviders(
        [
          {
            definition: provider.definition,
            clientId: TEST_CLIENT_ID,
            clientSecret: new Secret("not-the-secret"),
            redirectUri: "http://localhost:3000/oauth/fixture/callback",
          },
        ],
        new Map([[provider.definition.id, provider.definition]]),
      ),
      egress: TEST_PROVIDER_EGRESS,
    });
    await expect(
      wrongSecret.getAccessToken(binding, { requiredScopes: [SCOPE] }),
    ).rejects.toMatchObject({ kind: "configuration" });
  });

  it("reaches token endpoints only on the provider's server domains", async () => {
    const { binding } = await connection({ expiresInMs: -1 });
    const before = provider.refreshRequests;
    const confined = createOAuthTokenService({
      db,
      credentialKeyring: KEYRING,
      providers: testOAuthProviders({
        ...provider,
        definition: {
          ...provider.definition,
          serverDomains: ["oauth2.googleapis.com"],
        },
      }),
      egress: TEST_PROVIDER_EGRESS,
    });
    await expect(
      confined.getAccessToken(binding, { requiredScopes: [SCOPE] }),
    ).rejects.toMatchObject({
      kind: "transient",
      message: "oauth token refresh failed: EgressDeniedError",
    });
    expect(provider.refreshRequests).toBe(before);
  });

  it("fails as configuration when the provider is not configured here", async () => {
    const { binding } = await connection({ expiresInMs: -1 });
    const unconfigured = createOAuthTokenService({
      db,
      credentialKeyring: KEYRING,
      providers: new OAuthProviders([]),
    });
    await expect(
      unconfigured.getAccessToken(binding, { requiredScopes: [SCOPE] }),
    ).rejects.toMatchObject({ kind: "configuration" });
  });
});

describe("revocation", () => {
  it("revokes the account's whole grant and reports failures without throwing", async () => {
    const sub = nextSub();
    const refreshToken = provider.grant({ sub, scopes: [SCOPE] });
    expect(await tokens.revokeGrant("fixture", refreshToken)).toBe(true);
    expect(provider.isRevoked(sub)).toBe(true);

    const other = provider.grant({ sub: nextSub(), scopes: [SCOPE] });
    provider.nextRevokeFailures.push(503);
    expect(await tokens.revokeGrant("fixture", other)).toBe(false);
    expect(await tokens.revokeGrant("unknown-provider", other)).toBe(false);
  });
});

describe("token material", () => {
  it("never appears in logs or errors", async () => {
    // Every token this provider issued or holds, plus the client secret.
    const secrets = [
      TEST_CLIENT_SECRET,
      ...provider.accessTokens,
      ...provider.revocations,
    ];
    expect(provider.accessTokens.length).toBeGreaterThan(5);
    expect(logs.length).toBeGreaterThan(0);
    const output = logs.join("\n");
    for (const secret of secrets) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/fixture-(rt|at)-/);
  });
});
