import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionDetailResponseSchema,
  connectionResourcesResponseSchema,
  connectionResponseSchema,
  createWorkspaceResponseSchema,
  oauthCallbackResponseSchema,
  startOAuthAuthorizationResponseSchema,
  workspaceListResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorManifest } from "@netrics/connector-sdk";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import {
  FixtureOAuthProvider,
  type FixtureAccount,
} from "./oauth/test-provider.js";
import { syncCatalog } from "./sync/catalog.js";
import { createTestDatabase } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";

// Finishing the setup of an OAuth connection (ADR 0012, #136): discovering
// what the linked account can read with a host-issued access token, and the
// first checked config scheduling the connection and queueing its backfill
// in one commit.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const CLIENT_ID = "netrics-setup-test.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-setup-test-secret";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const CONNECTOR_ID = "properties-test";
const SITE = "sc-domain:example.com";

const fixture = new FixtureOAuthProvider({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
});

/** What the connector received as credentials, per call. */
const received: Array<{ call: string; credentials: Record<string, unknown> }> =
  [];

// A Search Console-shaped connector: discover lists two properties, check
// needs a property. Values come from the demo connector.
const manifest: ConnectorManifest = {
  ...demoManifest,
  id: CONNECTOR_ID,
  name: "Properties (test)",
  sdkVersion: "^0.2.1",
  authStrategies: [{ strategy: "oauth2", provider: "google", scopes: [SCOPE] }],
  configSchema: {
    type: "object",
    properties: {
      siteUrl: { type: "string" },
      dimensions: { type: "string", enum: ["none", "query"], default: "none" },
      rowLimit: { type: "integer", minimum: 1, maximum: 5000, default: 1000 },
    },
    additionalProperties: false,
  },
};

function propertiesConnector(): Connector {
  const demo = createDemoConnector();
  return {
    ...demo,
    manifest,
    async check(context) {
      received.push({ call: "check", credentials: { ...context.credentials } });
      return typeof context.config.siteUrl === "string"
        ? { ok: true }
        : { ok: false, message: "Choose a property to finish setup." };
    },
    async discover(context) {
      received.push({
        call: "discover",
        credentials: { ...context.credentials },
      });
      return [
        {
          id: SITE,
          name: "example.com",
          kind: "domain_property",
          metadata: { siteUrl: SITE, permissionLevel: "siteOwner" },
        },
        {
          id: "https://example.org/",
          name: "https://example.org/",
          kind: "url_prefix_property",
          metadata: {
            siteUrl: "https://example.org/",
            permissionLevel: "siteRestrictedUser",
          },
        },
      ];
    },
  };
}

function registry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(createDemoConnector());
  registry.register(propertiesConnector());
  return registry;
}

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let workspaceId: string;
let otherWorkspaceId: string;
const cookies = {} as Record<
  "owner" | "editor" | "viewer" | "outsider",
  string
>;
let accountCounter = 0;

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

function inject(
  method: "GET" | "POST" | "PATCH",
  url: string,
  cookie: string,
  payload?: Record<string, unknown>,
): Promise<InjectResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

/** A new connection in the setup state, for a fresh Google account. */
async function connect(workspace = workspaceId): Promise<{
  id: string;
  account: FixtureAccount;
}> {
  accountCounter += 1;
  const account = {
    sub: `setup-sub-${accountCounter}`,
    email: `setup-${accountCounter}@example.com`,
  };
  const started = await inject(
    "POST",
    `/v1/workspaces/${workspace}/oauth/authorizations`,
    cookies.owner,
    { connectorId: CONNECTOR_ID },
  );
  expect(started.statusCode, started.body).toBe(200);
  const { authorizationUrl } = startOAuthAuthorizationResponseSchema.parse(
    started.json(),
  );
  const done = await inject(
    "POST",
    "/v1/oauth/google/callback",
    cookies.owner,
    fixture.consent(authorizationUrl, { account }),
  );
  const result = oauthCallbackResponseSchema.parse(done.json());
  expect(result.outcome).toBe("connected");
  const id = new URL(result.redirectTo, "http://app").searchParams.get(
    "connection",
  )!;
  return { id, account };
}

