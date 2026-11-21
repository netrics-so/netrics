import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";

import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  connectionResponseSchema,
  customApiDefinitionConnectionsResponseSchema,
  customApiDefinitionResponseSchema,
  customApiUpdateErrorResponseSchema,
  customApiUpdatePlanResponseSchema,
  oauthCallbackResponseSchema,
  startOAuthAuthorizationResponseSchema,
  type CustomApiUpdatePlan,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import {
  FIXTURE_OAUTH_CLIENT,
  FIXTURE_SECRETS,
  fixtureDefinition,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
  type FixtureDefinitionName,
} from "@netrics/connectors/custom-api/testing";
import { findConnection, withWorkspace, type Job } from "@netrics/database";

import { createCredentialKeyring, decryptCredentials } from "./credentials.js";
import {
  prepareCustomOAuthClientChange,
  type CustomOAuthClientChange,
} from "./custom-api/connections.js";
import { connectorFor } from "./custom-api/connectors.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { OAuthProviders } from "./oauth/config.js";
import {
  createCustomOAuthResolver,
  createOAuthTokenService,
} from "./oauth/tokens.js";
import {
  startCustomApiTestApp,
  type CustomApiTestApp,
} from "./custom-api/test-helpers.js";
import { TEST_DATABASE_SETUP_TIMEOUT_MS } from "./test-db.js";

// Explicit definition updates of custom API connections (#808): offered,
// reviewed and applied against the pinned version; the login carries over
// only while the new version sends it to the same hosts with the same
// method, otherwise it is dropped (an OAuth grant revoked at its own
// hosts) and the connection needs its login again.

const KEY = Buffer.alloc(32, 5).toString("base64"); // the test app's key
const keyring = createCredentialKeyring(KEY);

let a: CustomApiFixtureServer; // the hosts of version 1
let b: CustomApiFixtureServer; // other hosts (another port)
let t: CustomApiTestApp;
let owner: string;
let viewer: string;
let workspaceId: string;

const ws = (path: string) => `/v1/workspaces/${workspaceId}${path}`;

const LOGINS = {
  api_key_header: { apiKey: FIXTURE_SECRETS.apiKey },
  bearer: { token: FIXTURE_SECRETS.token },
  basic: {
    username: FIXTURE_SECRETS.username,
    password: FIXTURE_SECRETS.password,
  },
} as const;
type Method = keyof typeof LOGINS;

const doc = (name: FixtureDefinitionName, at = a) =>
  fixtureDefinition(name, at.origin);

/** The same definition with every URL on fixture `to`. */
function moved(definition: CustomApiDefinition, to: CustomApiFixtureServer) {
  const text = JSON.stringify(definition).replaceAll(a.origin, to.origin);
  return JSON.parse(text) as CustomApiDefinition;
}

async function define(document: CustomApiDefinition) {
  const res = await t.call("POST", ws("/custom-api/definitions"), owner, {
    document,
  });
  expect(res.statusCode, res.body).toBe(201);
  return customApiDefinitionResponseSchema.parse(res.json()).definition;
}

async function save(definitionId: string, document: CustomApiDefinition) {
  const [row] = await t.admin<{ v: number }[]>`
    select current_version as v from custom_api_definitions
    where id = ${definitionId}`;
  const res = await t.call(
    "POST",
    ws(`/custom-api/definitions/${definitionId}/versions`),
    owner,
    { baseVersion: row!.v, document },
  );
  expect(res.statusCode, res.body).toBe(201);
  return customApiDefinitionResponseSchema.parse(res.json()).definition;
}

async function connect(
  definitionId: string,
  credentials: Record<string, string>,
  variables: Record<string, string> = {},
  secretVariables: Record<string, string> = {},
) {
  const res = await t.call(
    "POST",
    ws(`/custom-api/definitions/${definitionId}/connections`),
    owner,
    {
      name: "Shop",
      environmentId: "production",
      credentials,
      variables,
      secretVariables,
    },
  );
  expect(res.statusCode, res.body).toBe(201);
  return connectionResponseSchema.parse(res.json()).connection.id;
}

const getConnection = async (id: string) =>
  connectionResponseSchema.parse(
    (await t.call("GET", ws(`/connections/${id}`), viewer)).json(),
  ).connection;

