import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardListResponseSchema,
  dashboardResponseSchema,
  errorResponseSchema,
  MAX_DASHBOARD_TILES,
  themeResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { BUILTIN_THEMES } from "@netrics/domain";

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

describe("dashboard studio API", () => {
  // The table rows below are built before beforeAll ran: "own" stands for
  // the workspace's connection until the test resolves it.
  const metricWidget = (overrides: Record<string, unknown> = {}) => ({
    type: "metric",
    x: 0,
    y: 0,
    w: 3,
    h: 2,
    connectionId: connectionId ?? "own",
    metricKey: "demo.signups",
    period: "last_7_days",
    ...overrides,
  });

  const studioSlides = () => [
    {
      name: "Sales",
      durationSeconds: 30,
      widgets: [
        metricWidget({ x: 4, y: 0, title: "Right" }),
        metricWidget({ x: 0, y: 0, options: { showSparkline: false } }),
        {
          type: "line",
          x: 0,
          y: 2,
          w: 6,
          h: 4,
          connectionId,
          metricKey: "demo.visitors",
          period: "last_30_days",
          dimensions: { resource: "site-1" },
        },
        {
          type: "bar",
          x: 6,
          y: 2,
          w: 6,
          h: 6,
          connectionId,
          metricKey: "demo.signups",
          period: "this_month",
          options: { groupBy: "resource" },
        },
      ],
    },
    {
      enabled: false,
      widgets: [
        { type: "text", x: 0, y: 0, w: 12, h: 2, text: "## Hello\n**bold**" },
        { type: "clock", x: 0, y: 2, w: 2, h: 1 },
        metricWidget({ x: 0, y: 3 }),
      ],
    },
  ];

  async function studio(body: Record<string, unknown> = {}) {
    const response = await createDashboard(owner, {
      name: "Studio",
      slides: studioSlides(),
      ...body,
    });
    expect(response.statusCode).toBe(200);
    return dashboardResponseSchema.parse(response.json()).dashboard;
  }

  function put(
    dashboard: { id: string; version: number; name: string },
    body: Record<string, unknown>,
    cookie = owner,
  ) {
    return call("PUT", `${base()}/${dashboard.id}`, cookie, {
      version: dashboard.version,
      name: dashboard.name,
      projectId: null,
      ...body,
    });
  }

  beforeAll(async () => {
    await admin`
      insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${connectionId}, ${workspaceId}, 'site-1', 'Main site', 'site')
      on conflict do nothing`;
    // Amounts, for the compare widget's unit rules (ADR 0019 §10).
    await admin`
      insert into metric_definitions (connector_id, key, name, description,
        kind, unit, granularity, dimensions, aggregations)
      values
        ('demo', 'demo.proceeds', 'Proceeds', '', 'delta', 'currency_minor',
         'day', '["resource","currency"]', '["sum"]'),
        ('demo', 'demo.ad_spend', 'Ad spend', '', 'delta', 'EUR_minor',
         'day', '["resource"]', '["sum"]')
      on conflict do nothing`;
  });

  /** A compare widget (ADR 0019 §10): signups ÷ visitors by default. */
  const compareWidget = (
    overrides: Record<string, unknown> = {},
    denominator: Record<string, unknown> = {},
  ) =>
    metricWidget({
      type: "compare",
      w: 4,
      h: 3,
      denominator: {
        connectionId: connectionId ?? "own",
        metricKey: "demo.visitors",
        ...denominator,
      },
      ...overrides,
    });

  it("stores a compare widget with both bindings, and copies it (ADR 0019 §10)", async () => {
    const response = await createDashboard(owner, {
      name: "Compare",
      slides: [
        {
          widgets: [
            compareWidget(
              {
                title: "Conversion",
                dimensions: { resource: "site-1" },
                options: { ratioLabel: "conversion" },
              },
              { aggregation: "max", dimensions: { resource: "site-1" } },
            ),
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    const dashboard = dashboardResponseSchema.parse(response.json()).dashboard;
    const [widget] = dashboard.slides[0]!.widgets;
    expect(widget).toMatchObject({
      type: "compare",
      title: "Conversion",
      connectionId,
      metricKey: "demo.signups",
      aggregation: "sum",
      period: "last_7_days",
      dimensions: { resource: "site-1" },
      resourceName: "Main site",
      denominator: {
        connectionId,
        metricKey: "demo.visitors",
        aggregation: "max",
        dimensions: { resource: "site-1" },
        resourceName: "Main site",
        allResourcesName: null,
      },
      options: {
        format: "percent",
        ratioLabel: "conversion",
        showChange: true,
      },
    });
    // The denominator's aggregation defaults like the numerator's.
    const defaulted = await put(dashboard, {
      slides: [{ widgets: [compareWidget()] }],
    });
    expect(defaulted.statusCode).toBe(200);
    const saved = dashboardResponseSchema.parse(defaulted.json()).dashboard;
    expect(saved.slides[0]!.widgets[0]).toMatchObject({
      type: "compare",
      denominator: { metricKey: "demo.visitors", aggregation: "last" },
      options: { format: "percent", ratioLabel: null, showChange: true },
    });
    // A compare widget is not a tile.
    expect(saved.tiles).toEqual([]);

    const copy = await call(
      "POST",
      `${base()}/${saved.id}/duplicate`,
      owner,
      {},
    );
    const duplicated = dashboardResponseSchema.parse(copy.json()).dashboard;
    expect(duplicated.slides[0]!.widgets[0]).toMatchObject({
      type: "compare",
      denominator: { metricKey: "demo.visitors", aggregation: "last" },
    });
  });

  it("accepts the ratios the units allow (ADR 0019 §10)", async () => {
    const response = await createDashboard(owner, {
      name: "Ratios",
      slides: [
        {
          widgets: [
            // An amount per unit: proceeds per signup.
            compareWidget(
              {
                metricKey: "demo.proceeds",
                displayCurrency: "EUR",
                options: { format: "ratio" },
              },
              { metricKey: "demo.signups" },
            ),
            // ROAS: proceeds in euros over euro ad spend.
            compareWidget(
              {
                x: 4,
                metricKey: "demo.proceeds",
                dimensions: { currency: "EUR" },
                options: { format: "ratio", ratioLabel: "ROAS" },
              },
              { metricKey: "demo.ad_spend" },
            ),
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    const dashboard = dashboardResponseSchema.parse(response.json()).dashboard;
    expect(
      dashboard.slides[0]!.widgets.map((widget) => [
        widget.type,
        "displayCurrency" in widget ? widget.displayCurrency : null,
      ]),
    ).toEqual([
      ["compare", "EUR"],
      ["compare", null],
    ]);
  });

  it("counts a compare widget as two data widgets (ADR 0019 §2)", async () => {
    const compares = (count: number) => ({
      widgets: many(count, (i) =>
        compareWidget({ x: (i % 3) * 4, y: Math.floor(i / 3) * 3 }),
      ),
    });
    // 32 metric widgets and 8 compare widgets: 48 queries.
    const full = await createDashboard(owner, {
      name: "Full",
      slides: [fullSlide(), fullSlide(), compares(6), compares(2)],
    });
    expect(full.statusCode).toBe(200);
    expectError(
      await createDashboard(owner, {
        name: "Too full",
        slides: [fullSlide(), fullSlide(), compares(6), compares(3)],
      }),
      400,
      "too_many_data_widgets",
    );
  });

  it("deletes a compare widget with its denominator's connection", async () => {
    const [row] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'demo', 'Second') returning id`;
    const second = row!.id as string;
    const response = await createDashboard(owner, {
      name: "Two sources",
      slides: [
        {
          widgets: [
            compareWidget({}, { connectionId: second }),
            metricWidget({ x: 6, y: 0 }),
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    const dashboard = dashboardResponseSchema.parse(response.json()).dashboard;
    expect(
      (
        await call(
          "DELETE",
          `/v1/workspaces/${workspaceId}/connections/${second}`,
          owner,
        )
      ).statusCode,
    ).toBeLessThan(300);
    const read = await call("GET", `${base()}/${dashboard.id}`, owner);
    expect(
      dashboardResponseSchema
        .parse(read.json())
        .dashboard.slides[0]!.widgets.map((widget) => widget.type),
    ).toEqual(["metric"]);
  });

  it("stores a status board with its defaults and validates its sources (ADR 0019 §7)", async () => {
    const response = await createDashboard(owner, {
      name: "Status",
      slides: [{ widgets: [{ type: "status", x: 0, y: 0, w: 3, h: 3 }] }],
    });
    expect(response.statusCode).toBe(200);
    const dashboard = dashboardResponseSchema.parse(response.json()).dashboard;
    expect(dashboard.slides[0]!.widgets[0]).toMatchObject({
      type: "status",
      title: null,
      options: { connectionIds: null, showAge: true },
    });
    // Not a data widget: no tile, no binding.
    expect(dashboard.tiles).toEqual([]);
    expect(
      dashboard.slides[0]!.formatWarnings.filter(
        (warning) => warning.code === "rows_cut",
      ),
    ).toEqual([]);

    // Chosen sources: this workspace's connections only.
    const gone = await newConnection(workspaceId);
    const chosen = await put(dashboard, {
      slides: [
        {
          widgets: [
            {
              type: "status",
              x: 0,
              y: 0,
              w: 3,
              h: 3,
              title: "Feeds",
              options: { connectionIds: [connectionId, gone], showAge: false },
            },
          ],
        },
      ],
    });
    expect(chosen.statusCode).toBe(200);
    const saved = dashboardResponseSchema.parse(chosen.json()).dashboard;
    expect(saved.slides[0]!.widgets[0]).toMatchObject({
      title: "Feeds",
      options: { connectionIds: [connectionId, gone], showAge: false },
    });
    const foreign = await put(saved, {
      slides: [
        {
          widgets: [
            {
              type: "status",
              x: 0,
              y: 0,
              w: 3,
              h: 3,
              options: { connectionIds: [connectionId, foreignConnectionId] },
            },
          ],
        },
      ],
    });
    expectError(foreign, 400, "connection_not_found");

    // A source deleted since drops out on the next save; the board's other
    // sources stay.
    await admin`delete from connections where id = ${gone}`;
    const resaved = await put(saved, {
      slides: [
        {
          widgets: [
            {
              type: "status",
              x: 0,
              y: 0,
              w: 3,
              h: 3,
              options: { connectionIds: [connectionId, gone] },
            },
          ],
        },
      ],
    });
    expect(resaved.statusCode).toBe(200);
    expect(
      dashboardResponseSchema.parse(resaved.json()).dashboard.slides[0]!
        .widgets[0],
    ).toMatchObject({ options: { connectionIds: [connectionId] } });
  });

  it("warns (info) when a status board lists more sources than fit", async () => {
    const ids: string[] = [];
    for (let n = 0; n < 6; n++) ids.push(await newConnection(workspaceId));
    const response = await createDashboard(owner, {
      name: "Many sources",
      slides: [
        {
          widgets: [
            {
              type: "status",
              x: 0,
              y: 0,
              w: 3,
              h: 3,
              options: { connectionIds: ids },
            },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    const dashboard = dashboardResponseSchema.parse(response.json()).dashboard;
    // Five rows fit a 3 × 3 board in 16:9: four sources and "+2 more".
    expect(
      dashboard.slides[0]!.formatWarnings.find(
        (warning) => warning.format === "16x9" && warning.code === "rows_cut",
      ),
    ).toMatchObject({
      severity: "info",
      widgetId: dashboard.slides[0]!.widgets[0]!.id,
      rows: { shown: 4, limit: 6 },
    });
    await admin`delete from connections where id = any(${ids})`;
  });

  it("stores a table with its defaults and warns when its rows do not fit (ADR 0019)", async () => {
    const table = metricWidget({
      type: "table",
      w: 4,
      h: 4,
      title: "Signups",
      options: { groupBy: "resource", limit: 8 },
    });
    const response = await createDashboard(owner, {
      name: "Table",
      slides: [{ widgets: [table] }],
    });
    expect(response.statusCode).toBe(200);
    const dashboard = dashboardResponseSchema.parse(response.json()).dashboard;
    const [widget] = dashboard.slides[0]!.widgets;
    expect(widget).toMatchObject({
      type: "table",
      aggregation: "sum",
      options: {
        groupBy: "resource",
        limit: 8,
        showChange: true,
        showOthers: false,
      },
    });
    // Eight rows on a 4 × 4 table: six fit at font scale 1 in 16:9.
    expect(
      dashboard.slides[0]!.formatWarnings.find(
        (warning) => warning.format === "16x9" && warning.code === "rows_cut",
      ),
    ).toEqual({
      format: "16x9",
      code: "rows_cut",
      severity: "attention",
      widgetId: widget!.id,
      pages: null,
      rows: { shown: 6, limit: 8 },
    });
    // A table is not a tile, and counts as one data widget.
    expect(dashboard.tiles).toEqual([]);
  });

  it("stores a document of slides and widgets and reads it back", async () => {
    const dashboard = await studio({
      settings: { autoAdvance: false, defaultSlideSeconds: 45 },
    });
    expect(dashboard.settings).toEqual({
      showHeader: true,
      autoAdvance: false,
      defaultSlideSeconds: 45,
      transition: "fade",
      themeBuiltin: "netrics_dark",
      themeId: null,
      accentColor: null,
      logoImageId: null,
    });
    const [sales, notes] = dashboard.slides;
    expect(sales).toMatchObject({
      position: 0,
      name: "Sales",
      durationSeconds: 30,
      enabled: true,
    });
    expect(notes).toMatchObject({ position: 1, name: null, enabled: false });
    // Reading order, defaults filled in, metric bindings as for tiles.
    expect(sales!.widgets.map((w) => [w.type, w.x, w.y])).toEqual([
      ["metric", 0, 0],
      ["metric", 4, 0],
      ["line", 0, 2],
      ["bar", 6, 2],
    ]);
    expect(sales!.widgets[0]).toMatchObject({
      aggregation: "sum",
      title: null,
      options: { showSparkline: false, showChange: true },
    });
    expect(sales!.widgets[2]).toMatchObject({
      type: "line",
      aggregation: "last",
      resourceName: "Main site",
      options: { showPrevious: true, showAxis: true },
    });
    expect(sales!.widgets[3]).toMatchObject({
      options: { groupBy: "resource", limit: 5 },
    });
    expect(notes!.widgets).toMatchObject([
      {
        type: "text",
        text: "## Hello\n**bold**",
        options: { size: "body", align: "start" },
      },
      {
        type: "clock",
        options: { showDate: true, hour12: false, timeZone: null },
      },
      { type: "metric" },
    ]);
    // Tiles: the metric widgets of all slides in reading order.
    expect(dashboard.tiles.map((t) => [t.position, t.id])).toEqual([
      [0, sales!.widgets[0]!.id],
      [1, sales!.widgets[1]!.id],
      [2, notes!.widgets[2]!.id],
    ]);
    expect(dashboard.tiles[1]!.title).toBe("Right");

    const read = await call("GET", `${base()}/${dashboard.id}`, viewer);
    expect(dashboardResponseSchema.parse(read.json()).dashboard).toEqual(
      dashboard,
    );
    const [summary] = dashboardListResponseSchema
      .parse((await call("GET", base(), viewer)).json())
      .dashboards.filter((d) => d.id === dashboard.id);
    expect(summary).toMatchObject({
      tileCount: 3,
      slideCount: 2,
      widgetCount: 7,
    });
  });

  it("creates one empty slide without slides", async () => {
    const response = await createDashboard(owner, { name: "Blank" });
    const { dashboard } = dashboardResponseSchema.parse(response.json());
    expect(dashboard.slides).toMatchObject([
      { position: 0, name: null, durationSeconds: null, enabled: true },
    ]);
    expect(dashboard.slides[0]!.widgets).toEqual([]);
    expect(dashboard.settings).toEqual({
      showHeader: true,
      autoAdvance: true,
      defaultSlideSeconds: 20,
      transition: "fade",
      themeBuiltin: "netrics_dark",
      themeId: null,
      accentColor: null,
      logoImageId: null,
    });
  });

  it("keeps slide and widget ids across saves, sent back as read", async () => {
    const dashboard = await studio();
    const [sales, notes] = dashboard.slides;
    // The client sends back what it read, with the slides swapped and a
    // new widget without an id.
    const response = await put(dashboard, {
      settings: { transition: "none" },
      slides: [
        notes,
        {
          ...sales,
          widgets: [
            ...sales!.widgets.slice(0, 2),
            { type: "clock", x: 0, y: 7, w: 3, h: 1 },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    const next = dashboardResponseSchema.parse(response.json()).dashboard;
    expect(next.version).toBe(dashboard.version + 1);
    expect(next.settings).toMatchObject({
      transition: "none",
      autoAdvance: true,
    });
    expect(next.slides.map((s) => s.id)).toEqual([notes!.id, sales!.id]);
    expect(next.slides[0]!.widgets.map((w) => w.id)).toEqual(
      notes!.widgets.map((w) => w.id),
    );
    const ids = next.slides[1]!.widgets.map((w) => w.id);
    expect(ids.slice(0, 2)).toEqual(
      sales!.widgets.slice(0, 2).map((w) => w.id),
    );
    expect(ids[2]).not.toBe(sales!.widgets[2]!.id);

    // A stale save of the old version conflicts.
    expectError(await put(dashboard, { slides: [] }), 409, "version_conflict");

    // A duplicate copies slides and widgets under new ids.
    const copy = dashboardResponseSchema.parse(
      (
        await call("POST", `${base()}/${dashboard.id}/duplicate`, owner, {})
      ).json(),
    ).dashboard;
    expect(copy.settings).toEqual(next.settings);
    expect(
      copy.slides.map((s) => s.widgets.map((w) => [w.type, w.x, w.y])),
    ).toEqual(next.slides.map((s) => s.widgets.map((w) => [w.type, w.x, w.y])));
    const copyIds = copy.slides.flatMap((s) => [
      s.id,
      ...s.widgets.map((w) => w.id),
    ]);
    const nextIds = next.slides.flatMap((s) => [
      s.id,
      ...s.widgets.map((w) => w.id),
    ]);
    expect(copyIds.filter((id) => nextIds.includes(id))).toEqual([]);
  });

  const many = (count: number, make: (index: number) => unknown) =>
    Array.from({ length: count }, (_, index) => make(index));
  const fullSlide = () => ({
    widgets: many(16, (i) =>
      metricWidget({ x: (i % 4) * 3, y: Math.floor(i / 4) * 2 }),
    ),
  });

  it.each<[string, unknown, number, string]>([
    [
      "overlapping widgets",
      [{ widgets: [metricWidget(), metricWidget({ x: 2, y: 1 })] }],
      400,
      "widgets_overlap",
    ],
    [
      "a widget past the grid",
      [{ widgets: [metricWidget({ x: 10 })] }],
      400,
      "widget_out_of_bounds",
    ],
    [
      "a widget below the grid",
      [{ widgets: [metricWidget({ y: 7 })] }],
      400,
      "widget_out_of_bounds",
    ],
    [
      "a metric below its minimum size",
      [{ widgets: [metricWidget({ w: 2 })] }],
      400,
      "widget_too_small",
    ],
    [
      "a line below its minimum size",
      [
        {
          widgets: [metricWidget({ type: "line", w: 4, h: 2 })],
        },
      ],
      400,
      "widget_too_small",
    ],
    [
      "a text below its minimum size",
      [{ widgets: [{ type: "text", x: 0, y: 0, w: 1, h: 1, text: "x" }] }],
      400,
      "widget_too_small",
    ],
    [
      "a bar grouped by an unknown dimension",
      [
        {
          widgets: [
            metricWidget({
              type: "bar",
              w: 4,
              h: 3,
              options: { groupBy: "country" },
            }),
          ],
        },
      ],
      400,
      "unknown_dimension",
    ],
    [
      "a table below its 4 × 4 minimum",
      [
        {
          widgets: [
            metricWidget({
              type: "table",
              w: 4,
              h: 3,
              options: { groupBy: "resource" },
            }),
          ],
        },
      ],
      400,
      "widget_too_small",
    ],
    [
      "a table grouped by an unknown dimension",
      [
        {
          widgets: [
            metricWidget({
              type: "table",
              w: 4,
              h: 4,
              options: { groupBy: "country" },
            }),
          ],
        },
      ],
      400,
      "unknown_dimension",
    ],
    [
      "a status board below its 3 × 3 minimum",
      [{ widgets: [{ type: "status", x: 0, y: 0, w: 3, h: 2 }] }],
      400,
      "widget_too_small",
    ],
    [
      "a status board with more than 12 sources",
      [
        {
          widgets: [
            {
              type: "status",
              x: 0,
              y: 0,
              w: 3,
              h: 3,
              options: {
                connectionIds: Array.from(
                  { length: 13 },
                  (_, n) =>
                    `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
                ),
              },
            },
          ],
        },
      ],
      400,
      "invalid_request",
    ],
    [
      "a status board with an empty list of sources",
      [
        {
          widgets: [
            {
              type: "status",
              x: 0,
              y: 0,
              w: 3,
              h: 3,
              options: { connectionIds: [] },
            },
          ],
        },
      ],
      400,
      "invalid_request",
    ],
    [
      "a table with more than 10 rows",
      [
        {
          widgets: [
            metricWidget({
              type: "table",
              w: 4,
              h: 4,
              options: { groupBy: "resource", limit: 11 },
            }),
          ],
        },
      ],
      400,
      "invalid_request",
    ],
    [
      "a bar without grouping",
      [{ widgets: [metricWidget({ type: "bar", w: 4, h: 3 })] }],
      400,
      "invalid_request",
    ],
    [
      "a text widget without text",
      [{ widgets: [{ type: "text", x: 0, y: 0, w: 2, h: 1 }] }],
      400,
      "invalid_request",
    ],
    [
      "a data widget without a metric",
      [{ widgets: [{ type: "metric", x: 0, y: 0, w: 3, h: 2 }] }],
      400,
      "invalid_request",
    ],
    [
      "an unknown widget type",
      [{ widgets: [{ type: "gauge", x: 0, y: 0, w: 3, h: 3 }] }],
      400,
      "invalid_request",
    ],
    [
      "a text over 500 characters",
      [
        {
          widgets: [
            { type: "text", x: 0, y: 0, w: 2, h: 1, text: "x".repeat(501) },
          ],
        },
      ],
      400,
      "invalid_request",
    ],
    [
      "a slide name over 60 characters",
      [{ name: "x".repeat(61), widgets: [] }],
      400,
      "invalid_request",
    ],
    [
      "a slide duration under 5 seconds",
      [{ durationSeconds: 4, widgets: [] }],
      400,
      "invalid_request",
    ],
    [
      "an unknown clock time zone",
      [
        {
          widgets: [
            {
              type: "clock",
              x: 0,
              y: 0,
              w: 2,
              h: 1,
              options: { timeZone: "Mars/Olympus" },
            },
          ],
        },
      ],
      400,
      "invalid_request",
    ],
    ["13 slides", many(13, () => ({ widgets: [] })), 400, "invalid_request"],
    [
      "17 widgets on a slide",
      [
        {
          widgets: many(17, (i) => ({
            type: "clock",
            x: (i % 6) * 2,
            y: Math.floor(i / 6),
            w: 2,
            h: 1,
          })),
        },
      ],
      400,
      "invalid_request",
    ],
    [
      "49 data widgets",
      [fullSlide(), fullSlide(), fullSlide(), { widgets: [metricWidget()] }],
      400,
      "too_many_data_widgets",
    ],
    [
      "another workspace's connection",
      [{ widgets: [metricWidget({ connectionId: "foreign" })] }],
      400,
      "tile_metric_not_found",
    ],
    [
      "a resource of no connection",
      [{ widgets: [metricWidget({ dimensions: { resource: "site-9" } })] }],
      400,
      "unknown_resource",
    ],
    [
      "a compare widget without a denominator",
      [{ widgets: [metricWidget({ type: "compare", w: 4, h: 3 })] }],
      400,
      "invalid_request",
    ],
    [
      "a compare widget below its 4 × 3 minimum",
      [{ widgets: [compareWidget({ w: 3, h: 3 })] }],
      400,
      "widget_too_small",
    ],
    [
      "a compare widget over another workspace's connection",
      [{ widgets: [compareWidget({}, { connectionId: "foreign" })] }],
      400,
      "tile_metric_not_found",
    ],
    [
      "a compare widget over an unknown metric",
      [{ widgets: [compareWidget({}, { metricKey: "demo.nope" })] }],
      400,
      "tile_metric_not_found",
    ],
    [
      "a compare widget's denominator with an unknown filter",
      [{ widgets: [compareWidget({}, { dimensions: { country: "DE" } })] }],
      400,
      "unknown_dimension",
    ],
    [
      "a compare widget with a long ratio label",
      [
        {
          widgets: [compareWidget({ options: { ratioLabel: "x".repeat(31) } })],
        },
      ],
      400,
      "invalid_request",
    ],
    [
      "an amount over a count as a percentage",
      [
        {
          widgets: [
            compareWidget({
              metricKey: "demo.proceeds",
              dimensions: { currency: "EUR" },
            }),
          ],
        },
      ],
      400,
      "compare_units_incompatible",
    ],
    [
      "a count over an amount",
      [
        {
          widgets: [
            compareWidget(
              { options: { format: "ratio" } },
              { metricKey: "demo.ad_spend" },
            ),
          ],
        },
      ],
      400,
      "compare_units_incompatible",
    ],
    [
      "amounts in two currencies",
      [
        {
          widgets: [
            compareWidget(
              {
                metricKey: "demo.proceeds",
                dimensions: { currency: "USD" },
                options: { format: "ratio" },
              },
              { metricKey: "demo.ad_spend" },
            ),
          ],
        },
      ],
      400,
      "compare_units_incompatible",
    ],
    [
      "a display currency that converts neither side",
      [{ widgets: [compareWidget({ displayCurrency: "EUR" })] }],
      400,
      "currency_choice_conflict",
    ],
  ])("refuses %s", async (_label, slides, status, error) => {
    const resolved = JSON.parse(
      JSON.stringify(slides)
        .replaceAll('"foreign"', `"${foreignConnectionId}"`)
        .replaceAll('"own"', `"${connectionId}"`),
    ) as unknown;
    expectError(
      await createDashboard(owner, { name: "Invalid", slides: resolved }),
      status,
      error,
    );
    const dashboard = dashboardResponseSchema.parse(
      (await createDashboard(owner, { name: "Valid" })).json(),
    ).dashboard;
    expectError(await put(dashboard, { slides: resolved }), status, error);
  });

  it("accepts 48 data widgets and tiles or slides, not both", async () => {
    const response = await createDashboard(owner, {
      name: "Full",
      slides: [fullSlide(), fullSlide(), fullSlide()],
    });
    expect(response.statusCode).toBe(200);
    expectError(
      await createDashboard(owner, {
        name: "Both",
        tiles: [signupsTile()],
        slides: [],
      }),
      400,
      "invalid_request",
    );
    const { dashboard } = dashboardResponseSchema.parse(response.json());
    expectError(await put(dashboard, {}), 400, "invalid_request");
  });

  it("lists theme, accent, thumbnail and screens per workspace (#304)", async () => {
    const theme = themeResponseSchema.parse(
      (
        await call("POST", `/v1/workspaces/${workspaceId}/themes`, owner, {
          name: "Wall green",
          base: "midnight",
        })
      ).json(),
    ).theme;
    const branded = await studio({
      name: "Branded",
      settings: { themeId: theme.id, accentColor: "#E5572F" },
    });
    const plain = await studio({
      name: "Plain",
      settings: { themeBuiltin: "paper" },
      slides: [{ enabled: false, widgets: [metricWidget()] }],
    });
    await admin`insert into devices (workspace_id, name, dashboard_id, revoked_at)
                values (${workspaceId}, 'Wall', ${branded.id}, null),
                       (${workspaceId}, 'Gone', ${branded.id}, now())`;

    const strangers = await newWorkspace(stranger);
    const theirs = dashboardResponseSchema.parse(
      (
        await call("POST", `/v1/workspaces/${strangers}/dashboards`, stranger, {
          name: "Theirs",
        })
      ).json(),
    ).dashboard;
    await admin`insert into devices (workspace_id, name, dashboard_id)
                values (${strangers}, 'Their wall', ${theirs.id}),
                       (${strangers}, 'Their lobby', ${theirs.id})`;

    const list = dashboardListResponseSchema.parse(
      (await call("GET", base(), viewer)).json(),
    ).dashboards;
    expect(list.find((d) => d.id === branded.id)).toMatchObject({
      theme: { builtin: null, id: theme.id, name: "Wall green" },
      accent: "#e5572f",
      primaryFormat: "16x9",
      screenCount: 1,
      preview: {
        background: theme.tokens.background,
        surface: theme.tokens.surface,
        border: theme.tokens.border,
        // The first slide's widgets in reading order.
        widgets: [
          { type: "metric", x: 0, y: 0, w: 3, h: 2 },
          { type: "metric", x: 4, y: 0, w: 3, h: 2 },
          { type: "line", x: 0, y: 2, w: 6, h: 4 },
          { type: "bar", x: 6, y: 2, w: 6, h: 6 },
        ],
      },
    });
    expect(list.find((d) => d.id === plain.id)).toMatchObject({
      theme: { builtin: "paper", id: null, name: "Paper" },
      accent: BUILTIN_THEMES.paper.tokens.accent,
      screenCount: 0,
      preview: {
        background: BUILTIN_THEMES.paper.tokens.background,
        widgets: [],
      },
    });
    expect(list.map((d) => d.id)).not.toContain(theirs.id);

    // The stranger sees only their own dashboard and screens, and cannot
    // list this workspace.
    const strangersList = dashboardListResponseSchema.parse(
      (
        await call("GET", `/v1/workspaces/${strangers}/dashboards`, stranger)
      ).json(),
    ).dashboards;
    expect(strangersList.map((d) => [d.id, d.screenCount])).toEqual([
      [theirs.id, 2],
    ]);
    expectError(
      await call("GET", base(), stranger),
      404,
      "workspace_not_found",
    );
  });

  it("keeps slides and widgets inside their workspace", async () => {
    const dashboard = await studio();
    const strangers = await newWorkspace(stranger);
    const strangerConnection = await newConnection(strangers);
    const foreignBase = `/v1/workspaces/${strangers}/dashboards`;
    // Another workspace's dashboard id is unknown there.
    expectError(
      await call("PUT", `${foreignBase}/${dashboard.id}`, stranger, {
        version: dashboard.version,
        name: "Hijack",
        projectId: null,
        slides: [],
      }),
      404,
      "dashboard_not_found",
    );
    // Ids of another workspace's slides and widgets are not taken over.
    const own = dashboardResponseSchema.parse(
      (await call("POST", foreignBase, stranger, { name: "Mine" })).json(),
    ).dashboard;
    const sales = dashboard.slides[0]!;
    const response = await call("PUT", `${foreignBase}/${own.id}`, stranger, {
      version: own.version,
      name: own.name,
      projectId: null,
      slides: [
        {
          id: sales.id,
          widgets: [
            {
              ...sales.widgets[0],
              connectionId: strangerConnection,
            },
          ],
        },
      ],
    });
    expect(response.statusCode).toBe(200);
    const saved = dashboardResponseSchema.parse(response.json()).dashboard;
    expect(saved.slides[0]!.id).not.toBe(sales.id);
    expect(saved.slides[0]!.widgets[0]!.id).not.toBe(sales.widgets[0]!.id);
    const after = dashboardResponseSchema.parse(
      (await call("GET", `${base()}/${dashboard.id}`, owner)).json(),
    ).dashboard;
    expect(after).toEqual(dashboard);
  });

  describe("legacy tile saves", () => {
    async function tileDashboard(count: number) {
      const response = await createDashboard(owner, {
        name: `${count} tiles`,
        tiles: many(count, (i) =>
          signupsTile({ title: `Tile ${i}`, period: "today" }),
        ),
      });
      expect(response.statusCode).toBe(200);
      return dashboardResponseSchema.parse(response.json()).dashboard;
    }

    it("lays tiles out like the TV grid and keeps working on them", async () => {
      const dashboard = await tileDashboard(17);
      expect(dashboard.slides).toHaveLength(2);
      expect(dashboard.slides[1]!.widgets).toMatchObject([
        { type: "metric", x: 0, y: 0, w: 12, h: 8, title: "Tile 16" },
      ]);
      expect(dashboard.tiles.map((t) => t.title)).toEqual(
        many(17, (i) => `Tile ${i}`),
      );
      // The tile editor saves 7 tiles: one slide again, same slide id.
      const response = await put(dashboard, {
        tiles: many(7, () => signupsTile()),
      });
      expect(response.statusCode).toBe(200);
      const next = dashboardResponseSchema.parse(response.json()).dashboard;
      expect(next.slides.map((s) => s.id)).toEqual([dashboard.slides[0]!.id]);
      expect(next.slides[0]!.widgets.map((w) => [w.x, w.y, w.w, w.h])).toEqual([
        [0, 0, 3, 4],
        [3, 0, 3, 4],
        [6, 0, 3, 4],
        [9, 0, 3, 4],
        [0, 4, 3, 4],
        [3, 4, 3, 4],
        [6, 4, 3, 4],
      ]);
      // An empty tile list keeps one empty slide.
      const emptied = await put(next, { tiles: [] });
      expect(emptied.statusCode).toBe(200);
      expect(
        dashboardResponseSchema.parse(emptied.json()).dashboard.slides,
      ).toMatchObject([{ widgets: [] }]);
    });

    it.each<[string, (slides: ReturnType<typeof studioSlides>) => unknown]>([
      ["a moved widget", () => [{ widgets: [metricWidget({ x: 3 })] }]],
      [
        "a text widget",
        () => [
          {
            widgets: [{ type: "text", x: 0, y: 0, w: 2, h: 1, text: "Hi" }],
          },
        ],
      ],
      [
        "a named slide",
        () => [{ name: "Sales", widgets: [metricWidget({ w: 12, h: 8 })] }],
      ],
      [
        "a disabled slide",
        () => [{ enabled: false, widgets: [metricWidget({ w: 12, h: 8 })] }],
      ],
      [
        "a widget without its sparkline",
        () => [
          {
            widgets: [
              metricWidget({ w: 12, h: 8, options: { showSparkline: false } }),
            ],
          },
        ],
      ],
      ["a second slide", (slides) => slides],
    ])(
      "refuses to flatten a studio dashboard with %s (409)",
      async (_label, make) => {
        const dashboard = await studio({ slides: make(studioSlides()) });
        // What a stale tab of the tile editor sends.
        const response = await put(dashboard, {
          tiles: [signupsTile()],
        });
        expectError(response, 409, "studio_dashboard");
        const after = dashboardResponseSchema.parse(
          (await call("GET", `${base()}/${dashboard.id}`, owner)).json(),
        ).dashboard;
        expect(after).toEqual(dashboard);
      },
    );

    it("answers a stale tile save with version_conflict first", async () => {
      const dashboard = await tileDashboard(2);
      expect(
        (await put(dashboard, { tiles: [signupsTile()] })).statusCode,
      ).toBe(200);
      expectError(
        await put(dashboard, { tiles: [signupsTile()] }),
        409,
        "version_conflict",
      );
    });
  });
});
