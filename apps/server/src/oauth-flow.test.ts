import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  connectionDetailResponseSchema,
  connectionResponseSchema,
  createWorkspaceResponseSchema,
  errorResponseSchema,
  oauthCallbackResponseSchema,
  startOAuthAuthorizationResponseSchema,
  workspaceListResponseSchema,
  type OAuthCallbackResponse,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { ConnectorManifest } from "@netrics/connector-sdk";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  findUserByEmail,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import {
  FixtureOAuthProvider,
  FIXTURE_ACCOUNT,
  type ConsentOptions,
  type FixtureAccount,
} from "./oauth/test-provider.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";

// The OAuth authorization flow (ADR 0012, #132) end to end in the API,
// against an in-process fixture provider: start, callback validation in the
// ADR's order, connect into the setup state, reauthorization, and that no
// code, state, verifier or token reaches responses, logs or audit events.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const CLIENT_ID = "netrics-test.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-flow-test-secret";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const OTHER_ACCOUNT: FixtureAccount = {
  sub: "fixture-sub-2",
  email: "second-account@example.com",
};

const googleOAuth = {
  strategy: "oauth2" as const,
  provider: "google",
  scopes: [SCOPE],
};

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  const manifest: ConnectorManifest = {
    ...demoManifest,
    id: "search-console-test",
    name: "Search Console (test)",
    sdkVersion: "^0.2.1",
    authStrategies: [googleOAuth],
  };
  registry.register({ ...createDemoConnector(), manifest });
  return registry;
}

const fixture = new FixtureOAuthProvider({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});
const logLines: string[] = [];
/** Every callback response body, for the leak check. */
const callbackBodies: string[] = [];
/** Every state handed out, for the leak check. */
const states: string[] = [];

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let workspaceId: string;
let secondWorkspaceId: string;
const cookies = {} as Record<"owner" | "editor" | "viewer", string>;
let editorUserId: string;

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

function post(
  url: string,
  cookie: string,
  payload: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({ method: "POST", url, headers: { cookie }, payload });
}

function start(
  cookie: string,
  body: Record<string, unknown>,
  workspace = workspaceId,
): Promise<InjectResponse> {
  return post(`/v1/workspaces/${workspace}/oauth/authorizations`, cookie, {
    connectorId: "search-console-test",
    ...body,
  });
}

async function startUrl(
  cookie: string,
  body: Record<string, unknown> = {},
  workspace = workspaceId,
): Promise<string> {
  const response = await start(cookie, body, workspace);
  expect(response.statusCode, response.body).toBe(200);
  const { authorizationUrl } = startOAuthAuthorizationResponseSchema.parse(
    response.json(),
  );
  states.push(new URL(authorizationUrl).searchParams.get("state")!);
  return authorizationUrl;
}

async function callback(
  cookie: string,
  query: Record<string, string | undefined>,
  provider = "google",
): Promise<OAuthCallbackResponse> {
  const response = await post(`/v1/oauth/${provider}/callback`, cookie, query);
  callbackBodies.push(response.body);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers["cache-control"]).toBe("no-store");
  const parsed = oauthCallbackResponseSchema.parse(response.json());
  expect(parsed.redirectTo).toMatch(/^\/(?!\/)/);
  return parsed;
}

/** Start, consent at the fixture, callback. */
async function flow(
  cookie: string,
  body: Record<string, unknown> = {},
  consent: ConsentOptions = {},
  workspace = workspaceId,
): Promise<OAuthCallbackResponse> {
  const url = await startUrl(cookie, body, workspace);
  return callback(cookie, fixture.consent(url, consent));
}

