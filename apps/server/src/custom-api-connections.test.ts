import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionListResponseSchema,
  connectionResponseSchema,
  customApiDefinitionResponseSchema,
  customApiErrorResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { CUSTOM_API_MESSAGES } from "@netrics/connectors/custom-api";
import {
  FIXTURE_SECRETS,
  fixtureDefinition,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
} from "@netrics/connectors/custom-api/testing";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { randomUUID } from "node:crypto";

import type { Job } from "@netrics/database";

import { buildApp } from "./app.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring, decryptCredentials } from "./credentials.js";
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Connections from a custom API definition (#804): pinned version and
// environment, checked credentials bound to the environment host, never
// returned; the generic connection routes refuse custom-api.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const KEY = Buffer.alloc(32, 7).toString("base64");

let fixture: CustomApiFixtureServer;
let app: FastifyInstance;
let limitedApp: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let viewer: string;
let workspaceId: string;

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  cookie: string | null,
  payload?: unknown,
  target: FastifyInstance = app,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  };
  return target.inject(options);
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

async function newWorkspace(cookie: string): Promise<string> {
  const response = await call("POST", "/v1/workspaces", cookie, {
    name: "Custom API connections",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

const defs = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/custom-api/definitions`;

/** The api-key fixture with a plain and a secret connection variable. */
function keyed(): CustomApiDefinition {
  const base = fixtureDefinition("api_key_header", fixture.origin);
  return {
    ...base,
    variables: [
      { id: "account_id", label: "Account", secret: false },
      { id: "tenant", label: "Tenant secret", secret: true },
    ],
    auth: {
      type: "api_key",
      placement: "header",
      name: "X-Api-Key",
      headers: { "X-Tenant": "{{tenant}}" },
    },
  };
}

async function createDefinition(
  document: CustomApiDefinition = keyed(),
  workspace = workspaceId,
  target = app,
) {
  const response = await call(
    "POST",
    defs(workspace),
    owner,
    { document },
    target,
  );
  expect(response.statusCode).toBe(201);
  return customApiDefinitionResponseSchema.parse(response.json()).definition;
}

const body = (extra: Record<string, unknown> = {}) => ({
  name: "Shop production",
  environmentId: "production",
  variables: { account_id: "acc-1" },
  secretVariables: { tenant: "tenant-secret-0001" },
  credentials: { apiKey: FIXTURE_SECRETS.apiKey },
  ...extra,
});

async function connect(
  definitionId: string,
  extra: Record<string, unknown> = {},
  workspace = workspaceId,
  target = app,
) {
  return call(
    "POST",
    `${defs(workspace)}/${definitionId}/connections`,
    owner,
    body(extra),
    target,
  );
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error).toBe(error);
}

async function connectionCount(workspace = workspaceId): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from connections
    where workspace_id = ${workspace} and connector_id = 'custom-api'`;
  return row!.n;
}

beforeAll(async () => {
  fixture = await startCustomApiFixtureServer({ tls: true });
  const testDb = await createTestDatabase();
  const env = {
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: KEY,
  };
  const executeOptions = {
    egress: { tlsCa: fixture.ca!, allowPrivateHosts: ["127.0.0.1"] },
  };
  const config = loadConfig(env);
  db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    executeOptions,
  });
  const limitedConfig = loadConfig({
    ...env,
    NETRICS_CUSTOM_API_MAX_CONNECTIONS: "1",
  });
  limitedApp = await buildApp(limitedConfig, {
    db,
    authService: createAuthService(limitedConfig, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
    executeOptions,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("custom-conn-owner@example.com");
  viewer = await signUp("custom-conn-viewer@example.com");
  workspaceId = await newWorkspace(owner);
  const added = await addMemberViaInvitation(
    app,
    db,
    owner,
    workspaceId,
    "custom-conn-viewer@example.com",
    "viewer",
  );
  expect(added.statusCode).toBe(200);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await limitedApp?.close();
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  await fixture?.close();
});

describe("connections from a custom API definition", () => {
  it("creates two connections of one definition with different environments and lists them with the definition's name", async () => {
    const definition = await createDefinition();
    const production = await connect(definition.id);
    expect(production.statusCode, production.body).toBe(201);
    const staging = await connect(definition.id, {
      name: "Shop staging",
      environmentId: "staging",
    });
    expect(staging.statusCode, staging.body).toBe(201);
    const created = connectionResponseSchema.parse(staging.json()).connection;
    expect(created).toMatchObject({
      connectorId: "custom-api",
      connectorName: "Fixture api_key_header",
      hasCredentials: true,
      config: { account_id: "acc-1" },
      customApi: {
        definitionId: definition.id,
        version: 1,
        environmentId: "staging",
        environmentName: "Staging",
      },
    });
    const list = connectionListResponseSchema.parse(
      (
        await call("GET", `/v1/workspaces/${workspaceId}/connections`, owner)
      ).json(),
    );
    const ours = list.connections.filter(
      (connection) => connection.customApi?.definitionId === definition.id,
    );
    expect(
      ours.map((connection) => connection.customApi?.environmentId),
    ).toEqual(["production", "staging"]);
    expect(new Set(ours.map((c) => c.connectorName))).toEqual(
      new Set(["Fixture api_key_header"]),
    );
    // The envelope: bound to the environment host, secret variables in it.
    const [row] = await admin<
      { credentials_encrypted: Buffer; poll_interval_seconds: number }[]
    >`
      select c.credentials_encrypted, s.poll_interval_seconds
      from connections c join connection_state s on s.connection_id = c.id
      where c.id = ${created.id}`;
    const envelope = JSON.parse(
      decryptCredentials(
        row!.credentials_encrypted.toString("utf8"),
        createCredentialKeyring(KEY),
        { workspaceId, connectionId: created.id },
      ),
    );
    expect(envelope).toEqual({
      host: `127.0.0.1:${fixture.port}`,
      apiKey: FIXTURE_SECRETS.apiKey,
      variables: { tenant: "tenant-secret-0001" },
    });
    expect(row!.poll_interval_seconds).toBe(3600);
    const [audit] = await admin<{ metadata: Record<string, unknown> }[]>`
      select metadata from audit_events
      where target = ${created.id} and action = 'connection.created'`;
    expect(audit!.metadata).toMatchObject({
      connectorId: "custom-api",
      definitionId: definition.id,
      version: 1,
      environmentId: "staging",
    });
    const [job] = await admin<{ kind: string }[]>`
      select kind from jobs where connection_id = ${created.id}`;
    expect(job!.kind).toBe("connection.backfill");
  });

  it("refuses wrong credentials with the 401 message and stores nothing", async () => {
    const definition = await createDefinition();
    const before = await connectionCount();
    const response = await connect(definition.id, {
      credentials: { apiKey: "wrong-key-0001" },
    });
    expectError(response, 400, CUSTOM_API_MESSAGES.unauthorized);
    expect(await connectionCount()).toBe(before);
  });

  it("refuses missing or extra variables and wrong credentials shapes", async () => {
    const definition = await createDefinition();
    expectError(
      await connect(definition.id, { variables: {} }),
      400,
      "custom_api_variables_invalid",
    );
    expectError(
      await connect(definition.id, {
        variables: { account_id: "a", extra: "b" },
      }),
      400,
      "custom_api_variables_invalid",
    );
    expectError(
      await connect(definition.id, { secretVariables: {} }),
      400,
      "custom_api_variables_invalid",
    );
    expectError(
      await connect(definition.id, { credentials: { token: "t0k3n-0001" } }),
      400,
      "custom_api_credentials_invalid",
    );
    expectError(
      await connect(definition.id, { environmentId: "nope" }),
      400,
      "custom_api_environment_not_found",
    );
    expectError(
      await connect(definition.id, { version: 9 }),
      404,
      "custom_api_definition_not_found",
    );
    expectError(
      await connect("00000000-0000-4000-8000-000000000009"),
      404,
      "custom_api_definition_not_found",
    );
  });

  it("refuses OAuth definitions until custom OAuth exists", async () => {
    const base = fixtureDefinition("pages", fixture.origin);
    const definition = await createDefinition({
      ...base,
      auth: {
        type: "oauth_client_credentials",
        tokenUrl: `${fixture.origin}/oauth/token`,
        scopes: [],
        clientAuth: "body",
      },
    });
    expectError(
      await connect(definition.id, {
        variables: {},
        secretVariables: {},
        credentials: { clientId: "c", clientSecret: "s" },
      }),
      400,
      "custom_api_oauth_unavailable",
    );
  });

  it("pins the current version and its dataset versions", async () => {
    const definition = await createDefinition();
    const changed = keyed();
    changed.streams[0]!.fields.push({
      id: "label",
      name: "Label",
      path: "name",
      type: "string",
      nullable: true,
      classification: "internal",
    });
    const next = await call(
      "POST",
      `${defs()}/${definition.id}/versions`,
      owner,
      {
        baseVersion: 1,
        document: changed,
      },
    );
    expect(next.statusCode).toBe(201);
    const response = await connect(definition.id);
    expect(response.statusCode, response.body).toBe(201);
    const created = connectionResponseSchema.parse(response.json()).connection;
    expect(created.customApi?.version).toBe(2);
    const [pin] = await admin<{ version: number; dataset_versions: unknown }[]>`
      select v.version, v.dataset_versions from connections c
      join custom_api_definition_versions v
        on v.id = c.custom_api_definition_version_id
      where c.id = ${created.id}`;
    expect(pin).toEqual({ version: 2, dataset_versions: { items: 2 } });
    // An explicit older version pins that one.
    const older = await connect(definition.id, { version: 1 });
    expect(
      connectionResponseSchema.parse(older.json()).connection.customApi
        ?.version,
    ).toBe(1);
  });

  it("never returns credentials or secret variables", async () => {
    const definition = await createDefinition();
    const created = connectionResponseSchema.parse(
      (await connect(definition.id)).json(),
    ).connection;
    for (const response of [
      await call(
        "GET",
        `/v1/workspaces/${workspaceId}/connections/${created.id}`,
        owner,
      ),
      await call("GET", `/v1/workspaces/${workspaceId}/connections`, owner),
    ]) {
      const text = response.body;
      for (const secret of [
        ...Object.values(FIXTURE_SECRETS),
        "tenant-secret-0001",
      ])
        expect(text).not.toContain(secret);
    }
  });

  it("refuses an environment change without every secret and accepts it with them", async () => {
    const definition = await createDefinition();
    const created = connectionResponseSchema.parse(
      (await connect(definition.id)).json(),
    ).connection;
    const url = `/v1/workspaces/${workspaceId}/connections/${created.id}`;
    const envelope = async () => {
      const [row] = await admin<{ credentials_encrypted: Buffer }[]>`
        select credentials_encrypted from connections where id = ${created.id}`;
      return JSON.parse(
        decryptCredentials(
          row!.credentials_encrypted.toString("utf8"),
          createCredentialKeyring(KEY),
          { workspaceId, connectionId: created.id },
        ),
      ) as Record<string, unknown>;
    };
    expectError(
      await call("PATCH", url, owner, { customApiEnvironmentId: "staging" }),
      400,
      "custom_api_environment_needs_credentials",
    );
    // Stored secret variables never move to another environment's host.
    expectError(
      await call("PATCH", url, owner, {
        customApiEnvironmentId: "staging",
        credentials: { apiKey: FIXTURE_SECRETS.apiKey },
      }),
      400,
      "custom_api_environment_needs_credentials",
    );
    expectError(
      await call("PATCH", url, owner, {
        customApiEnvironmentId: "staging",
        secretVariables: { tenant: "tenant-secret-0002" },
      }),
      400,
      "custom_api_environment_needs_credentials",
    );
    expectError(
      await call("PATCH", url, owner, {
        customApiEnvironmentId: "staging",
        credentials: { apiKey: FIXTURE_SECRETS.apiKey },
        secretVariables: { other: "x" },
      }),
      400,
      "custom_api_variables_invalid",
    );
    expectError(
      await call("PATCH", url, owner, {
        customApiEnvironmentId: "nope",
        credentials: { apiKey: FIXTURE_SECRETS.apiKey },
        secretVariables: { tenant: "tenant-secret-0002" },
      }),
      400,
      "custom_api_environment_not_found",
    );
    expectError(
      await call("PATCH", url, owner, {
        customApiEnvironmentId: "staging",
        credentials: { apiKey: "wrong-key-0001" },
        secretVariables: { tenant: "tenant-secret-0002" },
      }),
      400,
      CUSTOM_API_MESSAGES.unauthorized,
    );
    expect((await envelope()).variables).toEqual({
      tenant: "tenant-secret-0001",
    });
    const moved = await call("PATCH", url, owner, {
      customApiEnvironmentId: "staging",
      credentials: { apiKey: FIXTURE_SECRETS.apiKey },
      secretVariables: { tenant: "tenant-secret-0002" },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(
      connectionResponseSchema.parse(moved.json()).connection.customApi,
    ).toMatchObject({ environmentId: "staging", environmentName: "Staging" });
    expect(await envelope()).toEqual({
      host: `127.0.0.1:${fixture.port}`,
      apiKey: FIXTURE_SECRETS.apiKey,
      variables: { tenant: "tenant-secret-0002" },
    });
    // On the same environment, new credentials keep the secret variables.
    const rotated = await call("PATCH", url, owner, {
      credentials: { apiKey: FIXTURE_SECRETS.apiKey },
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect((await envelope()).variables).toEqual({
      tenant: "tenant-secret-0002",
    });
    // Credentials of another login method, or a host of their own, are refused.
    for (const credentials of [
      { token: "t0k3n-0001" },
      { apiKey: FIXTURE_SECRETS.apiKey, host: "evil.example.com" },
    ])
      expectError(
        await call("PATCH", url, owner, { credentials }),
        400,
        "custom_api_credentials_invalid",
      );
    expectError(
      await connect(definition.id, {
        credentials: {
          apiKey: FIXTURE_SECRETS.apiKey,
          host: "evil.example.com",
        },
      }),
      400,
      "custom_api_credentials_invalid",
    );
  });

  it("previews a stored connection with the custom API egress and redaction", async () => {
    const bearer = {
      type: "bearer" as const,
      headerName: "Authorization",
      prefix: "Bearer",
    };
    const definition = await createDefinition({
      ...fixtureDefinition("pages", fixture.origin),
      auth: bearer,
    });
    const created = connectionResponseSchema.parse(
      (
        await call("POST", `${defs()}/${definition.id}/connections`, owner, {
          name: "Redirecting",
          environmentId: "production",
          credentials: { token: FIXTURE_SECRETS.token },
        })
      ).json(),
    ).connection;
    // The API now redirects to another host: version 2, pinned by hand.
    const next = await call(
      "POST",
      `${defs()}/${definition.id}/versions`,
      owner,
      {
        baseVersion: 1,
        document: {
          ...fixtureDefinition("redirect_off_host", fixture.origin),
          auth: bearer,
        },
      },
    );
    expect(next.statusCode, next.body).toBe(201);
    await admin`
      update connections set custom_api_definition_version_id = (
        select id from custom_api_definition_versions
        where definition_id = ${definition.id} and version = 2)
      where id = ${created.id}`;
    // The fixture now answers the check, then the stored preview: the
    // redirect to another host is refused there too, and nothing reaches it.
    fixture.reset();
    const preview = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections/${created.id}/preview`,
      owner,
      { config: {} },
    );
    expect(preview.statusCode).toBe(400);
    expect(preview.body).toContain("egress denied");
    expect(preview.body).not.toContain("call options");
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(fixture.requests.every((r) => r.host.startsWith("127.0.0.1:"))).toBe(
      true,
    );
    expect(preview.body).not.toContain(FIXTURE_SECRETS.token);

    // The API echoing the key: the preview's error carries none.
    const echoing = await createDefinition(
      fixtureDefinition("api_key_query_400", fixture.origin),
    );
    const stored = await call(
      "POST",
      `${defs()}/${echoing.id}/connections`,
      owner,
      {
        name: "Echo",
        environmentId: "production",
        credentials: { apiKey: FIXTURE_SECRETS.apiKey },
      },
    );
    expect(stored.statusCode).toBe(400);
    expect(stored.body).toContain("api_key=[redacted]");
    expect(stored.body).not.toContain(FIXTURE_SECRETS.apiKey);
  });

  it("refuses custom-api on the generic create, batch and preview routes", async () => {
    const base = `/v1/workspaces/${workspaceId}/connections`;
    expectError(
      await call("POST", base, owner, { connectorId: "custom-api", name: "x" }),
      400,
      "custom_api_requires_definition",
    );
    expectError(
      await call("POST", `${base}/batch`, owner, {
        connectorId: "custom-api",
        connections: [{ name: "x" }],
      }),
      400,
      "custom_api_requires_definition",
    );
    expectError(
      await call("POST", `${base}/preview`, owner, {
        connectorId: "custom-api",
      }),
      400,
      "custom_api_requires_definition",
    );
    const catalog = await call("GET", "/v1/connectors", owner);
    expect(
      (catalog.json() as { connectors: { id: string }[] }).connectors.map(
        (c) => c.id,
      ),
    ).not.toContain("custom-api");
  });

  it("applies the instance minimum refresh interval", async () => {
    const definition = await createDefinition();
    const created = connectionResponseSchema.parse(
      (await connect(definition.id, { refreshMinutes: 1 })).json(),
    ).connection;
    expect(created.state.pollIntervalSeconds).toBe(900);
    const slower = connectionResponseSchema.parse(
      (await connect(definition.id, { refreshMinutes: 120 })).json(),
    ).connection;
    expect(slower.state.pollIntervalSeconds).toBe(7200);
  });

  it("enforces the connection limit", async () => {
    const workspace = await newWorkspace(owner);
    const definition = await createDefinition(keyed(), workspace, limitedApp);
    const first = await connect(definition.id, {}, workspace, limitedApp);
    expect(first.statusCode, first.body).toBe(201);
    const second = await connect(definition.id, {}, workspace, limitedApp);
    expectError(second, 409, "custom_api_connection_limit");
    // Deleted connections and other workspaces' connections do not count.
    const firstId = connectionResponseSchema.parse(first.json()).connection.id;
    const removed = await call(
      "DELETE",
      `/v1/workspaces/${workspace}/connections/${firstId}`,
      owner,
      undefined,
      limitedApp,
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const third = await connect(definition.id, {}, workspace, limitedApp);
    expect(third.statusCode, third.body).toBe(201);
    expect(customApiErrorResponseSchema.parse(second.json()).error).toBe(
      "custom_api_connection_limit",
    );
  });

  it("lets viewers see the connection's customApi view but not create", async () => {
    const definition = await createDefinition();
    const created = connectionResponseSchema.parse(
      (await connect(definition.id)).json(),
    ).connection;
    const seen = await call(
      "GET",
      `/v1/workspaces/${workspaceId}/connections/${created.id}`,
      viewer,
    );
    expect(seen.statusCode).toBe(200);
    expect(seen.json().connection.customApi).toMatchObject({
      definitionId: definition.id,
      environmentId: "production",
    });
    const refused = await call(
      "POST",
      `${defs()}/${definition.id}/connections`,
      viewer,
      body(),
    );
    expect(refused.statusCode).toBe(403);
  });

  it("stores no echoed API key in cursors and shows viewers none", async () => {
    const definition = await createDefinition(
      fixtureDefinition("api_key_query_echo", fixture.origin),
    );
    const response = await call(
      "POST",
      `${defs()}/${definition.id}/connections`,
      owner,
      {
        name: "Echoing next links",
        environmentId: "production",
        credentials: { apiKey: FIXTURE_SECRETS.apiKey },
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    const created = connectionResponseSchema.parse(response.json()).connection;
    // One backfill attempt: page one commits, page two fails.
    const handler = createJobHandlers({
      registry: new ConnectorRegistry(),
      credentialKeyring: createCredentialKeyring(KEY),
      executeOptions: {
        egress: { tlsCa: fixture.ca!, allowPrivateHosts: ["127.0.0.1"] },
      },
    })["connection.backfill"]!;
    await handler({
      job: {
        id: randomUUID(),
        kind: "connection.backfill",
        workspaceId,
        connectionId: created.id,
        attempts: 0,
        payload: {},
      } as unknown as Job,
      appDb: db,
      schedulerDb: db,
      logger: pino({ level: "silent" }),
    }).catch(() => undefined);
    const [state] = await admin<{ cursor: string | null }[]>`
      select cursor from connection_state where connection_id = ${created.id}`;
    expect(state!.cursor).toMatch(/^cav1\./);
    const runs = await admin<
      { cursor_after: string | null; error_message: string | null }[]
    >`select cursor_after, error_message from sync_runs
      where connection_id = ${created.id}`;
    expect(runs.some((run) => run.cursor_after !== null)).toBe(true);
    const decode = (cursor: string) =>
      Buffer.from(cursor.slice(5), "base64url").toString("utf8");
    for (const cursor of [
      state!.cursor!,
      ...runs.flatMap((run) => (run.cursor_after ? [run.cursor_after] : [])),
    ])
      expect(decode(cursor)).not.toContain(FIXTURE_SECRETS.apiKey);
    for (const run of runs)
      expect(run.error_message ?? "").not.toContain(FIXTURE_SECRETS.apiKey);
    const seen = await call(
      "GET",
      `/v1/workspaces/${workspaceId}/connections/${created.id}`,
      viewer,
    );
    expect(seen.statusCode).toBe(200);
    expect(seen.body).toContain("cav1.");
    const cursors = [...seen.body.matchAll(/cav1\.[A-Za-z0-9_-]+/g)];
    expect(cursors.length).toBeGreaterThan(0);
    for (const [cursor] of cursors)
      expect(decode(cursor)).not.toContain(FIXTURE_SECRETS.apiKey);
    expect(seen.body).not.toContain(FIXTURE_SECRETS.apiKey);
  });
});
