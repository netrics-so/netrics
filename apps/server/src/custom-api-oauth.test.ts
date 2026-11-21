import { createHash, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { Writable } from "node:stream";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  connectionResponseSchema,
  customApiDefinitionResponseSchema,
  customApiDraftResponseSchema,
  customApiTestResponseSchema,
  deleteConnectionResponseSchema,
  oauthCallbackResponseSchema,
  startOAuthAuthorizationResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { CUSTOM_API_MESSAGES } from "@netrics/connectors/custom-api";
import {
  FIXTURE_OAUTH_CLIENT,
  fixtureDefinition,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
} from "@netrics/connectors/custom-api/testing";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Job,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring, decryptCredentials } from "./credentials.js";
import { loadConfig } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { OAuthProviders } from "./oauth/config.js";
import {
  createCustomOAuthResolver,
  createOAuthTokenService,
  type OAuthTokenService,
} from "./oauth/tokens.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Custom OAuth for custom APIs (#805, ADR 0027): client credentials and
// authorization code with PKCE against the fixture's own OAuth server, for
// connections and builder drafts; refresh, revocation on delete and on
// draft cleanup; no client secret, code or token in logs or answers.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const KEY = Buffer.alloc(32, 9).toString("base64");
const WEB_ORIGIN = "http://localhost:3000";
const { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } =
  FIXTURE_OAUTH_CLIENT;

let fixture: CustomApiFixtureServer;
let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let editor: string;
let workspaceId: string;
let tokens: OAuthTokenService;
const keyring = createCredentialKeyring(KEY);
const logLines: string[] = [];
const bodies: string[] = [];

function call(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  payload?: unknown,
  cookie: string = owner,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  };
  return app.inject(options).then((response) => {
    bodies.push(response.body);
    return response;
  });
}