const resourcesUrl = (id: string, workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/connections/${id}/resources`;
const connectionUrl = (id: string, workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/connections/${id}`;

async function setupState(id: string) {
  const [row] = await admin`
    select c.setup_pending, c.config, s.next_due_at,
      (select count(*)::int from jobs j where j.connection_id = c.id) as jobs,
      (select count(*)::int from audit_events a
        where a.target = c.id::text and a.action = 'connection.setup_finished')
        as finished
    from connections c join connection_state s on s.connection_id = c.id
    where c.id = ${id}`;
  return row as {
    setup_pending: boolean;
    config: Record<string, unknown>;
    next_due_at: Date | null;
    jobs: number;
    finished: number;
  };
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const owner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(owner, registry());
  await owner.$client.end({ timeout: 5 });

  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    NETRICS_OAUTH_GOOGLE_CLIENT_ID: CLIENT_ID,
    NETRICS_OAUTH_GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  });
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    registry: registry(),
    checkDb: async () => true,
    oauthHttp: () => fixture.http,
    logger: pino({ level: "silent" }),
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  cookies.owner = await signUp("setup-owner@example.com");
  expect(
    (
      await inject("POST", "/v1/bootstrap", cookies.owner, {
        workspaceName: "Setup",
      })
    ).statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await inject("GET", "/v1/workspaces", cookies.owner)).json(),
  ).workspaces[0]!.id;
  otherWorkspaceId = createWorkspaceResponseSchema.parse(
    (
      await inject("POST", "/v1/workspaces", cookies.owner, { name: "Other" })
    ).json(),
  ).workspace.id;

  for (const role of ["editor", "viewer"] as const) {
    const email = `setup-${role}@example.com`;
    cookies[role] = await signUp(email);
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
  cookies.outsider = await signUp("setup-outsider@example.com");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

describe("discovering resources of an OAuth connection", () => {
  it("lists them with a host-issued access token and returns no token material", async () => {
    const { id } = await connect();
    received.length = 0;
    const response = await inject("GET", resourcesUrl(id), cookies.editor);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { resources } = connectionResourcesResponseSchema.parse(
      response.json(),
    );
    expect(resources.map((resource) => resource.id)).toEqual([
      SITE,
      "https://example.org/",
    ]);
    expect(resources[0]!.metadata).toEqual({
      siteUrl: SITE,
      permissionLevel: "siteOwner",
    });

    // The connector got an access token the provider issued, and nothing
    // else: no refresh token, client secret or code.
    expect(received).toHaveLength(1);
    const { credentials } = received[0]!;
    expect(Object.keys(credentials)).toEqual(["accessToken"]);
    expect(fixture.accessTokens).toContain(credentials.accessToken);
    for (const secret of [...fixture.secrets, CLIENT_SECRET]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it("needs connections:update and stays inside the workspace", async () => {
    const { id } = await connect();
    expect(
      (await inject("GET", resourcesUrl(id), cookies.viewer)).statusCode,
    ).toBe(403);
    expect(
      (await inject("GET", resourcesUrl(id), cookies.outsider)).statusCode,
    ).toBe(404);
    // The owner of both workspaces, asking through the other one.
    const crossed = await inject(
      "GET",
      resourcesUrl(id, otherWorkspaceId),
      cookies.owner,
    );
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json()).toEqual({ error: "connection_not_found" });
    expect(
      (await inject("GET", resourcesUrl("not-a-uuid"), cookies.owner))
        .statusCode,
    ).toBe(404);
  });

  it("refuses connections without an OAuth grant", async () => {
    const created = await inject(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      cookies.owner,
      { connectorId: "demo", name: "Demo", config: {} },
    );
    expect(created.statusCode, created.body).toBe(200);
    const { connection } = connectionResponseSchema.parse(created.json());
    const response = await inject(
      "GET",
      resourcesUrl(connection.id),
      cookies.owner,
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "oauth_connection_required" });
  });

  it("asks for reauthorization when the grant is gone", async () => {
    const { id, account } = await connect();
    fixture.revokeAccount(account.sub);
    // The cached access token has run out; the refresh meets invalid_grant.
    await admin`
      update connection_oauth set access_token_expires_at = now() - interval '1 minute'
      where connection_id = ${id}`;
    received.length = 0;
    const response = await inject("GET", resourcesUrl(id), cookies.owner);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "oauth_reauthorization_required",
    });
    expect(received).toHaveLength(0);
    const detail = connectionDetailResponseSchema.parse(
      (await inject("GET", connectionUrl(id), cookies.owner)).json(),
    );
    expect(detail.connection.state).toMatchObject({
      authState: "needs_reauthorization",
      authReason: "invalid_grant",
    });
  });
});

