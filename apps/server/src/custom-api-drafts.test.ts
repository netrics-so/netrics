import { randomUUID } from "node:crypto";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  customApiDefinitionResponseSchema,
  customApiDraftResponseSchema,
  workspaceResponseSchema,
  type CustomApiDraftDefinition,
} from "@netrics/contracts";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import {
  FIXTURE_SECRETS,
  fixtureDefinition,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
} from "@netrics/connectors/custom-api/testing";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring, decryptCredentials } from "./credentials.js";
import { loadConnectionCustomApiDefinition } from "./custom-api/load-definition.js";
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Draft connections of the custom API builder (#806): secrets stay on the
// server and are bound to the hosts they were entered for; a draft is
// promoted into a pinned, scheduled connection that keeps its envelope.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const KEY = Buffer.alloc(32, 9).toString("base64");
const TOKEN = FIXTURE_SECRETS.token;

let fixture: CustomApiFixtureServer;
let app: FastifyInstance;
let limitedApp: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let viewer: string;
let workspaceId: string;
let otherWorkspaceId: string;

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  cookie: string,
  payload?: unknown,
  target: FastifyInstance = app,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie },
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

async function newWorkspace(cookie: string, name: string): Promise<string> {
  const response = await call("POST", "/v1/workspaces", cookie, { name });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

const drafts = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/custom-api/drafts`;

function asDraft(definition: CustomApiDefinition): CustomApiDraftDefinition {
  return {
    name: definition.name,
    environments: definition.environments,
    variables: definition.variables,
    auth: definition.auth,
    defaults: definition.defaults,
    stream: definition.streams[0]!,
  };
}

const bearerDefinition = () => fixtureDefinition("bearer", fixture.origin);
const bearerDraft = () => asDraft(bearerDefinition());

function withBaseUrl(
  draft: CustomApiDraftDefinition,
  baseUrl: string,
): CustomApiDraftDefinition {
  return {
    ...draft,
    environments: draft.environments.map((environment) =>
      environment.id === "production"
        ? { ...environment, baseUrl }
        : environment,
    ),
  };
}

async function createDraft(
  cookie = owner,
  workspace = workspaceId,
  target = app,
) {
  const response = await call("POST", drafts(workspace), cookie, {}, target);
  expect(response.statusCode, response.body).toBe(201);
  return customApiDraftResponseSchema.parse(response.json());
}

function updateDraft(
  id: string,
  body: Record<string, unknown>,
  cookie = owner,
  workspace = workspaceId,
) {
  return call("PUT", `${drafts(workspace)}/${id}`, cookie, body);
}

async function draftWithToken(target = app): Promise<string> {
  const { draft } = await createDraft(owner, workspaceId, target);
  const response = await call(
    "PUT",
    `${drafts()}/${draft.id}`,
    owner,
    {
      definition: bearerDraft(),
      environmentId: "production",
      secrets: { token: TOKEN },
    },
    target,
  );
  expect(response.statusCode, response.body).toBe(200);
  return draft.id;
}

async function saveDefinition(document: CustomApiDefinition) {
  const response = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/custom-api/definitions`,
    owner,
    { document },
  );
  expect(response.statusCode, response.body).toBe(201);
  return customApiDefinitionResponseSchema.parse(response.json()).definition;
}

function promote(
  id: string,
  body: Record<string, unknown>,
  target = app,
): Promise<InjectResponse> {
  return call("POST", `${drafts()}/${id}/promote`, owner, body, target);
}

async function row(id: string) {
  const [found] = await admin`
    select status, name, config, custom_api_definition_version_id,
      custom_api_environment_id, credentials_encrypted
    from connections where id = ${id}`;
  return found;
}

async function storedEnvelope(id: string) {
  return (await row(id))?.credentials_encrypted ?? null;
}

const keyring = createCredentialKeyring(KEY);