async function signUp(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

const ws = (path: string) => `/v1/workspaces/${workspaceId}${path}`;

type FixtureName =
  | "oauth_client_credentials"
  | "oauth_client_credentials_basic"
  | "oauth_code"
  | "oauth_code_no_pkce";

function document(
  name: FixtureName,
  change: (auth: Record<string, unknown>) => Record<string, unknown> = (a) => a,
): CustomApiDefinition {
  const base = fixtureDefinition(name, fixture.origin);
  return {
    ...base,
    auth: change({ ...base.auth }) as CustomApiDefinition["auth"],
  };
}

async function createDefinition(doc: CustomApiDefinition) {
  const response = await call("POST", ws("/custom-api/definitions"), {
    document: doc,
  });
  expect(response.statusCode, response.body).toBe(201);
  return customApiDefinitionResponseSchema.parse(response.json()).definition;
}

function connect(definitionId: string, extra: Record<string, unknown> = {}) {
  return call(
    "POST",
    ws(`/custom-api/definitions/${definitionId}/connections`),
    {
      name: "OAuth shop",
      environmentId: "production",
      variables: {},
      secretVariables: {},
      credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
      ...extra,
    },
  );
}

async function connection(doc: CustomApiDefinition): Promise<string> {
  const definition = await createDefinition(doc);
  const response = await connect(definition.id);
  expect(response.statusCode, response.body).toBe(201);
  return connectionResponseSchema.parse(response.json()).connection.id;
}

/** A builder draft of the document's first stream, with the client stored. */
function draftDefinition(doc: CustomApiDefinition) {
  return {
    name: doc.name,
    environments: doc.environments,
    auth: doc.auth,
    defaults: doc.defaults,
    stream: doc.streams[0],
  };
}

async function newDraft(doc: CustomApiDefinition): Promise<string> {
  const created = await call("POST", ws("/custom-api/drafts"), {});
  expect(created.statusCode, created.body).toBe(201);
  const id = customApiDraftResponseSchema.parse(created.json()).draft.id;
  const stored = await call("PUT", ws(`/custom-api/drafts/${id}`), {
    definition: draftDefinition(doc),
    environmentId: "production",
    secrets: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
  });
  expect(stored.statusCode, stored.body).toBe(200);
  return id;
}

function testDraft(id: string, doc: CustomApiDefinition) {
  return call("POST", ws(`/custom-api/drafts/${id}/test`), {
    definition: draftDefinition(doc),
    environmentId: "production",
  });
}

/** GET on the fixture without following redirects. */
function fixtureGet(
  url: string,
): Promise<{ status: number; location: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ca: fixture.ca! }, (response) => {
      response.resume();
      resolve({
        status: response.statusCode ?? 0,
        location: response.headers.location ?? "",
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function start(connectionId: string, cookie = owner) {
  return call(
    "POST",
    ws("/oauth/authorizations"),
    { connectorId: "custom-api", connectionId },
    cookie,
  );
}

/** Start, consent at the fixture, callback (as `callbackCookie`). */
async function authorize(
  connectionId: string,
  callbackCookie = owner,
): Promise<{
  callback: ReturnType<typeof oauthCallbackResponseSchema.parse>;
  authorizationUrl: URL;
  purpose: string;
}> {
  const started = await start(connectionId);
  expect(started.statusCode, started.body).toBe(200);
  const body = startOAuthAuthorizationResponseSchema.parse(started.json());
  const consent = await fixtureGet(body.authorizationUrl);
  expect(consent.status).toBe(302);
  const back = new URL(consent.location);
  expect(back.origin + back.pathname).toBe(
    `${WEB_ORIGIN}/oauth/custom/callback`,
  );
  const callback = await call(
    "POST",
    "/v1/oauth/custom/callback",
    {
      state: back.searchParams.get("state"),
      code: back.searchParams.get("code"),
    },
    callbackCookie,
  );
  expect(callback.statusCode, callback.body).toBe(200);
  return {
    callback: oauthCallbackResponseSchema.parse(callback.json()),
    authorizationUrl: new URL(body.authorizationUrl),
    purpose: body.purpose,
  };
}

async function envelope(connectionId: string) {
  const [row] = await admin<{ credentials_encrypted: Buffer }[]>`
    select credentials_encrypted from connections where id = ${connectionId}`;
  return JSON.parse(
    decryptCredentials(row!.credentials_encrypted.toString("utf8"), keyring, {
      workspaceId,
      connectionId,
    }),
  ) as Record<string, unknown>;
}

async function grant(connectionId: string) {
  const [row] = await admin<
    {
      provider: string;
      account_sub: string;
      granted_scopes: string[];
      access_token_expires_at: Date | null;
    }[]
  >`select provider, account_sub, granted_scopes, access_token_expires_at
    from connection_oauth where connection_id = ${connectionId}`;
  return row ?? null;
}

async function state(connectionId: string) {
  const [row] = await admin<
    {
      auth_state: string;
      auth_reason: string | null;
      next_due_at: Date | null;
    }[]
  >`select auth_state, auth_reason, next_due_at from connection_state
    where connection_id = ${connectionId}`;
  return row!;
}

const expire = (connectionId: string) => admin`
  update connection_oauth
  set access_token_expires_at = now() - interval '1 hour'
  where connection_id = ${connectionId}`;

const jobHandlers = () =>
  createJobHandlers({
    registry: new ConnectorRegistry(),
    credentialKeyring: keyring,
    oauthTokens: tokens,
    executeOptions: {
      egress: { tlsCa: fixture.ca!, allowPrivateHosts: ["127.0.0.1"] },
    },
  });

async function runJob(kind: string, connectionId: string) {
  await jobHandlers()[kind]!({
    job: {
      id: randomUUID(),
      kind,
      workspaceId,
      connectionId,
      attempts: 0,
      payload: {},
    } as unknown as Job,
    appDb: db,
    schedulerDb: db,
    logger: pino({ level: "silent" }),
  }).catch(() => undefined);
}

beforeAll(async () => {
  fixture = await startCustomApiFixtureServer({ tls: true });
  const testDb = await createTestDatabase();
  const env = {
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN,
    APP_ENCRYPTION_KEY: KEY,
  };
  const config = loadConfig(env);
  db = createDatabase(testDb.appUrl);
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, done) {
        logLines.push(String(chunk));
        done();
      },
    }),
  );
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  const egress = { tlsCa: fixture.ca!, allowPrivateHosts: ["127.0.0.1"] };
  app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    executeOptions: { egress },
    logger,
  });
  // The worker's token service.
  tokens = createOAuthTokenService({
    db,
    credentialKeyring: keyring,
    providers: new OAuthProviders([]),
    logger,
    customOAuth: createCustomOAuthResolver({
      credentialKeyring: keyring,
      webOrigin: WEB_ORIGIN,
      egress,
    }),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("custom-oauth-owner@example.com");
  editor = await signUp("custom-oauth-editor@example.com");
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: owner },
    payload: { name: "Custom OAuth" },
  });
  workspaceId = workspaceResponseSchema.parse(created.json()).workspace.id;
  const added = await addMemberViaInvitation(
    app,
    db,
    owner,
    workspaceId,
    "custom-oauth-editor@example.com",
    "editor",
  );
  expect(added.statusCode).toBe(200);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  await fixture?.close();
});