describe("finishing setup", () => {
  const finish = (id: string, cookie = cookies.editor) =>
    inject("PATCH", connectionUrl(id), cookie, {
      config: { siteUrl: SITE, dimensions: "query", rowLimit: 500 },
    });

  it("schedules the connection and queues its backfill with the checked config", async () => {
    const { id } = await connect();
    expect(await setupState(id)).toMatchObject({
      setup_pending: true,
      next_due_at: null,
      jobs: 0,
    });

    received.length = 0;
    const response = await finish(id);
    expect(response.statusCode, response.body).toBe(200);
    const { connection } = connectionResponseSchema.parse(response.json());
    expect(connection.setupPending).toBe(false);
    expect(connection.state.nextDueAt).not.toBeNull();
    expect(connection.config).toEqual({
      siteUrl: SITE,
      dimensions: "query",
      rowLimit: 500,
    });
    // Checked with an access token, like discovery.
    expect(received.map((entry) => entry.call)).toEqual(["check"]);
    expect(Object.keys(received[0]!.credentials)).toEqual(["accessToken"]);

    const state = await setupState(id);
    expect(state).toMatchObject({ setup_pending: false, jobs: 1, finished: 1 });
    expect(state.next_due_at).not.toBeNull();
    const [job] = await admin`
      select kind, status, idempotency_key from jobs where connection_id = ${id}`;
    expect(job).toMatchObject({
      kind: "connection.backfill",
      status: "pending",
      idempotency_key: `backfill:${id}`,
    });

    // A later config change is an ordinary edit: no second backfill.
    const again = await inject("PATCH", connectionUrl(id), cookies.owner, {
      config: { siteUrl: "https://example.org/" },
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(await setupState(id)).toMatchObject({ jobs: 1, finished: 1 });

    const sync = await inject(
      "POST",
      `${connectionUrl(id)}/sync`,
      cookies.owner,
      {},
    );
    expect(sync.statusCode, sync.body).toBe(200);
  });

  it("changes nothing when the check fails, the role is missing or only the name changes", async () => {
    const { id } = await connect();
    const unchecked = await inject("PATCH", connectionUrl(id), cookies.owner, {
      config: { dimensions: "query" },
    });
    expect(unchecked.statusCode).toBe(400);
    expect(unchecked.json()).toEqual({
      error: "Choose a property to finish setup.",
    });
    expect((await finish(id, cookies.viewer)).statusCode).toBe(403);
    expect((await finish(id, cookies.outsider)).statusCode).toBe(404);
    const crossed = await inject(
      "PATCH",
      connectionUrl(id, otherWorkspaceId),
      cookies.owner,
      { config: { siteUrl: SITE } },
    );
    expect(crossed.statusCode).toBe(404);
    const renamed = await inject("PATCH", connectionUrl(id), cookies.owner, {
      name: "Renamed",
    });
    expect(renamed.statusCode).toBe(200);
    expect(await setupState(id)).toMatchObject({
      setup_pending: true,
      config: {},
      next_due_at: null,
      jobs: 0,
      finished: 0,
    });
  });

  it("finishes once when two saves race", async () => {
    for (let round = 0; round < 5; round += 1) {
      const { id } = await connect();
      const responses = await Promise.all([finish(id), finish(id)]);
      for (const response of responses) {
        expect(response.statusCode, response.body).toBe(200);
      }
      expect(await setupState(id)).toMatchObject({
        setup_pending: false,
        jobs: 1,
        finished: 1,
      });
    }
  });

  it("rolls back the config and setup state when queueing the backfill fails", async () => {
    const { id } = await connect();
    await admin.unsafe(`
      create function refuse_setup_job() returns trigger language plpgsql as $$
      begin
        if new.connection_id = '${id}' then
          raise exception 'refused by the test';
        end if;
        return new;
      end $$;
      create trigger refuse_setup_job before insert on jobs
        for each row execute function refuse_setup_job();`);
    try {
      const response = await finish(id);
      expect(response.statusCode).toBe(500);
      expect(await setupState(id)).toMatchObject({
        setup_pending: true,
        config: {},
        next_due_at: null,
        jobs: 0,
        finished: 0,
      });
    } finally {
      await admin.unsafe(`
        drop trigger refuse_setup_job on jobs;
        drop function refuse_setup_job();`);
    }
    const retried = await finish(id);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await setupState(id)).toMatchObject({
      setup_pending: false,
      jobs: 1,
      finished: 1,
    });
  });
});
