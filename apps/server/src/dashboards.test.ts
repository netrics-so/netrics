import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardListResponseSchema,
  dashboardResponseSchema,
  errorResponseSchema,
  MAX_DASHBOARD_TILES,
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
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let editor: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let connectionId: string;
let foreignConnectionId: string;

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  cookie: string | null,
  payload?: unknown,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: cookie ? { cookie } : {},
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  };
  return app.inject(options);
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
    name: "Dashboards",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

async function newConnection(workspace: string): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspace}, 'demo', 'Demo') returning id`;
  return row!.id as string;
}

const base = () => `/v1/workspaces/${workspaceId}/dashboards`;

function signupsTile(overrides: Record<string, unknown> = {}) {
  return {
    connectionId,
    metricKey: "demo.signups",
    period: "last_7_days",
    ...overrides,
  };
}

async function createDashboard(
  cookie: string,
  body: Record<string, unknown>,
): Promise<InjectResponse> {
  return call("POST", base(), cookie, body);
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, { db, authService, checkDb: async () => true });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  owner = await signUp("dash-owner@example.com");
  editor = await signUp("dash-editor@example.com");
  viewer = await signUp("dash-viewer@example.com");
  stranger = await signUp("dash-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  for (const [email, role] of [
    ["dash-editor@example.com", "editor"],
    ["dash-viewer@example.com", "viewer"],
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
  connectionId = await newConnection(workspaceId);
  foreignConnectionId = await newConnection(await newWorkspace(stranger));
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("dashboards API", () => {
  it("creates, reads, replaces, duplicates and deletes", async () => {
    const created = await createDashboard(editor, {
      name: "Growth",
      tiles: [signupsTile(), signupsTile({ period: "today", title: "Today" })],
    });
    expect(created.statusCode).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(created.json());
    expect(dashboard).toMatchObject({ name: "Growth", version: 1 });
    // The default aggregation is filled in from the metric.
    expect(
      dashboard.tiles.map((t) => [t.position, t.aggregation, t.title]),
    ).toEqual([
      [0, "sum", null],
      [1, "sum", "Today"],
    ]);

    const read = await call("GET", `${base()}/${dashboard.id}`, viewer);
    expect(dashboardResponseSchema.parse(read.json()).dashboard).toEqual(
      dashboard,
    );

    const replaced = await call("PUT", `${base()}/${dashboard.id}`, editor, {
      version: 1,
      name: "Growth weekly",
      projectId: null,
      tiles: [
        signupsTile({ period: "this_month" }),
        signupsTile({ metricKey: "demo.visitors", aggregation: "max" }),
      ],
    });
    expect(replaced.statusCode).toBe(200);
    const next = dashboardResponseSchema.parse(replaced.json()).dashboard;
    expect(next).toMatchObject({ name: "Growth weekly", version: 2 });
    expect(next.tiles.map((t) => [t.metricKey, t.aggregation])).toEqual([
      ["demo.signups", "sum"],
      ["demo.visitors", "max"],
    ]);

    const copy = await call(
      "POST",
      `${base()}/${dashboard.id}/duplicate`,
      editor,
      {},
    );
    const duplicated = dashboardResponseSchema.parse(copy.json()).dashboard;
    expect(duplicated).toMatchObject({
      name: "Growth weekly (copy)",
      version: 1,
    });
    expect(duplicated.id).not.toBe(dashboard.id);
    expect(duplicated.tiles).toHaveLength(2);

    const list = dashboardListResponseSchema.parse(
      (await call("GET", base(), viewer)).json(),
    );
    expect(list.dashboards.map((d) => d.name).sort()).toEqual(
      expect.arrayContaining(["Growth weekly", "Growth weekly (copy)"]),
    );

    expect(
      (await call("DELETE", `${base()}/${duplicated.id}`, owner)).statusCode,
    ).toBe(204);
    expectError(
      await call("GET", `${base()}/${duplicated.id}`, owner),
      404,
      "dashboard_not_found",
    );

    const actions = await admin`
      select action from audit_events
      where workspace_id = ${workspaceId} and action like 'dashboard.%'
      order by created_at`;
    expect(actions.map((row) => row.action)).toEqual([
      "dashboard.created",
      "dashboard.updated",
      "dashboard.duplicated",
      "dashboard.deleted",
    ]);
  });

  it("rejects a stale update with 409", async () => {
    const { dashboard } = dashboardResponseSchema.parse(
      (await createDashboard(owner, { name: "Shared" })).json(),
    );
    const put = (name: string) =>
      call("PUT", `${base()}/${dashboard.id}`, owner, {
        version: 1,
        name,
        projectId: null,
        tiles: [],
      });
    expect((await put("First")).statusCode).toBe(200);
    expectError(await put("Second"), 409, "version_conflict");
    const current = await call("GET", `${base()}/${dashboard.id}`, owner);
    expect(
      dashboardResponseSchema.parse(current.json()).dashboard,
    ).toMatchObject({ name: "First", version: 2 });
  });

  it.each([
    ["an unknown metric", { metricKey: "demo.nope" }, "tile_metric_not_found"],
    [
      "another workspace's connection",
      { connectionId: "" },
      "tile_metric_not_found",
    ],
    [
      "an aggregation that does not fit",
      { metricKey: "demo.visitors", aggregation: "sum" },
      "aggregation_not_supported",
    ],
    [
      "an unknown dimension",
      { dimensions: { country: "de" } },
      "unknown_dimension",
    ],
  ])("rejects a tile with %s", async (_label, overrides, error) => {
    const tileOverrides =
      "connectionId" in overrides
        ? { connectionId: foreignConnectionId }
        : overrides;
    expectError(
      await createDashboard(owner, {
        name: "Invalid",
        tiles: [signupsTile(tileOverrides)],
      }),
      400,
      error,
    );
  });

  it("limits the number of tiles", async () => {
    const response = await createDashboard(owner, {
      name: "Too many",
      tiles: Array.from({ length: MAX_DASHBOARD_TILES + 1 }, () =>
        signupsTile(),
      ),
    });
    expect(response.statusCode).toBe(400);
  });

  it("applies role permissions", async () => {
    expectError(
      await createDashboard(viewer, { name: "Nope" }),
      403,
      "forbidden",
    );
    const { dashboard } = dashboardResponseSchema.parse(
      (await createDashboard(editor, { name: "Editor's" })).json(),
    );
    // Editors change dashboards but do not delete them (like connections).
    expectError(
      await call("DELETE", `${base()}/${dashboard.id}`, editor),
      403,
      "forbidden",
    );
    expect((await call("GET", base(), viewer)).statusCode).toBe(200);
  });

  it("keeps dashboards inside their workspace", async () => {
    const { dashboard } = dashboardResponseSchema.parse(
      (await createDashboard(owner, { name: "Private" })).json(),
    );
    expectError(
      await call("GET", `${base()}/${dashboard.id}`, stranger),
      404,
      "workspace_not_found",
    );
    const strangersWorkspace = await newWorkspace(stranger);
    expectError(
      await call(
        "GET",
        `/v1/workspaces/${strangersWorkspace}/dashboards/${dashboard.id}`,
        stranger,
      ),
      404,
      "dashboard_not_found",
    );
    expectError(
      await call("GET", `${base()}/not-a-uuid`, owner),
      404,
      "dashboard_not_found",
    );
  });

  it("removes a deleted connection's tiles", async () => {
    const extra = await newConnection(workspaceId);
    const { dashboard } = dashboardResponseSchema.parse(
      (
        await createDashboard(owner, {
          name: "Mixed",
          tiles: [signupsTile(), signupsTile({ connectionId: extra })],
        })
      ).json(),
    );
    const deleted = await call(
      "DELETE",
      `/v1/workspaces/${workspaceId}/connections/${extra}`,
      owner,
    );
    expect(deleted.statusCode).toBe(200);
    const after = await call("GET", `${base()}/${dashboard.id}`, owner);
    expect(
      dashboardResponseSchema
        .parse(after.json())
        .dashboard.tiles.map((t) => t.connectionId),
    ).toEqual([connectionId]);
  });
});