async function plan(id: string): Promise<CustomApiUpdatePlan> {
  const res = await t.call(
    "GET",
    ws(`/connections/${id}/custom-api-update`),
    viewer,
  );
  expect(res.statusCode, res.body).toBe(200);
  return customApiUpdatePlanResponseSchema.parse(res.json()).plan;
}

const apply = (
  id: string,
  offer: CustomApiUpdatePlan,
  extra: Record<string, unknown> = {},
  cookie = owner,
) =>
  t.call("POST", ws(`/connections/${id}/custom-api-update`), cookie, {
    basis: offer.basis,
    toVersionId: offer.toVersion.id,
    ...extra,
  });

async function applied(
  id: string,
  offer: CustomApiUpdatePlan,
  extra: Record<string, unknown> = {},
) {
  const res = await apply(id, offer, extra);
  expect(res.statusCode, res.body).toBe(200);
  return connectionResponseSchema.parse(res.json()).connection;
}

async function envelope(id: string) {
  const [row] = await t.admin<{ credentials_encrypted: Buffer | null }[]>`
    select credentials_encrypted from connections where id = ${id}`;
  const sealed = row!.credentials_encrypted;
  return sealed
    ? (JSON.parse(
        decryptCredentials(sealed.toString("utf8"), keyring, {
          workspaceId,
          connectionId: id,
        }),
      ) as Record<string, unknown>)
    : null;
}

async function authState(id: string) {
  const [row] = await t.admin<
    { auth_state: string; auth_reason: string | null }[]
  >`
    select auth_state, auth_reason from connection_state
    where connection_id = ${id}`;
  return row!;
}

async function grant(id: string) {
  const [row] = await t.admin<{ account_sub: string }[]>`
    select account_sub from connection_oauth where connection_id = ${id}`;
  return row ?? null;
}

const pinnedVersion = async (id: string) => {
  const [row] = await t.admin<{ version: number }[]>`
    select v.version from connections c
    join custom_api_definition_versions v
      on v.id = c.custom_api_definition_version_id
    where c.id = ${id}`;
  return row!.version;
};

/** The owner's user id (the actor of direct service calls). */
async function callerId() {
  const [row] = await t.admin<{ id: string }[]>`
    select id from users where email = 'updates-owner@example.com'`;
  return row!.id;
}

/** The login outcome of the connection's latest update. */
async function auditLogin(id: string) {
  const [row] = await t.admin<{ login: string }[]>`
    select metadata->>'login' as login from audit_events
    where action = 'connection.custom_api_updated' and target = ${id}
    order by created_at desc limit 1`;
  return row?.login ?? null;
}

/** One more item field, so the update has a change. */
const withField = (definition: CustomApiDefinition): CustomApiDefinition => ({
  ...definition,
  streams: definition.streams.map((stream) => ({
    ...stream,
    fields: [
      ...stream.fields,
      {
        id: "label",
        name: "Label",
        path: "name",
        type: "string",
        nullable: true,
        classification: "internal",
      },
    ],
  })),
});

/** Sign-in at fixture `at` for a custom OAuth connection (as the owner). */
async function signIn(connectionId: string) {
  const started = await t.call("POST", ws("/oauth/authorizations"), owner, {
    connectorId: "custom-api",
    connectionId,
  });
  expect(started.statusCode, started.body).toBe(200);
  const body = startOAuthAuthorizationResponseSchema.parse(started.json());
  const consent = await new Promise<string>((resolve, reject) => {
    const request = httpsRequest(
      body.authorizationUrl,
      { ca: a.ca! },
      (response) => {
        response.resume();
        resolve(response.headers.location ?? "");
      },
    );
    request.on("error", reject);
    request.end();
  });
  const back = new URL(consent);
  const callback = await t.call("POST", "/v1/oauth/custom/callback", owner, {
    state: back.searchParams.get("state"),
    code: back.searchParams.get("code"),
  });
  expect(callback.statusCode, callback.body).toBe(200);
  expect(oauthCallbackResponseSchema.parse(callback.json()).outcome).toBe(
    "connected",
  );
}