async function decrypted(id: string): Promise<Record<string, unknown>> {
  const stored = (await storedEnvelope(id)) as Buffer;
  return JSON.parse(
    decryptCredentials(stored.toString("utf8"), keyring, {
      workspaceId,
      connectionId: id,
    }),
  ) as Record<string, unknown>;
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode, response.body).toBe(status);
  expect(response.json().error).toBe(error);
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
    NETRICS_CUSTOM_API_MIN_REFRESH_MINUTES: "15",
  };
  const config = loadConfig(env);
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
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
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("drafts-owner@example.com");
  viewer = await signUp("drafts-viewer@example.com");
  workspaceId = await newWorkspace(owner, "Drafts");
  otherWorkspaceId = await newWorkspace(owner, "Other drafts");
  const added = await addMemberViaInvitation(
    app,
    db,
    owner,
    workspaceId,
    "drafts-viewer@example.com",
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

// Every case starts below the open-draft limit of the shared workspace.
beforeEach(async () => {
  await admin`delete from connections where status = 'draft'`;
});

describe("custom API draft connections", () => {
  it("keeps secrets out of every draft response", async () => {
    const { draft } = await createDraft();
    expect(draft).toMatchObject({
      environmentId: null,
      secretsSet: [],
      credentialHosts: [],
    });
    const res = await updateDraft(draft.id, {
      definition: bearerDraft(),
      environmentId: "production",
      secrets: { token: "s3cret-token-value" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("s3cret-token-value");
    const view = customApiDraftResponseSchema.parse(res.json()).draft;
    expect(view.secretsSet).toEqual(["token"]);
    expect(view.credentialHosts).toEqual(["127.0.0.1"]);
    expect(Date.parse(view.expiresAt) - Date.now()).toBeGreaterThan(
      23 * 60 * 60 * 1000,
    );
    // Stored encrypted, in the shape C stores for bearer.
    expect(await decrypted(draft.id)).toEqual({
      host: new URL(fixture.origin).host,
      token: "s3cret-token-value",
    });
    expect(JSON.stringify((await row(draft.id))!.config)).not.toContain(
      "s3cret-token-value",
    );
  });

  it("forgets the secret when the base URL moves to another host", async () => {
    const id = await draftWithToken();
    const moved = await updateDraft(id, {
      definition: withBaseUrl(bearerDraft(), "https://other.example.test/v1"),
      environmentId: "production",
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json().draft.secretsSet).toEqual([]);
    expect(await storedEnvelope(id)).toBeNull();
  });

  it("forgets the secret when another environment on another host is picked", async () => {
    const id = await draftWithToken();
    const draft = bearerDraft();
    const moved = await updateDraft(id, {
      definition: {
        ...draft,
        environments: [
          ...draft.environments,
          {
            id: "eu",
            name: "EU",
            baseUrl: "https://eu.example.test/v1",
          },
        ],
      },
      environmentId: "eu",
    });
    expect(moved.json().draft.secretsSet).toEqual([]);
    expect(await storedEnvelope(id)).toBeNull();
  });

  it("forgets the secret when only the port changes", async () => {
    const id = await draftWithToken();
    const port = Number(new URL(fixture.origin).port) + 1;
    const moved = await updateDraft(id, {
      definition: withBaseUrl(bearerDraft(), `https://127.0.0.1:${port}`),
      environmentId: "production",
    });
    expect(moved.json().draft.secretsSet).toEqual([]);
  });

  it("keeps the secret when only the path changes on the same host", async () => {
    const id = await draftWithToken();
    const draft = bearerDraft();
    const moved = await updateDraft(id, {
      definition: {
        ...draft,
        stream: {
          ...draft.stream,
          request: { ...draft.stream.request, path: "/auth/bearer-custom" },
        },
      },
      environmentId: "production",
    });
    expect(moved.json().draft.secretsSet).toEqual(["token"]);
    expect(await decrypted(id)).toMatchObject({ token: TOKEN });
  });

  it("refuses a secret name the login method does not declare", async () => {
    const { draft } = await createDraft();
    expectError(
      await updateDraft(draft.id, {
        definition: bearerDraft(),
        environmentId: "production",
        secrets: { apiKey: "some-key" },
      }),
      400,
      "custom_api_secret_unknown",
    );
    expectError(
      await updateDraft(draft.id, {
        definition: bearerDraft(),
        environmentId: "nowhere",
      }),
      400,
      "custom_api_environment_not_found",
    );
  });

  it("refuses a secret connection value named like a login credential", async () => {
    const { draft } = await createDraft();
    for (const id of ["token", "password", "username"]) {
      const definition = {
        ...bearerDraft(),
        variables: [{ id, label: "Secret", secret: true }],
      };
      expectError(
        await updateDraft(draft.id, {
          definition,
          environmentId: "production",
        }),
        400,
        "custom_api_variable_reserved",
      );
    }
    // A plain (not secret) value may use the name.
    const plain = await updateDraft(draft.id, {
      definition: {
        ...bearerDraft(),
        variables: [{ id: "token", label: "Token", secret: false }],
      },
      environmentId: "production",
    });
    expect(plain.statusCode, plain.body).toBe(200);
  });

  it("accepts a short Basic username but not a short password (review #820)", async () => {
    const { draft } = await createDraft();
    const basic = { ...bearerDraft(), auth: { type: "basic" } };
    const short = await updateDraft(draft.id, {
      definition: basic,
      environmentId: "production",
      secrets: { username: "bob", password: "pass-0001" },
    });
    expect(short.statusCode, short.body).toBe(200);
    expect(short.json().draft.secretsSet).toEqual(["password", "username"]);
    expectError(
      await updateDraft(draft.id, {
        definition: basic,
        environmentId: "production",
        secrets: { username: "bob", password: "abc" },
      }),
      400,
      "invalid_request",
    );
  });

  it("merges secrets sent one by one and checks the set on promote (review #820 N2)", async () => {
    const { draft } = await createDraft();
    const basic = { ...bearerDraft(), auth: { type: "basic" } };
    const first = await updateDraft(draft.id, {
      definition: basic,
      environmentId: "production",
      secrets: { username: "fx-user" },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().draft.secretsSet).toEqual(["username"]);
    // Incomplete: promote refuses it.
    const definition = await saveDefinition({
      ...bearerDefinition(),
      auth: { type: "basic" },
    } as CustomApiDefinition);
    expectError(
      await promote(draft.id, {
        definitionId: definition.id,
        version: 1,
        name: "Half",
        projectId: null,
      }),
      400,
      "custom_api_credentials_invalid",
    );
    const second = await updateDraft(draft.id, {
      definition: basic,
      environmentId: "production",
      secrets: { password: "pass-0001" },
    });
    expect(second.json().draft.secretsSet).toEqual(["password", "username"]);
    expect(await decrypted(draft.id)).toEqual({
      host: new URL(fixture.origin).host,
      username: "fx-user",
      password: "pass-0001",
    });
    // {} keeps everything; null removes one name.
    const kept = await updateDraft(draft.id, {
      definition: basic,
      environmentId: "production",
      secrets: {},
    });
    expect(kept.json().draft.secretsSet).toEqual(["password", "username"]);
    const removed = await updateDraft(draft.id, {
      definition: basic,
      environmentId: "production",
      secrets: { password: null },
    });
    expect(removed.json().draft.secretsSet).toEqual(["username"]);
  });

  it("adds a secret variable without the token being sent again (review #820 N2)", async () => {
    const id = await draftWithToken();
    const withTenant = {
      ...bearerDraft(),
      variables: [{ id: "tenant", label: "Tenant", secret: true }],
    };
    const res = await updateDraft(id, {
      definition: withTenant,
      environmentId: "production",
      secrets: { tenant: "tenant-secret" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().draft.secretsSet).toEqual(["tenant", "token"]);
    expect(await decrypted(id)).toEqual({
      host: new URL(fixture.origin).host,
      token: TOKEN,
      variables: { tenant: "tenant-secret" },
    });
    // The variable leaves the definition: its secret goes, the token stays.
    const gone = await updateDraft(id, {
      definition: bearerDraft(),
      environmentId: "production",
    });
    expect(gone.json().draft.secretsSet).toEqual(["token"]);
    expect(await decrypted(id)).toEqual({
      host: new URL(fixture.origin).host,
      token: TOKEN,
    });
  });

  it("drops every stored secret when the host changes, even with new ones sent (review #820 N2)", async () => {
    const id = await draftWithToken();
    const withTenant = {
      ...bearerDraft(),
      variables: [{ id: "tenant", label: "Tenant", secret: true }],
    };
    const moved = await updateDraft(id, {
      definition: withBaseUrl(withTenant, "https://other.example.test/v1"),
      environmentId: "production",
      secrets: { tenant: "tenant-secret" },
    });
    expect(moved.json().draft.secretsSet).toEqual(["tenant"]);
    expect(moved.json().draft.credentialHosts).toEqual(["other.example.test"]);
    expect(await decrypted(id)).not.toHaveProperty("token");
  });

  it("drops every stored secret when the login method changes (review #820 N2)", async () => {
    const { draft } = await createDraft();
    const withTenant = {
      ...bearerDraft(),
      variables: [{ id: "tenant", label: "Tenant", secret: true }],
    };
    const stored = await updateDraft(draft.id, {
      definition: withTenant,
      environmentId: "production",
      secrets: { token: TOKEN, tenant: "tenant-secret" },
    });
    expect(stored.json().draft.secretsSet).toEqual(["tenant", "token"]);
    const none = await updateDraft(draft.id, {
      definition: { ...withTenant, auth: { type: "none" } },
      environmentId: "production",
    });
    expect(none.json().draft.secretsSet).toEqual([]);
    expect(await storedEnvelope(draft.id)).toBeNull();
  });

  it("stores secret variables in the envelope and plain values in the draft", async () => {
    const { draft } = await createDraft();
    const base = bearerDraft();
    const res = await updateDraft(draft.id, {
      definition: {
        ...base,
        variables: [
          { id: "account_id", label: "Account", secret: false },
          { id: "tenant", label: "Tenant", secret: true },
        ],
      },
      environmentId: "production",
      variables: { account_id: "acc-1" },
      secrets: { token: TOKEN, tenant: "tenant-secret" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().draft).toMatchObject({
      variables: { account_id: "acc-1" },
      secretsSet: ["tenant", "token"],
    });
    expect(res.body).not.toContain("tenant-secret");
    expect(await decrypted(draft.id)).toEqual({
      host: new URL(fixture.origin).host,
      token: TOKEN,
      variables: { tenant: "tenant-secret" },
    });
  });

  it("promotes a draft into a scheduled connection pinned to the saved version, keeping its secret", async () => {
    const id = await draftWithToken();
    const definition = await saveDefinition(bearerDefinition());
    const res = await promote(id, {
      definitionId: definition.id,
      version: 1,
      name: "Shop API",
      projectId: null,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ connectionId: id });
    const [version] = await admin`
      select id from custom_api_definition_versions
      where definition_id = ${definition.id} and version = 1`;
    expect(await row(id)).toMatchObject({
      status: "active",
      name: "Shop API",
      config: {},
      custom_api_definition_version_id: version!.id,
      custom_api_environment_id: "production",
    });
    const [state] = await admin`
      select next_due_at, poll_interval_seconds from connection_state
      where connection_id = ${id}`;
    expect(state!.next_due_at).not.toBeNull();
    // Instance minimum 15 minutes, definition default 60.
    expect(state!.poll_interval_seconds).toBe(3600);
    // The envelope a connection created through C-G3 would hold.
    expect(await decrypted(id)).toEqual({
      host: new URL(fixture.origin).host,
      token: TOKEN,
    });
    const jobs = await admin`
      select kind from jobs where connection_id = ${id}`;
    expect(jobs.map((job) => job.kind)).toEqual(["connection.backfill"]);
    const [audit] = await admin`
      select metadata from audit_events
      where target = ${id} and action = 'connection.created'`;
    expect(audit!.metadata).toMatchObject({
      connectorId: "custom-api",
      definitionId: definition.id,
      version: 1,
      environmentId: "production",
      fromDraft: true,
    });
    const listed = await call(
      "GET",
      `/v1/workspaces/${workspaceId}/connections/${id}`,
      owner,
    );
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(TOKEN);
  });

  it("refuses a second promote", async () => {
    const id = await draftWithToken();
    const definition = await saveDefinition(bearerDefinition());
    const body = {
      definitionId: definition.id,
      version: 1,
      name: "Twice",
      projectId: null,
    };
    expect((await promote(id, body)).statusCode).toBe(200);
    expectError(await promote(id, body), 409, "custom_api_draft_not_found");
  });

  it("refuses to promote when the saved version sends the secret to another host", async () => {
    const id = await draftWithToken();
    const moved = bearerDefinition();
    const definition = await saveDefinition({
      ...moved,
      environments: moved.environments.map((environment) =>
        environment.id === "production"
          ? { ...environment, baseUrl: "https://other.example.test/v1" }
          : environment,
      ),
    });
    expectError(
      await promote(id, {
        definitionId: definition.id,
        version: 1,
        name: "Moved",
        projectId: null,
      }),
      409,
      "custom_api_credentials_host_changed",
    );
    expect((await row(id))!.status).toBe("draft");
  });

  it("refuses to promote without the connection values the version needs", async () => {
    const id = await draftWithToken();
    const document = bearerDefinition();
    const definition = await saveDefinition({
      ...document,
      variables: [{ id: "account_id", label: "Account", secret: false }],
    });
    expectError(
      await promote(id, {
        definitionId: definition.id,
        version: 1,
        name: "Values",
        projectId: null,
      }),
      400,
      "custom_api_variables_invalid",
    );
    expectError(
      await promote(id, {
        definitionId: randomUUID(),
        version: 1,
        name: "Missing",
        projectId: null,
      }),
      404,
      "custom_api_definition_not_found",
    );
  });

  it("hides another workspace's draft", async () => {
    const id = await draftWithToken();
    expectError(
      await updateDraft(
        id,
        { definition: bearerDraft(), environmentId: "production" },
        owner,
        otherWorkspaceId,
      ),
      404,
      "custom_api_draft_not_found",
    );
    expectError(
      await call("DELETE", `${drafts(otherWorkspaceId)}/${id}`, owner),
      404,
      "custom_api_draft_not_found",
    );
    expect((await row(id))!.status).toBe("draft");
  });

  it("needs connections:create", async () => {
    expect((await call("POST", drafts(), viewer, {})).statusCode).toBe(403);
    const id = await draftWithToken();
    expect(
      (
        await updateDraft(
          id,
          { definition: bearerDraft(), environmentId: "production" },
          viewer,
        )
      ).statusCode,
    ).toBe(403);
    expect((await call("DELETE", `${drafts()}/${id}`, viewer)).statusCode).toBe(
      403,
    );
  });

  it("deletes a draft with its secrets", async () => {
    const id = await draftWithToken();
    expect((await call("DELETE", `${drafts()}/${id}`, owner)).statusCode).toBe(
      204,
    );
    expect(await row(id)).toBeUndefined();
    expectError(
      await call("DELETE", `${drafts()}/${id}`, owner),
      404,
      "custom_api_draft_not_found",
    );
  });

  it("limits open drafts to 10 per workspace", async () => {
    const workspace = await newWorkspace(owner, "Many drafts");
    for (let i = 0; i < 10; i++) await createDraft(owner, workspace);
    expectError(
      await call("POST", drafts(workspace), owner, {}),
      409,
      "custom_api_draft_limit",
    );
  });

  it("loads a draft's stored definition for the OAuth flow, and the pinned one after promotion", async () => {
    const id = await draftWithToken();
    const load = (workspace: string) =>
      withWorkspace(db, { workspaceId: workspace }, (tx) =>
        loadConnectionCustomApiDefinition(tx, workspace, id),
      );
    expect(await load(workspaceId)).toMatchObject({
      draft: true,
      environmentId: "production",
      definition: { auth: { type: "bearer" } },
    });
    const definition = await saveDefinition(bearerDefinition());
    expect(
      (
        await promote(id, {
          definitionId: definition.id,
          version: 1,
          name: "Loaded",
          projectId: null,
        })
      ).statusCode,
    ).toBe(200);
    expect(await load(workspaceId)).toMatchObject({
      draft: false,
      environmentId: "production",
      pin: { definitionId: definition.id, version: 1 },
    });
    expect(await load(otherWorkspaceId)).toBeNull();
  });

  it("applies the connection limit on promote and does not count drafts", async () => {
    const workspace = await newWorkspace(owner, "Limited drafts");
    const target = limitedApp;
    // Two drafts do not use the single connection slot.
    const first = await createDraft(owner, workspace, target);
    const second = await createDraft(owner, workspace, target);
    const definition = customApiDefinitionResponseSchema.parse(
      (
        await call(
          "POST",
          `/v1/workspaces/${workspace}/custom-api/definitions`,
          owner,
          { document: bearerDefinition() },
          target,
        )
      ).json(),
    ).definition;
    for (const { draft } of [first, second]) {
      const stored = await call(
        "PUT",
        `${drafts(workspace)}/${draft.id}`,
        owner,
        {
          definition: bearerDraft(),
          environmentId: "production",
          secrets: { token: TOKEN },
        },
        target,
      );
      expect(stored.statusCode).toBe(200);
    }
    const body = {
      definitionId: definition.id,
      version: 1,
      name: "Limited",
      projectId: null,
    };
    const promoteIn = (id: string) =>
      call("POST", `${drafts(workspace)}/${id}/promote`, owner, body, target);
    expect((await promoteIn(first.draft.id)).statusCode).toBe(200);
    expectError(
      await promoteIn(second.draft.id),
      409,
      "custom_api_connection_limit",
    );
  });

  it("applies the instance minimum refresh on promote", async () => {
    const id = await draftWithToken();
    const document = bearerDefinition();
    const definition = await saveDefinition({
      ...document,
      defaults: { ...document.defaults, refreshMinutes: 5 },
    });
    expect(
      (
        await promote(id, {
          definitionId: definition.id,
          version: 1,
          name: "Fast",
          projectId: null,
        })
      ).statusCode,
    ).toBe(200);
    const [state] = await admin`
      select poll_interval_seconds from connection_state
      where connection_id = ${id}`;
    expect(state!.poll_interval_seconds).toBe(900);
  });
});
