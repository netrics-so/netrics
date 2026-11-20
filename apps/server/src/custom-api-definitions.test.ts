import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  customApiDefinitionListResponseSchema,
  customApiDefinitionResponseSchema,
  customApiErrorResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { customApiFixture } from "./custom-api/test-helpers.js";
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Custom API definitions (#803): versioned, workspace-scoped definitions
// with optimistic new versions, dataset versions per stream, archive,
// instance limits, permissions and audit events without document content.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;
type Doc = Record<string, unknown> & {
  streams: Array<Record<string, unknown> & { fields: Doc[] }>;
};

let app: FastifyInstance;
let limitedApp: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let editor: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let strangerWorkspaceId: string;

function call(
  method: "GET" | "POST" | "PATCH",
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
    name: "Custom APIs",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

const defs = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/custom-api/definitions`;

const shop = () => customApiFixture("v1-shop") as Doc;

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  const body = customApiErrorResponseSchema.parse(response.json());
  expect(body.error).toBe(error);
  return body;
}

async function createDefinition(
  document: Doc = shop(),
  extra: Record<string, unknown> = {},
  workspace = workspaceId,
  cookie = editor,
) {
  const response = await call("POST", defs(workspace), cookie, {
    document,
    ...extra,
  });
  expect(response.statusCode).toBe(201);
  return customApiDefinitionResponseSchema.parse(response.json()).definition;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const env = {
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  };
  const config = loadConfig(env);
  db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, { db, authService, checkDb: async () => true });
  const limitedConfig = loadConfig({
    ...env,
    NETRICS_CUSTOM_API_MAX_DEFINITIONS: "1",
    NETRICS_CUSTOM_API_MAX_STREAMS: "1",
  });
  limitedApp = await buildApp(limitedConfig, {
    db,
    authService: createAuthService(limitedConfig, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  owner = await signUp("custom-api-owner@example.com");
  editor = await signUp("custom-api-editor@example.com");
  viewer = await signUp("custom-api-viewer@example.com");
  stranger = await signUp("custom-api-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  for (const [email, role] of [
    ["custom-api-editor@example.com", "editor"],
    ["custom-api-viewer@example.com", "viewer"],
  ] as const) {
    const added = await addMemberViaInvitation(
      app,
      db,
      owner,
      workspaceId,
      email,
      role,
    );
    expect(added.statusCode).toBe(200);
  }
  strangerWorkspaceId = await newWorkspace(stranger);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await limitedApp?.close();
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

describe("custom API definitions API", () => {
  it("creates a definition and returns version 1 with dataset versions", async () => {
    const res = await call("POST", defs(), editor, { document: shop() });
    expect(res.statusCode).toBe(201);
    const { definition } = customApiDefinitionResponseSchema.parse(res.json());
    expect(definition).toMatchObject({
      name: "Shop API",
      projectId: null,
      currentVersion: 1,
      archivedAt: null,
      connectionCount: 0,
      datasetVersions: { daily_stats: 1 },
    });
    expect(definition.document.streams[0]!.key).toBe("daily_stats");
    const got = await call("GET", `${defs()}/${definition.id}`, viewer);
    expect(got.statusCode).toBe(200);
    expect(
      customApiDefinitionResponseSchema.parse(got.json()).definition,
    ).toEqual(definition);
  });

  it("answers issues for an invalid document", async () => {
    const document = shop();
    document.variables = [
      { id: "account_id", label: "Account ID", secret: false },
      { id: "api_secret", label: "Secret", secret: true },
    ];
    document.streams[0]!.request = {
      path: "/stats",
      query: { key: "{{api_secret}}" },
    };
    const body = expectError(
      await call("POST", defs(), editor, { document }),
      400,
      "custom_api_definition_invalid",
    );
    expect(body.issues?.[0]?.code).toBe("placeholder_secret_outside_auth");
    expectError(
      await call("POST", defs(), editor, { document: null }),
      400,
      "custom_api_definition_invalid",
    );
    expectError(await call("POST", defs(), editor, {}), 400, "invalid_request");
  });

  it("lets viewers read but not create", async () => {
    const created = await createDefinition();
    const list = await call("GET", defs(), viewer);
    expect(list.statusCode).toBe(200);
    expect(
      customApiDefinitionListResponseSchema
        .parse(list.json())
        .definitions.map((item) => item.id),
    ).toContain(created.id);
    expectError(
      await call("POST", defs(), viewer, { document: shop() }),
      403,
      "forbidden",
    );
    expectError(
      await call("POST", `${defs()}/${created.id}/versions`, viewer, {
        baseVersion: 1,
        document: shop(),
      }),
      403,
      "forbidden",
    );
    expectError(
      await call("POST", `${defs()}/${created.id}/archive`, viewer),
      403,
      "forbidden",
    );
  });

  it("adds a version only from the current base", async () => {
    const created = await createDefinition();
    const renamed = { ...shop(), name: "Shop API v2" };
    const first = await call(
      "POST",
      `${defs()}/${created.id}/versions`,
      editor,
      {
        baseVersion: 1,
        document: renamed,
      },
    );
    expect(first.statusCode).toBe(201);
    expect(
      customApiDefinitionResponseSchema.parse(first.json()).definition,
    ).toMatchObject({
      name: "Shop API v2",
      currentVersion: 2,
      datasetVersions: { daily_stats: 1 },
    });
    expectError(
      await call("POST", `${defs()}/${created.id}/versions`, editor, {
        baseVersion: 1,
        document: shop(),
      }),
      409,
      "custom_api_definition_stale",
    );
  });

  it("bumps the dataset version of a changed stream only", async () => {
    const document = shop();
    const weekly = structuredClone(document.streams[0]!);
    weekly.key = "weekly_stats";
    weekly.name = "Weekly stats";
    document.streams.push(weekly);
    const created = await createDefinition(document);
    expect(created.datasetVersions).toEqual({
      daily_stats: 1,
      weekly_stats: 1,
    });
    const changed = structuredClone(document);
    changed.streams[1]!.fields[1]!.type = "decimal";
    const res = await call("POST", `${defs()}/${created.id}/versions`, editor, {
      baseVersion: 1,
      document: changed,
    });
    expect(res.statusCode).toBe(201);
    expect(
      customApiDefinitionResponseSchema.parse(res.json()).definition
        .datasetVersions,
    ).toEqual({ daily_stats: 1, weekly_stats: 2 });
  });

  it("continues a removed and re-added stream after its highest version", async () => {
    const withS = shop();
    const s1 = structuredClone(withS.streams[0]!);
    s1.key = "s";
    s1.name = "S";
    withS.streams.push(s1);
    const created = await createDefinition(withS);
    const save = async (baseVersion: number, document: Doc) => {
      const res = await call(
        "POST",
        `${defs()}/${created.id}/versions`,
        editor,
        { baseVersion, document },
      );
      expect(res.statusCode).toBe(201);
      return customApiDefinitionResponseSchema.parse(res.json()).definition
        .datasetVersions;
    };
    const changed = structuredClone(withS);
    changed.streams[1]!.fields[1]!.type = "decimal";
    expect(await save(1, changed)).toEqual({ daily_stats: 1, s: 2 });
    expect(await save(2, shop())).toEqual({ daily_stats: 1 });
    expect(await save(3, withS)).toEqual({ daily_stats: 1, s: 3 });
  });

  it("refuses changes to an archived definition and hides it from the default list", async () => {
    const created = await createDefinition();
    const archived = await call(
      "POST",
      `${defs()}/${created.id}/archive`,
      editor,
    );
    expect(archived.statusCode).toBe(200);
    expect(
      customApiDefinitionResponseSchema.parse(archived.json()).definition
        .archivedAt,
    ).toEqual(expect.any(String));
    expectError(
      await call("POST", `${defs()}/${created.id}/versions`, editor, {
        baseVersion: 1,
        document: shop(),
      }),
      409,
      "custom_api_definition_archived",
    );
    expectError(
      await call("PATCH", `${defs()}/${created.id}`, editor, {
        projectId: null,
      }),
      409,
      "custom_api_definition_archived",
    );
    const ids = async (url: string) =>
      customApiDefinitionListResponseSchema
        .parse((await call("GET", url, viewer)).json())
        .definitions.map((item) => item.id);
    expect(await ids(defs())).not.toContain(created.id);
    expect(await ids(`${defs()}?includeArchived=true`)).toContain(created.id);
    // Still readable by id: connections pinned to it keep working.
    expect(
      (await call("GET", `${defs()}/${created.id}`, viewer)).statusCode,
    ).toBe(200);
  });

  it("enforces the definition limit", async () => {
    const workspace = await newWorkspace(owner);
    const first = await call(
      "POST",
      defs(workspace),
      owner,
      { document: shop() },
      limitedApp,
    );
    expect(first.statusCode).toBe(201);
    expectError(
      await call(
        "POST",
        defs(workspace),
        owner,
        { document: shop() },
        limitedApp,
      ),
      409,
      "custom_api_definition_limit",
    );
    // Archived definitions do not count.
    const { id } = customApiDefinitionResponseSchema.parse(
      first.json(),
    ).definition;
    await call(
      "POST",
      `${defs(workspace)}/${id}/archive`,
      owner,
      undefined,
      limitedApp,
    );
    expect(
      (
        await call(
          "POST",
          defs(workspace),
          owner,
          { document: shop() },
          limitedApp,
        )
      ).statusCode,
    ).toBe(201);
  });

  it("enforces the stream limit", async () => {
    const workspace = await newWorkspace(owner);
    const document = shop();
    const weekly = structuredClone(document.streams[0]!);
    weekly.key = "weekly_stats";
    document.streams.push(weekly);
    expectError(
      await call("POST", defs(workspace), owner, { document }, limitedApp),
      400,
      "custom_api_stream_limit",
    );
  });

  it("returns 404 for another workspace's definition", async () => {
    const foreign = await createDefinition(
      shop(),
      {},
      strangerWorkspaceId,
      stranger,
    );
    expectError(
      await call("GET", `${defs()}/${foreign.id}`, owner),
      404,
      "custom_api_definition_not_found",
    );
    expectError(
      await call("POST", `${defs()}/${foreign.id}/versions`, owner, {
        baseVersion: 1,
        document: shop(),
      }),
      404,
      "custom_api_definition_not_found",
    );
    expectError(
      await call("PATCH", `${defs()}/${foreign.id}`, owner, {
        projectId: null,
      }),
      404,
      "custom_api_definition_not_found",
    );
    expectError(
      await call("POST", `${defs()}/${foreign.id}/archive`, owner),
      404,
      "custom_api_definition_not_found",
    );
    expectError(
      await call("GET", `${defs()}/not-a-uuid`, owner),
      404,
      "custom_api_definition_not_found",
    );
    // A non-member does not learn the workspace exists.
    expect(
      (await call("GET", defs(strangerWorkspaceId), owner)).statusCode,
    ).toBe(404);
  });

  it("moves a definition to a live project and filters the list by it", async () => {
    const [project] = await admin`
      insert into projects (workspace_id, name)
      values (${workspaceId}, 'Live') returning id`;
    const projectId = project!.id as string;
    const created = await createDefinition(shop(), { projectId });
    expect(created.projectId).toBe(projectId);
    const listed = customApiDefinitionListResponseSchema.parse(
      (await call("GET", `${defs()}?project=${projectId}`, viewer)).json(),
    );
    expect(listed.definitions.map((item) => item.id)).toEqual([created.id]);
    const moved = await call("PATCH", `${defs()}/${created.id}`, editor, {
      projectId: null,
    });
    expect(moved.statusCode).toBe(200);
    expect(
      customApiDefinitionResponseSchema.parse(moved.json()).definition
        .projectId,
    ).toBeNull();
  });

  it("refuses an archived project", async () => {
    const [project] = await admin`
      insert into projects (workspace_id, name, archived_at)
      values (${workspaceId}, 'Old', now()) returning id`;
    const projectId = project!.id as string;
    expectError(
      await call("POST", defs(), editor, { document: shop(), projectId }),
      404,
      "project_not_found",
    );
    const created = await createDefinition();
    expectError(
      await call("PATCH", `${defs()}/${created.id}`, editor, { projectId }),
      404,
      "project_not_found",
    );
    const [foreign] = await admin`
      insert into projects (workspace_id, name)
      values (${strangerWorkspaceId}, 'Theirs') returning id`;
    expectError(
      await call("PATCH", `${defs()}/${created.id}`, editor, {
        projectId: foreign!.id as string,
      }),
      404,
      "project_not_found",
    );
  });

  it("writes audit events without document content", async () => {
    const created = await createDefinition();
    await call("POST", `${defs()}/${created.id}/versions`, editor, {
      baseVersion: 1,
      document: shop(),
    });
    await call("PATCH", `${defs()}/${created.id}`, editor, { projectId: null });
    await call("POST", `${defs()}/${created.id}/archive`, editor);
    const events = await admin`
      select action, metadata from audit_events
      where target = ${created.id} order by created_at, action`;
    expect(events.map((event) => event.action)).toEqual([
      "custom_api_definition.created",
      "custom_api_definition.version_created",
      "custom_api_definition.updated",
      "custom_api_definition.archived",
    ]);
    expect(events[1]!.metadata).toEqual({ version: 2 });
    expect(events[2]!.metadata).toEqual({ projectId: null });
    const text = JSON.stringify(events);
    expect(text).not.toContain("api.example.com");
    expect(text).not.toContain("daily_stats");
    expect(text).not.toContain("account_id");
  });
});