beforeAll(async () => {
  a = await startCustomApiFixtureServer({ tls: true });
  b = await startCustomApiFixtureServer({ tls: true });
  t = await startCustomApiTestApp({
    deps: {
      executeOptions: {
        egress: {
          // Both fixtures' certificates.
          tlsCa: `${a.ca!}\n${b.ca!}`,
          allowPrivateHosts: ["127.0.0.1"],
        },
      },
    },
  });
  owner = await t.signUp("updates-owner@example.com");
  viewer = await t.signUp("updates-viewer@example.com");
  workspaceId = await t.newWorkspace(owner);
  await t.addMember(owner, workspaceId, "updates-viewer@example.com", "viewer");
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await t?.close();
  await a?.close();
  await b?.close();
});

beforeEach(() => {
  a.reset();
  b.reset();
});

describe("custom API connection updates", () => {
  it("offers the update on the connection and applies it with a fresh basis", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    const before = await envelope(id);
    await save(definition.id, withField(doc("bearer")));
    expect((await getConnection(id)).customApi).toMatchObject({
      version: 1,
      currentVersion: 2,
      updateAvailable: true,
      loginMissing: false,
    });
    const listed = customApiDefinitionConnectionsResponseSchema.parse(
      (
        await t.call(
          "GET",
          ws(`/custom-api/definitions/${definition.id}/connections`),
          viewer,
        )
      ).json(),
    );
    expect(listed.connections).toEqual([
      {
        id,
        name: "Shop",
        environmentId: "production",
        version: 1,
        updateAvailable: true,
      },
    ]);
    const offer = await plan(id);
    expect(offer).toMatchObject({
      fromVersion: { version: 1 },
      toVersion: { version: 2 },
      changes: [{ kind: "field_added", stream: "items", field: "label" }],
      blockers: [],
      login: { carriesOver: true, reason: null, method: "bearer" },
    });
    const updated = await applied(id, offer);
    expect(updated.customApi).toMatchObject({
      version: 2,
      updateAvailable: false,
      loginMissing: false,
    });
    expect(await envelope(id)).toEqual(before);
    expect((await authState(id)).auth_state).toBe("ok");
    const none = await t.call(
      "GET",
      ws(`/connections/${id}/custom-api-update`),
      viewer,
    );
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toBe("custom_api_update_none");
    const [audit] = await t.admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events
      where action = 'connection.custom_api_updated' and target = ${id}`;
    expect(audit!.metadata).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      changes: ["field_added"],
      login: "kept",
    });
    expect(JSON.stringify(audit!.metadata)).not.toContain(
      FIXTURE_SECRETS.token,
    );
  });

  it("lists the issues of a malformed apply body (#834 review)", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, withField(doc("bearer")));
    const offer = await plan(id);
    const res = await apply(id, offer, { toVersionId: "not-a-uuid", extra: 1 });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    expect(res.json().issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "toVersionId" }),
      ]),
    );
  });

  it("never applies an update by itself", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, withField(doc("bearer")));
    await save(definition.id, doc("bearer"));
    expect(await pinnedVersion(id)).toBe(1);
  });

  it("refuses a stale basis and returns the fresh plan", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, withField(doc("bearer")));
    const offer = await plan(id);
    const both = await Promise.all([apply(id, offer), apply(id, offer)]);
    expect(both.map((res) => res.statusCode).sort()).toEqual([200, 409]);
    const refused = both.find((res) => res.statusCode === 409)!;
    expect(refused.json().error).toBe("custom_api_update_stale");
    // A newer version meanwhile: the fresh plan comes back.
    await save(definition.id, doc("bearer"));
    const second = await plan(id);
    await save(definition.id, withField(doc("bearer")));
    const stale = await apply(id, second);
    expect(stale.statusCode).toBe(409);
    const body = customApiUpdateErrorResponseSchema.parse(stale.json());
    expect(body.error).toBe("custom_api_update_stale");
    expect(body.plan!.toVersion.version).toBe(4);
    expect(await pinnedVersion(id)).toBe(2);
  });

  it("refuses an apply with an unresolved blocker", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, {
      ...doc("bearer"),
      variables: [{ id: "region", label: "Region", secret: false }],
    });
    const offer = await plan(id);
    expect(offer.blockers).toEqual([
      { code: "variable_required", variable: "region", secret: false },
    ]);
    const refused = await apply(id, offer);
    expect(refused.statusCode).toBe(400);
    expect(customApiUpdateErrorResponseSchema.parse(refused.json())).toEqual({
      error: "custom_api_update_blocked",
      blockers: offer.blockers,
    });
    expect(await pinnedVersion(id)).toBe(1);
    const updated = await applied(id, offer, { variables: { region: "eu" } });
    expect(updated.config).toEqual({ region: "eu" });
    // Viewers see the offer but cannot apply it.
    await save(
      definition.id,
      withField({
        ...doc("bearer"),
        variables: [{ id: "region", label: "Region", secret: false }],
      }),
    );
    expect((await apply(id, await plan(id), {}, viewer)).statusCode).toBe(403);
  });

  it.each(Object.keys(LOGINS) as Method[])(
    "keeps the stored secret when the hosts stay the same (%s)",
    async (method) => {
      const definition = await define(doc(method));
      const id = await connect(definition.id, LOGINS[method]);
      const before = await envelope(id);
      await save(definition.id, withField(doc(method)));
      const updated = await applied(id, await plan(id));
      expect(updated.customApi!.loginMissing).toBe(false);
      expect(await envelope(id)).toEqual(before);
    },
  );

  it.each(Object.keys(LOGINS) as Method[])(
    "drops the login when the new version sends it to other hosts (%s)",
    async (method) => {
      const definition = await define(doc(method));
      const id = await connect(definition.id, LOGINS[method]);
      await save(definition.id, moved(doc(method), b));
      const offer = await plan(id);
      expect(offer.login).toEqual({
        carriesOver: false,
        reason: "hosts_changed",
        method: doc(method).auth.type,
      });
      a.reset();
      const updated = await applied(id, offer);
      expect(updated.hasCredentials).toBe(false);
      expect(updated.customApi!.loginMissing).toBe(true);
      expect(await envelope(id)).toBeNull();
      expect((await authState(id)).auth_state).toBe("auth_failed");
      expect(a.requests).toHaveLength(0);
      expect(b.requests).toHaveLength(0);
      // Entering the login again checks it at the new hosts.
      const patched = await t.call("PATCH", ws(`/connections/${id}`), owner, {
        credentials: LOGINS[method],
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(b.requests.length).toBeGreaterThan(0);
      const repaired = await getConnection(id);
      expect(repaired.customApi!.loginMissing).toBe(false);
      expect((await authState(id)).auth_state).toBe("ok");
    },
  );

  it("takes the new login with the update", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, moved(doc("bearer"), b));
    const offer = await plan(id);
    expect(
      (await apply(id, offer, { secrets: { token: "x" } })).statusCode,
    ).toBe(400);
    expect(
      (await apply(id, offer, { secrets: { apiKey: "abcd" } })).statusCode,
    ).toBe(400);
    // Checked at the new host, as a PATCH is: a refused token changes
    // nothing.
    a.reset();
    const refused = await apply(id, offer, {
      secrets: { token: "wrong-token-0001" },
    });
    expect(refused.statusCode).toBe(400);
    expect(b.requests.length).toBeGreaterThan(0);
    expect(await pinnedVersion(id)).toBe(1);
    expect(a.requests).toHaveLength(0);
    const updated = await applied(id, offer, {
      secrets: { token: FIXTURE_SECRETS.token },
    });
    expect(updated.customApi!.loginMissing).toBe(false);
    expect(await envelope(id)).toMatchObject({
      host: new URL(b.origin).host,
      token: FIXTURE_SECRETS.token,
    });
    expect(await auditLogin(id)).toBe("replaced");
  });

  it("audits a token sent on the same hosts as replaced", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, withField(doc("bearer")));
    await applied(id, await plan(id), {
      secrets: { token: FIXTURE_SECRETS.token },
    });
    expect(await auditLogin(id)).toBe("replaced");
    expect(a.requests.length).toBeGreaterThan(0);
  });

  it("audits secret variable values sent on the same hosts as replaced and is healthy again", async () => {
    const keyed: CustomApiDefinition = {
      ...doc("api_key_header"),
      variables: [{ id: "tenant", label: "Tenant secret", secret: true }],
      auth: {
        type: "api_key",
        placement: "header",
        name: "X-Api-Key",
        headers: { "X-Tenant": "{{tenant}}" },
      },
    };
    const definition = await define(keyed);
    const id = await connect(
      definition.id,
      LOGINS.api_key_header,
      {},
      { tenant: "tenant-secret-0001" },
    );
    // The provider refused the old tenant secret.
    await t.admin`update connection_state set auth_state = 'auth_failed'
      where connection_id = ${id}`;
    await save(definition.id, withField(keyed));
    await applied(id, await plan(id), {
      secrets: { tenant: "tenant-secret-0002" },
    });
    expect(await envelope(id)).toMatchObject({
      apiKey: FIXTURE_SECRETS.apiKey,
      variables: { tenant: "tenant-secret-0002" },
    });
    expect(await auditLogin(id)).toBe("replaced");
    expect((await authState(id)).auth_state).toBe("ok");
  });

  it("is healthy again on a version without a login", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, moved(doc("bearer"), b));
    await applied(id, await plan(id));
    expect((await authState(id)).auth_state).toBe("auth_failed");
    await save(definition.id, {
      ...moved(doc("bearer"), b),
      auth: { type: "none" },
    });
    const updated = await applied(id, await plan(id));
    expect(updated.customApi!.loginMissing).toBe(false);
    expect((await authState(id)).auth_state).toBe("ok");
    expect(await auditLogin(id)).toBe("none");
  });

  it("drops a login of another method", async () => {
    const definition = await define(doc("bearer"));
    const id = await connect(definition.id, LOGINS.bearer);
    await save(definition.id, doc("api_key_header"));
    const offer = await plan(id);
    expect(offer.login).toMatchObject({
      carriesOver: false,
      reason: "auth_changed",
    });
    const updated = await applied(id, offer);
    expect(updated.customApi!.loginMissing).toBe(true);
    expect(await envelope(id)).toBeNull();
  });

  it("keeps data of a removed stream", async () => {
    const two = doc("bearer");
    const definition = await define({
      ...two,
      streams: [
        two.streams[0]!,
        { ...two.streams[0]!, key: "copy", name: "Copy" },
      ],
    });
    const id = await connect(definition.id, LOGINS.bearer);
    await createJobHandlers({
      registry: new ConnectorRegistry(),
      credentialKeyring: keyring,
      executeOptions: {
        egress: { tlsCa: a.ca!, allowPrivateHosts: ["127.0.0.1"] },
      },
    })["connection.backfill"]!({
      job: {
        id: randomUUID(),
        kind: "connection.backfill",
        workspaceId,
        connectionId: id,
        attempts: 0,
        payload: {},
      } as unknown as Job,
      appDb: t.db,
      schedulerDb: t.db,
      logger: pino({ level: "silent" }),
    });
    const counts = () => t.admin<{ key: string; n: number }[]>`
      select d.key, count(r.*)::int as n from data_datasets d
      join data_generations g on g.dataset_id = d.id
      join data_records r on r.generation_id = g.id
      where d.connection_id = ${id}
      group by d.key order by d.key`;
    const before = await counts();
    expect(before.map((row) => row.key)).toEqual(["copy", "items"]);
    expect(before.every((row) => row.n > 0)).toBe(true);
    await save(definition.id, doc("bearer"));
    const offer = await plan(id);
    expect(offer.changes).toEqual([{ kind: "stream_removed", stream: "copy" }]);
    await applied(id, offer);
    expect(await counts()).toEqual(before);
  });
});

describe("custom API connection updates with OAuth", () => {
  const client = {
    clientId: FIXTURE_OAUTH_CLIENT.clientId,
    clientSecret: FIXTURE_OAUTH_CLIENT.clientSecret,
  };

  it("keeps a client-credentials grant on the same hosts and drops it on others", async () => {
    const definition = await define(doc("oauth_client_credentials"));
    const id = await connect(definition.id, client);
    const before = await envelope(id);
    const sub = (await grant(id))!.account_sub;
    await save(definition.id, withField(doc("oauth_client_credentials")));
    await applied(id, await plan(id));
    expect(await envelope(id)).toEqual(before);
    expect((await grant(id))!.account_sub).toBe(sub);

    await save(definition.id, moved(doc("oauth_client_credentials"), b));
    const offer = await plan(id);
    expect(offer.login).toEqual({
      carriesOver: false,
      reason: "hosts_changed",
      method: "oauth_client_credentials",
    });
    // The client goes through the connection's client form, not the update.
    expect((await apply(id, offer, { secrets: client })).statusCode).toBe(400);
    const tokens = b.oauth.tokenRequests.length;
    const updated = await applied(id, offer);
    expect(updated.customApi!.loginMissing).toBe(true);
    expect(updated.oauth).toBeNull();
    expect(await envelope(id)).toBeNull();
    expect(await grant(id)).toBeNull();
    expect((await authState(id)).auth_state).toBe("auth_failed");
    expect(b.oauth.tokenRequests.length).toBe(tokens);
    // A client entered again mints at the new token URL.
    const patched = await t.call("PATCH", ws(`/connections/${id}`), owner, {
      credentials: client,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(b.oauth.tokenRequests.length).toBeGreaterThan(tokens);
    expect((await authState(id)).auth_state).toBe("ok");
    expect(await envelope(id)).toMatchObject({
      host: new URL(b.origin).host,
      clientId: client.clientId,
    });
  });

  it("keeps an authorization-code grant on the same hosts and revokes it when they change", async () => {
    const definition = await define(doc("oauth_code"));
    const id = await connect(definition.id, client);
    await signIn(id);
    const refresh = (await envelope(id))!.refreshToken as string;
    expect(refresh).toBeTruthy();
    await save(definition.id, withField(doc("oauth_code")));
    await applied(id, await plan(id));
    expect((await envelope(id))!.refreshToken).toBe(refresh);
    expect(await grant(id)).not.toBeNull();

    await save(definition.id, moved(doc("oauth_code"), b));
    const offer = await plan(id);
    expect(offer.login.reason).toBe("hosts_changed");
    const updated = await applied(id, offer);
    expect(updated.customApi!.loginMissing).toBe(true);
    expect(await envelope(id)).toBeNull();
    expect(await grant(id)).toBeNull();
    // Revoked where it was issued, never sent to the new hosts.
    expect(a.oauth.revoked).toContain(refresh);
    expect(b.oauth.revoked).not.toContain(refresh);
    expect(JSON.stringify(b.oauth.tokenRequests)).not.toContain(refresh);
    // The client again, then a sign-in.
    const patched = await t.call("PATCH", ws(`/connections/${id}`), owner, {
      credentials: client,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await authState(id)).toEqual({
      auth_state: "needs_reauthorization",
      auth_reason: "invalid_grant",
    });
    const started = await t.call("POST", ws("/oauth/authorizations"), owner, {
      connectorId: "custom-api",
      connectionId: id,
    });
    expect(started.statusCode, started.body).toBe(200);
    const start = startOAuthAuthorizationResponseSchema.parse(started.json());
    expect(new URL(start.authorizationUrl).origin).toBe(b.origin);
  });
  it("refuses a client change validated before an update moved the pin", async () => {
    // The race of a client PATCH with an update apply: the change was
    // prepared on version 1's hosts; the apply moved the connection to
    // version 2 before the change took its locks.
    const definition = await define(doc("oauth_code"));
    const id = await connect(definition.id, client);
    const before = await envelope(id);
    const egress = {
      tlsCa: `${a.ca!}\n${b.ca!}`,
      allowPrivateHosts: ["127.0.0.1"],
    };
    const tokens = createOAuthTokenService({
      db: t.db,
      credentialKeyring: keyring,
      providers: new OAuthProviders([]),
      logger: pino({ level: "silent" }),
      customOAuth: createCustomOAuthResolver({
        credentialKeyring: keyring,
        webOrigin: "http://localhost:3000",
        egress,
      }),
    });
    const actor = { workspaceId, callerId: await callerId() };
    const existing = (await withWorkspace(t.db, actor, (tx) =>
      findConnection(tx, workspaceId, id),
    ))!;
    const prepared = await prepareCustomOAuthClientChange({
      db: t.db,
      credentialKeyring: keyring,
      oauthTokens: tokens,
      actor,
      existing,
      resolved: connectorFor(new ConnectorRegistry(), existing)!,
      credentials: { clientId: "other-client", clientSecret: "other-secret" },
      privateHosts: [],
    });
    expect(prepared.ok).toBe(true);
    await save(definition.id, moved(doc("oauth_code"), b));
    await applied(id, await plan(id));
    const dropped = await envelope(id);
    await expect(
      withWorkspace(t.db, actor, (tx) =>
        (prepared as { ok: true; value: CustomOAuthClientChange }).value.apply(
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: "custom_api_credentials_host_changed" });
    expect(await envelope(id)).toEqual(dropped);
    expect(dropped).toBeNull();
    expect(before).not.toBeNull();
  });
});