async function counts() {
  const [row] = await admin`
    select
      (select count(*)::int from connections) as connections,
      (select count(*)::int from connection_oauth) as grants`;
  return row as { connections: number; grants: number };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function connectionIdOf(result: OAuthCallbackResponse): string {
  const id = new URL(result.redirectTo, "http://app").searchParams.get(
    "connection",
  );
  expect(id).toBeTruthy();
  return id!;
}

async function getConnection(id: string, workspace = workspaceId) {
  const response = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspace}/connections/${id}`,
    headers: { cookie: cookies.owner },
  });
  expect(response.statusCode).toBe(200);
  return connectionDetailResponseSchema.parse(response.json()).connection;
}

async function credentialsOf(id: string): Promise<Buffer> {
  const [row] =
    await admin`select credentials_encrypted from connections where id = ${id}`;
  return row!.credentials_encrypted as Buffer;
}

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
    NETRICS_OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
    NETRICS_OAUTH_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  });
  db = createDatabase(testDb.appUrl);
  const logger = pino(
    { level: "debug" },
    { write: (line: string) => void logLines.push(line) },
  );
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry: registry(),
    checkDb: async () => true,
    oauthHttp: () => fixture.http,
    logger,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  cookies.owner = await signUp("flow-owner@example.com");
  expect(
    (await post("/v1/bootstrap", cookies.owner, { workspaceName: "Flow" }))
      .statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (
      await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { cookie: cookies.owner },
      })
    ).json(),
  ).workspaces[0]!.id;
  secondWorkspaceId = createWorkspaceResponseSchema.parse(
    (await post("/v1/workspaces", cookies.owner, { name: "Second" })).json(),
  ).workspace.id;

  for (const [key, role] of [
    ["editor", "editor"],
    ["viewer", "viewer"],
  ] as const) {
    const email = `flow-${key}@example.com`;
    cookies[key] = await signUp(email);
    const added = await addMemberViaInvitation(
      app,
      db,
      cookies.owner,
      workspaceId,
      email,
      role,
    );
    expect(added.statusCode).toBe(200);
  }
  editorUserId = (await findUserByEmail(db, "flow-editor@example.com"))!.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

describe("starting an authorization", () => {
  it("returns the provider URL and stores only hashes and sealed values", async () => {
    const url = new URL(await startUrl(cookies.owner));
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: "http://localhost:3000/oauth/google/callback",
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    expect(params.scope!.split(" ").sort()).toEqual(
      [
        "openid",
        "https://www.googleapis.com/auth/userinfo.email",
        SCOPE,
      ].sort(),
    );
    expect(params.state).toMatch(/^[\w-]{43}$/);
    expect(params.nonce).toMatch(/^[\w-]{43}$/);
    expect(JSON.stringify(params)).not.toContain(CLIENT_SECRET);

    const [row] = await admin`
      select * from oauth_authorizations where state_hash = ${hash(params.state!)}`;
    expect(row).toMatchObject({
      workspace_id: workspaceId,
      purpose: "connect",
      connection_id: null,
      allow_account_change: false,
      return_path: `/workspaces/${workspaceId}/connections/new`,
      nonce: params.nonce,
      consumed_at: null,
    });
    const ttl = (row!.expires_at as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(10 * 60 * 1000);
    const stored = JSON.stringify(row);
    expect(stored).not.toContain(params.state);
    expect(stored).not.toContain(params.code_challenge);
  });

  it("needs connections:create to connect", async () => {
    const response = await start(cookies.viewer, {});
    expect(response.statusCode).toBe(403);
    expect(await start(cookies.editor, {}).then((r) => r.statusCode)).toBe(200);
  });

  it("refuses connectors without OAuth, unknown connectors and bad options", async () => {
    for (const [body, error] of [
      [{ connectorId: "demo" }, "oauth_not_supported"],
      [{ connectorId: "nope" }, "invalid_request"],
      [{ allowAccountChange: true }, "invalid_request"],
    ] as const) {
      const response = await start(cookies.owner, body);
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error).toBe(error);
    }
  });

  it("refuses return paths outside the allowlist (no open redirect)", async () => {
    const [before] =
      await admin`select count(*)::int as count from oauth_authorizations`;
    for (const returnPath of [
      "//evil.example",
      "https://evil.example/",
      "/\\evil.example",
      "/%2F%2Fevil.example",
      "/login",
      "/",
      `/workspaces/${secondWorkspaceId}`,
      `/workspaces/${workspaceId}/../../evil`,
      `/workspaces/${workspaceId}/connections/new?next=//evil.example`,
      `/workspaces/${workspaceId}#//evil.example`,
      `/workspaces/${workspaceId.toUpperCase()}`,
      "javascript:alert(1)",
    ]) {
      const response = await start(cookies.owner, { returnPath });
      expect(response.statusCode, returnPath).toBe(400);
    }
    const [after] =
      await admin`select count(*)::int as count from oauth_authorizations`;
    expect(after!.count).toBe(before!.count);

    const result = await flow(
      cookies.owner,
      { returnPath: `/workspaces/${workspaceId}` },
      { deny: true },
    );
    expect(result.redirectTo).toBe(`/workspaces/${workspaceId}?oauth=denied`);
  });
});