beforeEach(async () => {
  fixture.oauth.clientSecret = CLIENT_SECRET;
  await admin`delete from custom_api_test_rate`;
});

describe("custom OAuth: client credentials", () => {
  it("tests a client-credentials draft with a minted token and keeps the grant on promote", async () => {
    const doc = document("oauth_client_credentials");
    const id = await newDraft(doc);
    const tested = await testDraft(id, doc);
    expect(tested.statusCode, tested.body).toBe(200);
    const body = customApiTestResponseSchema.parse(tested.json());
    expect(body.ok, JSON.stringify(body.error)).toBe(true);
    expect(body.records.count).toBe(3);
    const minted = await grant(id);
    expect(minted).toMatchObject({
      provider: "custom",
      granted_scopes: ["items.read"],
    });
    expect(minted!.account_sub).toMatch(/^custom:/);

    const definition = await createDefinition(doc);
    const promoted = await call(
      "POST",
      ws(`/custom-api/drafts/${id}/promote`),
      {
        definitionId: definition.id,
        version: 1,
        name: "Promoted",
        projectId: null,
      },
    );
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(await grant(id)).toEqual(minted);
    expect(await envelope(id)).toEqual({
      host: `127.0.0.1:${fixture.port}`,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: null,
    });
  });

  it("creates a client-credentials connection and syncs with the minted token", async () => {
    const before = fixture.oauth.tokenRequests.length;
    const id = await connection(document("oauth_client_credentials"));
    expect(fixture.oauth.tokenRequests.slice(before)).toEqual([
      {
        grantType: "client_credentials",
        clientAuth: "body",
        codeVerifier: null,
        codeChallenge: null,
        scope: "items.read",
      },
    ]);
    expect((await grant(id))!.provider).toBe("custom");
    fixture.reset();
    await runJob("connection.backfill", id);
    const [run] = await admin<
      { status: string; error_message: string | null }[]
    >`
      select status, error_message from sync_runs where connection_id = ${id}
      order by started_at desc limit 1`;
    expect(run, JSON.stringify(run)).toMatchObject({ status: "succeeded" });
    const api = fixture.requests.filter((r) => r.path === "/oauth/api/items");
    expect(api.length).toBeGreaterThan(0);
    const bearer = api[0]!.headers.authorization!.slice("Bearer ".length);
    expect(fixture.oauth.issued).toContain(bearer);
  });

  it("refuses a wrong client secret with the token message and stores nothing", async () => {
    const definition = await createDefinition(
      document("oauth_client_credentials"),
    );
    const [before] = await admin<{ n: number }[]>`
      select count(*)::int as n from connections`;
    const response = await connect(definition.id, {
      credentials: { clientId: CLIENT_ID, clientSecret: "wrong-secret" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(CUSTOM_API_MESSAGES.tokenRefused);
    const [after] = await admin<{ n: number }[]>`
      select count(*)::int as n from connections`;
    expect(after!.n).toBe(before!.n);
  });

  it("requests a new token when the cached one expired, once for two concurrent calls", async () => {
    const id = await connection(document("oauth_client_credentials"));
    await expire(id);
    const before = fixture.oauth.tokenRequests.length;
    const binding = { workspaceId, connectionId: id };
    const [a, b] = await Promise.all([
      tokens.getAccessToken(binding, { requiredScopes: ["items.read"] }),
      tokens.getAccessToken(binding, { requiredScopes: ["items.read"] }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.accessToken).toBe(b.accessToken);
    expect(fixture.oauth.tokenRequests.length - before).toBe(1);
    expect(fixture.oauth.tokenRequests.at(-1)!.grantType).toBe(
      "client_credentials",
    );
    expect(
      (await grant(id))!.access_token_expires_at!.getTime(),
    ).toBeGreaterThan(Date.now());
  });

  it("marks the connection auth_failed when the client secret is revoked", async () => {
    const id = await connection(document("oauth_client_credentials"));
    await expire(id);
    fixture.oauth.clientSecret = "rotated-at-the-provider";
    await runJob("connection.sync", id);
    expect((await state(id)).auth_state).toBe("auth_failed");
    const [run] = await admin<{ error_message: string | null }[]>`
      select error_message from sync_runs where connection_id = ${id}
      order by started_at desc limit 1`;
    expect(run!.error_message).toBe(CUSTOM_API_MESSAGES.tokenRefused);
  });

  it("never stores or returns the client secret outside the envelope", async () => {
    const id = await connection(document("oauth_client_credentials"));
    const detail = await call("GET", ws(`/connections/${id}`));
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(CLIENT_SECRET);
    const [row] = await admin<{ dump: string }[]>`
      select (to_jsonb(c) - 'credentials_encrypted')::text
        || coalesce((select to_jsonb(o)::text from connection_oauth o
                     where o.connection_id = c.id), '')
        || coalesce((select string_agg(to_jsonb(a)::text, '') from audit_events a
                     where a.target = c.id::text), '') as dump
      from connections c where c.id = ${id}`;
    expect(row!.dump).not.toContain(CLIENT_SECRET);
    for (const issued of fixture.oauth.issued)
      expect(row!.dump).not.toContain(issued);
    expect((await envelope(id)).clientSecret).toBe(CLIENT_SECRET);
  });

  it("sends client credentials as basic when the definition says so", async () => {
    const before = fixture.oauth.tokenRequests.length;
    await connection(document("oauth_client_credentials_basic"));
    expect(fixture.oauth.tokenRequests.slice(before)).toEqual([
      expect.objectContaining({
        grantType: "client_credentials",
        clientAuth: "basic",
      }),
    ]);
  });
});

describe("custom OAuth: authorization code", () => {
  it("shows the redirect URI derived from the web origin", async () => {
    const response = await call("GET", ws("/custom-api/oauth"));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      redirectUri: `${WEB_ORIGIN}/oauth/custom/callback`,
    });
  });

  it("authorizes a draft from its unsaved definition without scheduling it, and its test request uses the token", async () => {
    const doc = document("oauth_code");
    const id = await newDraft(doc);
    const before = customApiTestResponseSchema.parse(
      (await testDraft(id, doc)).json(),
    );
    expect(before.error?.code).toBe("custom_api_secret_missing");
    const { callback, purpose } = await authorize(id);
    expect(purpose).toBe("authorize");
    expect(callback.outcome).toBe("connected");
    expect(callback.redirectTo).toBe(
      `/workspaces/${workspaceId}/custom-apis/new?oauth=connected&draft=${id}`,
    );
    expect((await state(id)).next_due_at).toBeNull();
    const [row] = await admin<{ status: string }[]>`
      select status from connections where id = ${id}`;
    expect(row!.status).toBe("draft");
    expect(typeof (await envelope(id)).refreshToken).toBe("string");
    fixture.reset();
    const tested = customApiTestResponseSchema.parse(
      (await testDraft(id, doc)).json(),
    );
    expect(tested.ok, JSON.stringify(tested.error)).toBe(true);
    const bearer = fixture.requests
      .find((r) => r.path === "/oauth/api/items")!
      .headers.authorization!.slice("Bearer ".length);
    expect(fixture.oauth.issued).toContain(bearer);
  });

  it("promotes an authorized draft keeping its grant and refuses one without a grant", async () => {
    const doc = document("oauth_code");
    const definition = await createDefinition(doc);
    const promote = (id: string) =>
      call("POST", ws(`/custom-api/drafts/${id}/promote`), {
        definitionId: definition.id,
        version: 1,
        name: "Signed in",
        projectId: null,
      });
    const unsigned = await newDraft(doc);
    const refused = await promote(unsigned);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("custom_api_secret_missing");

    const signed = await newDraft(doc);
    await authorize(signed);
    const before = await grant(signed);
    const stored = (await envelope(signed)).refreshToken;
    const promoted = await promote(signed);
    expect(promoted.statusCode, promoted.body).toBe(200);
    expect(await grant(signed)).toEqual(before);
    expect((await envelope(signed)).refreshToken).toBe(stored);
    expect((await state(signed)).next_due_at).not.toBeNull();
  });

  it("authorizes a pending connection with PKCE and starts its backfill", async () => {
    const id = await connection(document("oauth_code"));
    const pending = await call("GET", ws(`/connections/${id}`));
    expect(pending.json().connection.setupPending).toBe(true);
    expect((await state(id)).next_due_at).toBeNull();
    expect(await grant(id)).toBeNull();

    const { callback, authorizationUrl } = await authorize(id);
    expect(callback).toEqual({
      outcome: "connected",
      redirectTo: `/workspaces/${workspaceId}/connections/${id}?oauth=connected&connection=${id}`,
    });
    const params = authorizationUrl.searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("audience")).toBe("netrics");
    expect(params.get("scope")).toBe("items.read");
    expect(params.has("nonce")).toBe(false);
    const exchange = fixture.oauth.tokenRequests.at(-1)!;
    expect(exchange.grantType).toBe("authorization_code");
    expect(exchange.codeChallenge).toBe(params.get("code_challenge"));
    expect(
      createHash("sha256").update(exchange.codeVerifier!).digest("base64url"),
    ).toBe(params.get("code_challenge"));

    const after = await call("GET", ws(`/connections/${id}`));
    expect(after.json().connection.setupPending).toBe(false);
    expect((await state(id)).next_due_at).not.toBeNull();
    const [job] = await admin<{ kind: string }[]>`
      select kind from jobs where connection_id = ${id}`;
    expect(job!.kind).toBe("connection.backfill");
  });

  it("works without PKCE when the definition turns it off", async () => {
    const id = await connection(document("oauth_code_no_pkce"));
    const { callback, authorizationUrl } = await authorize(id);
    expect(callback.outcome).toBe("connected");
    expect(authorizationUrl.searchParams.has("code_challenge")).toBe(false);
    expect(fixture.oauth.tokenRequests.at(-1)).toMatchObject({
      grantType: "authorization_code",
      codeVerifier: null,
      codeChallenge: null,
    });
  });

  it("reauthorizes and keeps the account sub", async () => {
    const id = await connection(document("oauth_code"));
    await authorize(id);
    const first = await grant(id);
    const again = await authorize(id);
    expect(again.purpose).toBe("reauthorize");
    expect(again.callback.outcome).toBe("reauthorized");
    expect((await grant(id))!.account_sub).toBe(first!.account_sub);
  });

  it("refuses another user's callback and an expired state", async () => {
    const id = await connection(document("oauth_code"));
    const other = await authorize(id, editor);
    expect(other.callback.outcome).toBe("forbidden");
    expect(await grant(id)).toBeNull();

    const started = startOAuthAuthorizationResponseSchema.parse(
      (await start(id)).json(),
    );
    await admin`
      update oauth_authorizations set expires_at = now() - interval '1 minute'
      where connection_id = ${id} and consumed_at is null`;
    const consent = new URL(
      (await fixtureGet(started.authorizationUrl)).location,
    );
    const expired = oauthCallbackResponseSchema.parse(
      (
        await call("POST", "/v1/oauth/custom/callback", {
          state: consent.searchParams.get("state"),
          code: consent.searchParams.get("code"),
        })
      ).json(),
    );
    expect(expired.outcome).toBe("invalid_state");
    expect(await grant(id)).toBeNull();
  });

  it("refuses start for a connection with another auth type", async () => {
    const id = await connection(document("oauth_client_credentials"));
    const response = await start(id);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("oauth_not_supported");
    const missing = await call("POST", ws("/oauth/authorizations"), {
      connectorId: "custom-api",
    });
    expect(missing.json().error).toBe("custom_api_requires_definition");
  });

  it("refreshes with the stored refresh token and rotates it", async () => {
    const id = await connection(
      document("oauth_code", (auth) => ({
        ...auth,
        tokenUrl: `${fixture.origin}/oauth/token?rotate=1`,
      })),
    );
    await authorize(id);
    const before = (await envelope(id)).refreshToken;
    await expire(id);
    const token = await tokens.getAccessToken(
      { workspaceId, connectionId: id },
      { requiredScopes: ["items.read"] },
    );
    expect(token.ok).toBe(true);
    expect(fixture.oauth.tokenRequests.at(-1)!.grantType).toBe("refresh_token");
    const after = await envelope(id);
    expect(after.refreshToken).not.toBe(before);
    expect(fixture.oauth.issued).toContain(after.refreshToken);
    expect(after.clientSecret).toBe(CLIENT_SECRET);
  });

  it("moves to needs_reauthorization on invalid_grant", async () => {
    const id = await connection(document("oauth_code"));
    await authorize(id);
    fixture.oauth.revokeRefreshTokens();
    await expire(id);
    const token = await tokens.getAccessToken(
      { workspaceId, connectionId: id },
      { requiredScopes: ["items.read"] },
    );
    expect(token).toEqual({ ok: false, reason: "invalid_grant" });
    expect(await state(id)).toMatchObject({
      auth_state: "needs_reauthorization",
      auth_reason: "invalid_grant",
    });
  });
});

describe("custom OAuth: revocation", () => {
  it("revokes the refresh token at the definition's revoke URL on delete", async () => {
    const id = await connection(document("oauth_code"));
    await authorize(id);
    const refresh = (await envelope(id)).refreshToken as string;
    const deleted = await call("DELETE", ws(`/connections/${id}`));
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleteConnectionResponseSchema.parse(deleted.json())).toEqual({
      revocation: {
        provider: "custom",
        status: "revoked",
        accountPermissionsUrl: fixture.origin,
      },
    });
    expect(fixture.oauth.revoked).toContain(refresh);
  });

  it("reports failed and sends nothing without a revoke URL", async () => {
    const id = await connection(
      document("oauth_code", ({ revokeUrl: _revoke, ...auth }) => auth),
    );
    await authorize(id);
    const revoked = fixture.oauth.revoked.length;
    fixture.reset();
    const deleted = await call("DELETE", ws(`/connections/${id}`));
    expect(deleteConnectionResponseSchema.parse(deleted.json())).toEqual({
      revocation: {
        provider: "custom",
        status: "failed",
        accountPermissionsUrl: fixture.origin,
      },
    });
    expect(fixture.oauth.revoked.length).toBe(revoked);
    expect(fixture.requests).toHaveLength(0);
  });

  it("revokes a draft's grant before deleting the draft", async () => {
    const id = await newDraft(document("oauth_code"));
    await authorize(id);
    const refresh = (await envelope(id)).refreshToken as string;
    const deleted = await call("DELETE", ws(`/custom-api/drafts/${id}`));
    expect(deleted.statusCode).toBe(204);
    expect(fixture.oauth.revoked).toContain(refresh);
    expect(await grant(id)).toBeNull();
  });

  it("revokes an expired draft's grant before the cleanup deletes it", async () => {
    const id = await newDraft(document("oauth_code"));
    await authorize(id);
    const refresh = (await envelope(id)).refreshToken as string;
    await admin`
      update connections set updated_at = now() - interval '25 hours'
      where id = ${id}`;
    // The plain prune leaves it to the revoke job.
    await admin`select prune_draft_connections(now(), interval '24 hours', 100)`;
    const [kept] = await admin<{ n: number }[]>`
      select count(*)::int as n from connections where id = ${id}`;
    expect(kept!.n).toBe(1);
    await admin`select enqueue_expired_draft_grants(now(), interval '24 hours', 100)`;
    const [job] = await admin<{ kind: string }[]>`
      select kind from jobs where connection_id = ${id}`;
    expect(job!.kind).toBe("custom_api.draft_expired");
    await runJob("custom_api.draft_expired", id);
    expect(fixture.oauth.revoked).toContain(refresh);
    const [gone] = await admin<{ n: number }[]>`
      select count(*)::int as n from connections where id = ${id}`;
    expect(gone!.n).toBe(0);
  });

  it("drops a draft's grant when the token host changes, and revokes it", async () => {
    const doc = document("oauth_code");
    const id = await newDraft(doc);
    await authorize(id);
    const refresh = (await envelope(id)).refreshToken as string;
    const moved = {
      ...doc,
      auth: {
        ...doc.auth,
        tokenUrl: `https://localhost:${fixture.port}/oauth/token`,
      },
    } as CustomApiDefinition;
    const stored = await call("PUT", ws(`/custom-api/drafts/${id}`), {
      definition: draftDefinition(moved),
      environmentId: "production",
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(
      customApiDraftResponseSchema.parse(stored.json()).draft.secretsSet,
    ).toEqual([]);
    expect(await grant(id)).toBeNull();
    expect(fixture.oauth.revoked).toContain(refresh);
  });

  it("never logs or returns the client secret, codes or tokens", async () => {
    // Start, callback, refresh and delete have all run above; once more
    // here in one place.
    const id = await connection(
      document("oauth_code", (auth) => ({
        ...auth,
        tokenUrl: `${fixture.origin}/oauth/token?rotate=1`,
      })),
    );
    await authorize(id);
    await expire(id);
    await tokens.getAccessToken(
      { workspaceId, connectionId: id },
      { requiredScopes: ["items.read"] },
    );
    await call("DELETE", ws(`/connections/${id}`));
    const logs = logLines.join("\n");
    expect(logs).toContain("oauth authorization completed");
    expect(logs).toContain("oauth access token refreshed");
    const answers = bodies.join("\n");
    expect(fixture.oauth.issued.length).toBeGreaterThan(10);
    for (const secret of [CLIENT_SECRET, ...fixture.oauth.issued]) {
      expect(logs).not.toContain(secret);
      expect(answers).not.toContain(secret);
    }
  });
});