describe("connecting", () => {
  it("creates the connection in the setup state with the grant", async () => {
    const callsBefore = fixture.calls.authorization_code;
    const result = await flow(cookies.editor);
    expect(result.outcome).toBe("connected");
    expect(fixture.calls.authorization_code).toBe(callsBefore + 1);
    const id = connectionIdOf(result);
    expect(result.redirectTo).toBe(
      `/workspaces/${workspaceId}/connections/new?oauth=connected&connection=${id}`,
    );

    const connection = await getConnection(id);
    expect(connection).toMatchObject({
      connectorId: "search-console-test",
      name: "Search Console (test)",
      setupPending: true,
      hasCredentials: true,
      oauth: {
        provider: "google",
        accountEmail: FIXTURE_ACCOUNT.email,
      },
      config: {},
    });
    expect(connection.oauth!.grantedScopes).toContain(SCOPE);

    // Not scheduled and nothing queued until setup is finished.
    const [state] =
      await admin`select next_due_at from connection_state where connection_id = ${id}`;
    expect(state!.next_due_at).toBeNull();
    const jobs = await admin`select id from jobs where connection_id = ${id}`;
    expect(jobs).toHaveLength(0);
    const sync = await post(
      `/v1/workspaces/${workspaceId}/connections/${id}/sync`,
      cookies.owner,
      {},
    );
    expect(sync.statusCode).toBe(400);
    expect(sync.json()).toEqual({ error: "connection_setup_pending" });

    const [grant] = await admin`
      select account_sub, access_token_encrypted, access_token_expires_at
      from connection_oauth where connection_id = ${id}`;
    expect(grant!.account_sub).toBe(FIXTURE_ACCOUNT.sub);
    expect(grant!.access_token_expires_at).not.toBeNull();

    const audit = await admin`
      select action, metadata::text as metadata from audit_events
      where target = ${id} order by created_at`;
    expect(audit.map((row) => row.action)).toEqual([
      "connection.created",
      "connection.oauth_connected",
    ]);
  });

  it("refuses credential changes; a checked config change finishes setup", async () => {
    const id = connectionIdOf(await flow(cookies.owner));
    const patch = (payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/v1/workspaces/${workspaceId}/connections/${id}`,
        headers: { cookie: cookies.owner },
        payload,
      });
    const before = await credentialsOf(id);
    const credentials = await patch({ credentials: { token: "pasted" } });
    expect(credentials.statusCode).toBe(400);
    expect(credentials.json()).toEqual({
      error: "oauth_authorization_required",
    });
    expect((await credentialsOf(id)).equals(before)).toBe(true);

    // The token service supplies the connector check (#133); the first
    // checked config finishes setup (#136, see oauth-setup.test.ts).
    const config = await patch({ config: { seed: 2 } });
    expect(config.statusCode, config.body).toBe(200);
    expect(
      connectionResponseSchema.parse(config.json()).connection.setupPending,
    ).toBe(false);
    const [row] = await admin`
      select c.config, c.setup_pending, s.next_due_at
      from connections c join connection_state s on s.connection_id = c.id
      where c.id = ${id}`;
    expect(row).toMatchObject({ config: { seed: 2 }, setup_pending: false });
    expect(row!.next_due_at).not.toBeNull();
    expect((await credentialsOf(id)).equals(before)).toBe(true);

    const renamed = await patch({ name: "My property" });
    expect(renamed.statusCode).toBe(200);
    expect(connectionResponseSchema.parse(renamed.json()).connection.name).toBe(
      "My property",
    );
  });
});

describe("callback validation", () => {
  let before: { connections: number; grants: number };
  beforeEach(async () => {
    before = await counts();
  });
  const nothingStored = async () => expect(await counts()).toEqual(before);

  it("ends a denied consent with nothing stored and no token call", async () => {
    const calls = fixture.calls.authorization_code;
    const result = await flow(cookies.owner, {}, { deny: true });
    expect(result).toEqual({
      outcome: "denied",
      redirectTo: `/workspaces/${workspaceId}/connections/new?oauth=denied`,
    });
    expect(fixture.calls.authorization_code).toBe(calls);
    await nothingStored();
  });

  it("refuses unknown and missing states", async () => {
    for (const query of [{ state: "made-up", code: "c" }, { code: "c" }]) {
      expect(await callback(cookies.owner, query)).toEqual({
        outcome: "invalid_state",
        redirectTo: "/?oauth=invalid_state",
      });
    }
    await nothingStored();
  });

  it("refuses a replayed state", async () => {
    const url = await startUrl(cookies.owner);
    const query = fixture.consent(url);
    expect((await callback(cookies.owner, query)).outcome).toBe("connected");
    const afterFirst = await counts();
    const replay = await callback(cookies.owner, query);
    expect(replay.outcome).toBe("invalid_state");
    expect(await counts()).toEqual(afterFirst);
  });

  it("refuses an expired state", async () => {
    const url = await startUrl(cookies.owner);
    const state = new URL(url).searchParams.get("state")!;
    await admin`
      update oauth_authorizations set expires_at = now() - interval '1 second'
      where state_hash = ${hash(state)}`;
    const calls = fixture.calls.authorization_code;
    expect((await callback(cookies.owner, fixture.consent(url))).outcome).toBe(
      "invalid_state",
    );
    expect(fixture.calls.authorization_code).toBe(calls);
    await nothingStored();
  });

  it("refuses a state for another provider", async () => {
    const url = await startUrl(cookies.owner);
    const result = await callback(cookies.owner, fixture.consent(url), "acme");
    expect(result.outcome).toBe("invalid_state");
    await nothingStored();
  });

  it("refuses a callback in another user's session and burns the state", async () => {
    const url = await startUrl(cookies.owner);
    const query = fixture.consent(url);
    const calls = fixture.calls.authorization_code;
    // Login CSRF: the owner's authorization completed in the editor's session.
    expect(await callback(cookies.editor, query)).toEqual({
      outcome: "forbidden",
      redirectTo: "/?oauth=forbidden",
    });
    expect(fixture.calls.authorization_code).toBe(calls);
    expect((await callback(cookies.owner, query)).outcome).toBe(
      "invalid_state",
    );
    await nothingStored();
  });

  it("refuses when the role was lost during the flow", async () => {
    const url = await startUrl(cookies.editor);
    await admin`
      update memberships set role = 'viewer'
      where workspace_id = ${workspaceId} and user_id = ${editorUserId}`;
    try {
      const result = await callback(cookies.editor, fixture.consent(url));
      expect(result.outcome).toBe("forbidden");
    } finally {
      await admin`
        update memberships set role = 'editor'
        where workspace_id = ${workspaceId} and user_id = ${editorUserId}`;
    }
    await nothingStored();
  });

  it("refuses ID tokens with a wrong aud, nonce, issuer or expiry", async () => {
    for (const idTokenClaims of [
      { aud: "someone-else.apps.googleusercontent.com" },
      { aud: ["someone-else", CLIENT_ID], azp: "someone-else" },
      { nonce: "another-nonce" },
      { iss: "https://evil.example" },
      { exp: Math.floor(Date.now() / 1000) - 3600 },
      { sub: "" },
    ]) {
      const result = await flow(cookies.owner, {}, { idTokenClaims });
      expect(result.outcome, JSON.stringify(idTokenClaims)).toBe("failed");
      expect(result.redirectTo).toBe(
        `/workspaces/${workspaceId}/connections/new?oauth=failed`,
      );
    }
    await nothingStored();
  });

  it("refuses a code exchange the provider rejects", async () => {
    const url = await startUrl(cookies.owner);
    const query = fixture.consent(url);
    const result = await callback(cookies.owner, {
      ...query,
      code: "not-a-code-the-provider-issued",
    });
    expect(result.outcome).toBe("failed");
    await nothingStored();
  });

  it("refuses a grant without a refresh token", async () => {
    const result = await flow(
      cookies.owner,
      {},
      {
        account: { sub: "no-refresh", email: "n@example.com" },
        noRefreshToken: true,
      },
    );
    expect(result.outcome).toBe("failed");
    await nothingStored();
  });

  it("refuses and revokes a partial scope grant", async () => {
    const account = { sub: "partial-sub", email: "partial@example.com" };
    const revokedBefore = fixture.revoked.length;
    const result = await flow(
      cookies.owner,
      {},
      { account, grantScopes: ["openid"] },
    );
    expect(result).toEqual({
      outcome: "scope_missing",
      redirectTo: `/workspaces/${workspaceId}/connections/new?oauth=scope_missing`,
    });
    await nothingStored();
    const revoked = fixture.revoked.slice(revokedBefore);
    expect(revoked).toHaveLength(1);
    expect(fixture.isActive(revoked[0]!)).toBe(false);
  });

  it("does not revoke a partial grant of an account other connections use", async () => {
    // FIXTURE_ACCOUNT already backs connections from the tests above.
    const revokedBefore = fixture.revoked.length;
    const result = await flow(cookies.owner, {}, { grantScopes: ["openid"] });
    expect(result.outcome).toBe("scope_missing");
    expect(fixture.revoked.length).toBe(revokedBefore);
    await nothingStored();
  });
});

describe("reauthorization", () => {
  let connectionId: string;

  beforeAll(async () => {
    connectionId = connectionIdOf(await flow(cookies.owner));
    // Setup finished (#136 does this through the UI) and the grant broke.
    await admin`update connections set setup_pending = false where id = ${connectionId}`;
  });

  beforeEach(async () => {
    await admin`
      update connection_state
      set auth_state = 'needs_reauthorization', auth_reason = 'invalid_grant',
          next_due_at = null
      where connection_id = ${connectionId}`;
  });

  const reauthorize = (
    consent: ConsentOptions = {},
    body: Record<string, unknown> = {},
    cookie = cookies.owner,
  ) => flow(cookie, { connectionId, ...body }, consent);

  async function state() {
    const [row] = await admin`
      select auth_state, auth_reason, next_due_at from connection_state
      where connection_id = ${connectionId}`;
    return row!;
  }

  it("needs connections:update and an OAuth connection of that connector", async () => {
    expect((await start(cookies.viewer, { connectionId })).statusCode).toBe(
      403,
    );
    const demo = connectionResponseSchema.parse(
      (
        await post(`/v1/workspaces/${workspaceId}/connections`, cookies.owner, {
          connectorId: "demo",
          name: "Demo",
          config: {},
        })
      ).json(),
    ).connection;
    const notLinked = await start(cookies.owner, {
      connectorId: "demo",
      connectionId: demo.id,
    });
    expect(notLinked.statusCode).toBe(400);
    expect(notLinked.json()).toEqual({ error: "oauth_not_supported" });
    const mismatch = await start(cookies.owner, { connectionId: demo.id });
    expect(mismatch.statusCode).toBe(400);
    const unknown = await start(cookies.owner, {
      connectionId: "00000000-0000-4000-8000-000000000000",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("refuses a connection of another workspace", async () => {
    const other = connectionIdOf(
      await flow(cookies.owner, {}, {}, secondWorkspaceId),
    );
    const response = await start(cookies.owner, { connectionId: other });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "connection_not_found" });
    // And a reauthorization of workspace A's connection lands there only.
    const otherBefore = await credentialsOf(other);
    expect((await reauthorize()).outcome).toBe("reauthorized");
    expect((await credentialsOf(other)).equals(otherBefore)).toBe(true);
  });

  it("replaces the tokens, resets the auth state and schedules a sync", async () => {
    const credentialsBefore = await credentialsOf(connectionId);
    const [grantBefore] = await admin`
      select access_token_encrypted from connection_oauth
      where connection_id = ${connectionId}`;
    const result = await reauthorize();
    expect(result).toEqual({
      outcome: "reauthorized",
      redirectTo: `/workspaces/${workspaceId}/connections/${connectionId}?oauth=reauthorized`,
    });
    expect((await credentialsOf(connectionId)).equals(credentialsBefore)).toBe(
      false,
    );
    const [grantAfter] = await admin`
      select access_token_encrypted from connection_oauth
      where connection_id = ${connectionId}`;
    expect(
      (grantAfter!.access_token_encrypted as Buffer).equals(
        grantBefore!.access_token_encrypted as Buffer,
      ),
    ).toBe(false);
    const after = await state();
    expect(after.auth_state).toBe("ok");
    expect(after.auth_reason).toBeNull();
    expect(after.next_due_at).not.toBeNull();
    const connection = await getConnection(connectionId);
    expect(connection.state.authState).toBe("ok");
    const [audit] = await admin`
      select action from audit_events
      where target = ${connectionId} order by created_at desc limit 1`;
    expect(audit!.action).toBe("connection.oauth_reauthorized");
  });

  it("refuses a manual sync until the connection is reconnected", async () => {
    const syncUrl = `/v1/workspaces/${workspaceId}/connections/${connectionId}/sync`;
    const jobsBefore = await admin`
      select id from jobs where connection_id = ${connectionId}`;
    const refused = await post(syncUrl, cookies.owner, {});
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({
      error: "oauth_reauthorization_required",
    });
    const jobsAfter = await admin`
      select id from jobs where connection_id = ${connectionId}`;
    expect(jobsAfter).toHaveLength(jobsBefore.length);

    expect((await reauthorize()).outcome).toBe("reauthorized");
    const accepted = await post(syncUrl, cookies.owner, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("keeps a connection whose setup is pending unscheduled", async () => {
    await admin`update connections set setup_pending = true where id = ${connectionId}`;
    try {
      expect((await reauthorize()).outcome).toBe("reauthorized");
      const after = await state();
      expect(after.auth_state).toBe("ok");
      expect(after.next_due_at).toBeNull();
    } finally {
      await admin`update connections set setup_pending = false where id = ${connectionId}`;
    }
  });

  it("leaves the connection as it was when consent is denied", async () => {
    const credentialsBefore = await credentialsOf(connectionId);
    const result = await reauthorize({ deny: true });
    expect(result.redirectTo).toBe(
      `/workspaces/${workspaceId}/connections/${connectionId}?oauth=denied`,
    );
    expect((await credentialsOf(connectionId)).equals(credentialsBefore)).toBe(
      true,
    );
    expect((await state()).auth_state).toBe("needs_reauthorization");
  });

  it("refuses a different account unless the change was chosen", async () => {
    const credentialsBefore = await credentialsOf(connectionId);
    const revokedBefore = fixture.revoked.length;
    const refused = await reauthorize({ account: OTHER_ACCOUNT });
    expect(refused.outcome).toBe("account_mismatch");
    expect((await credentialsOf(connectionId)).equals(credentialsBefore)).toBe(
      true,
    );
    expect((await state()).auth_state).toBe("needs_reauthorization");
    expect((await getConnection(connectionId)).oauth!.accountEmail).toBe(
      FIXTURE_ACCOUNT.email,
    );
    // The other account holds no grant here, so its grant was revoked.
    expect(fixture.revoked.length).toBe(revokedBefore + 1);

    const changed = await reauthorize(
      { account: OTHER_ACCOUNT },
      { allowAccountChange: true },
    );
    expect(changed.outcome).toBe("reauthorized");
    expect((await getConnection(connectionId)).oauth!.accountEmail).toBe(
      OTHER_ACCOUNT.email,
    );
    const actions = await admin`
      select action from audit_events
      where target = ${connectionId} order by created_at desc limit 2`;
    expect(actions.map((row) => row.action).sort()).toEqual([
      "connection.oauth_account_changed",
      "connection.oauth_reauthorized",
    ]);
  });

  it("refuses a missing scope without touching the connection", async () => {
    const credentialsBefore = await credentialsOf(connectionId);
    const revokedBefore = fixture.revoked.length;
    const result = await reauthorize({
      account: OTHER_ACCOUNT,
      grantScopes: ["openid"],
    });
    expect(result.outcome).toBe("scope_missing");
    expect((await credentialsOf(connectionId)).equals(credentialsBefore)).toBe(
      true,
    );
    // Its own account backs this connection: nothing is revoked.
    expect(fixture.revoked.length).toBe(revokedBefore);
  });
});

describe("secrets", () => {
  it("never puts a code, state, verifier, token or the client secret in responses, logs or audit events", async () => {
    expect(fixture.secrets.length).toBeGreaterThan(10);
    expect(states.length).toBeGreaterThan(10);
    const secrets = [...fixture.secrets, ...states, CLIENT_SECRET].filter(
      (value) => value.length >= 8,
    );
    const logs = logLines.join("\n");
    expect(logs).toContain("oauth authorization refused");
    expect(logs).toContain("oauth authorization completed");
    const audit = (
      await admin`select metadata::text as metadata from audit_events`
    )
      .map((row) => row.metadata as string)
      .join("\n");
    const responses = callbackBodies.join("\n");
    for (const secret of secrets) {
      expect(logs.includes(secret)).toBe(false);
      expect(responses.includes(secret)).toBe(false);
      expect(audit.includes(secret)).toBe(false);
    }
    // The account email is shown in the app but never logged.
    expect(logs).not.toContain(FIXTURE_ACCOUNT.email);
  });
});
