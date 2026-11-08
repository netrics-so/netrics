import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareMeasurePreviewResponseSchema,
  compareMeasureResponseSchema,
  modelQueryResponseSchema,
  workspaceResponseSchema,
  type CompareMeasureRequest,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  COMPARE_MEASURE_REFUSALS,
  addDays,
  amountCurrency,
  compareChange,
  compareRatioUnit,
  resolvePeriod,
  type CompareFormat,
  type DataExpression,
  type Period,
} from "@netrics/domain";
import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import {
  buildDeviceDashboardV3,
  type DeviceDashboardV3Content,
} from "./devices/dashboard.js";
import { loadConfig } from "./env.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";

// #506: a compare widget compiled into a generated preparation and a draft
// model. The published measure must give what the widget gives
// (compareWidgetOf over queryMetric) for the same scope and dates.

const NOW = new Date("2026-11-07T15:30:00Z");
const ZONE = "Europe/Berlin";
const TODAY = "2026-11-07";

let testDb: TestDatabase;
let app: FastifyInstance;
let db: Database;
let raw: Sql;
let owner: string, viewer: string, stranger: string;
let workspaceId: string, connectionId: string, secondId: string;

const call = (
  method: "GET" | "POST" | "PUT",
  path: string,
  cookie: string | undefined,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: `/v1/workspaces/${workspaceId}/data${path}`,
    headers: cookie ? { cookie } : {},
    ...(payload === undefined
      ? {}
      : { payload: payload as InjectOptions["payload"] }),
  });

async function signup(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function observe(
  connection: string,
  metricKey: string,
  dimensions: Record<string, string>,
  value: (day: number) => number | null,
  timestamp: (date: string) => string = (date) => `${date}T00:00:00Z`,
) {
  const rows: Array<{ dimensions: string; at: string; value: number }> = [];
  for (let day = 0; day < 200; day++) {
    const v = value(day);
    if (v === null) continue;
    rows.push({
      dimensions: JSON.stringify(dimensions),
      at: timestamp(addDays(TODAY, -day)),
      value: v,
    });
  }
  await raw`
    insert into observations (workspace_id, connection_id,
      metric_definition_id, dimensions, source_timestamp, value)
    select ${workspaceId}, ${connection}, m.id, r.dimensions::jsonb,
           r.at::timestamptz, r.value::double precision
    from metric_definitions m,
         json_to_recordset(${raw.json(rows)}::json)
           as r(dimensions text, at text, value double precision)
    where m.connector_id = 'cmp' and m.key = ${metricKey}`;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  raw = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
  });
  owner = await signup("compare-owner@example.com");
  viewer = await signup("compare-viewer@example.com");
  stranger = await signup("compare-stranger@example.com");
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: owner },
    payload: { name: "Compare" },
  });
  workspaceId = workspaceResponseSchema.parse(created.json()).workspace.id;
  expect(
    (
      await addMemberViaInvitation(
        app,
        db,
        owner,
        workspaceId,
        "compare-viewer@example.com",
        "viewer",
      )
    ).statusCode,
  ).toBe(200);
  await raw`update workspaces set time_zone = ${ZONE} where id = ${workspaceId}`;
  await raw`insert into connectors (id, version, manifest) values
    ('cmp', '1.0.0', ${raw.json({ id: "cmp" })})`;
  await raw`
    insert into metric_definitions (connector_id, key, name, description,
      kind, unit, granularity, dimensions, aggregations)
    values
      ('cmp', 'cmp.visits', 'Visits', '', 'delta', 'count', 'day',
       '["resource"]', '["sum","avg","min","max"]'),
      ('cmp', 'cmp.signups', 'Signups', '', 'delta', 'count', 'day',
       '["resource"]', '["sum","avg","min","max"]'),
      ('cmp', 'cmp.users', 'Active users', '', 'gauge', 'users', 'day',
       '["resource"]', '["last","avg","min","max"]'),
      ('cmp', 'cmp.spend', 'Spend', '', 'delta', 'EUR_minor', 'day',
       '["resource"]', '["sum","avg"]'),
      ('cmp', 'cmp.proceeds', 'Proceeds', '', 'delta', 'currency_minor',
       'day', '["resource","currency"]', '["sum","avg"]'),
      ('cmp', 'cmp.hourly', 'Requests', '', 'delta', 'count', 'hour',
       '[]', '["sum"]'),
      ('cmp', 'cmp.total', 'All-time installs', '', 'counter', 'count',
       'day', '[]', '["last","max"]')`;
  const [first] = await raw`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'cmp', 'Shop') returning id`;
  connectionId = first!.id as string;
  const [second] = await raw`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'cmp', 'Blog') returning id`;
  secondId = second!.id as string;
  // 200 days, with gaps and zero days, so averages and missing previous
  // values differ from plain sums.
  await observe(connectionId, "cmp.visits", { resource: "app-1" }, (d) =>
    d === 40 ? null : 100 + ((d * 7) % 23),
  );
  await observe(connectionId, "cmp.visits", { resource: "app-2" }, (d) =>
    d % 5 === 4 ? null : 40 + (d % 9),
  );
  await observe(connectionId, "cmp.signups", { resource: "app-1" }, (d) =>
    d % 4 === 3 ? null : 3 + (d % 6),
  );
  await observe(connectionId, "cmp.signups", { resource: "app-2" }, (d) =>
    d % 3 === 0 ? 0 : 1 + (d % 2),
  );
  await observe(connectionId, "cmp.users", { resource: "app-1" }, (d) =>
    d % 7 === 2 ? null : 500 + ((d * 13) % 37),
  );
  await observe(connectionId, "cmp.users", { resource: "app-2" }, (d) =>
    d < 3 ? null : 80 + (d % 11),
  );
  await observe(
    connectionId,
    "cmp.proceeds",
    { resource: "app-1", currency: "EUR" },
    (d) => 990 * (1 + (d % 3)),
  );
  await observe(
    connectionId,
    "cmp.proceeds",
    { resource: "app-1", currency: "USD" },
    (d) => 1290 * (1 + (d % 2)),
  );
  await observe(connectionId, "cmp.spend", { resource: "app-1" }, (d) =>
    d % 8 === 7 ? null : 2500 + ((d * 31) % 700),
  );
  await observe(secondId, "cmp.visits", { resource: "blog" }, (d) =>
    d % 6 === 5 ? null : 300 + ((d * 5) % 17),
  );
  await observe(
    connectionId,
    "cmp.hourly",
    {},
    () => 5,
    (date) => `${date}T10:00:00Z`,
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
  await raw?.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// The widget side: compare widgets on a dashboard, built for a screen.

let dashboardCount = 0;
const uuid = (group: number, n: number) =>
  `${String(group).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
type ScreenWidget =
  DeviceDashboardV3Content["slides"][number]["widgets"][number];

type Binding = {
  connectionId?: string;
  metricKey: string;
  aggregation?: "sum" | "avg" | "min" | "max" | "last";
  dimensions?: Record<string, string>;
};
type Case = {
  name: string;
  numerator: Binding;
  denominator: Binding;
  format: CompareFormat;
  currency?: string;
};

/** A dashboard of compare widgets, one per period, and its screen payload. */
async function widgetsFor(
  compare: Case,
  periods: readonly Period[],
): Promise<Map<Period, ScreenWidget>> {
  const index = ++dashboardCount;
  const dashboardId = uuid(index, 0);
  const slideId = uuid(index, 1);
  await raw`insert into dashboards (id, workspace_id, name)
    values (${dashboardId}, ${workspaceId}, ${compare.name})`;
  await raw`insert into dashboard_slides (id, dashboard_id, workspace_id, position)
    values (${slideId}, ${dashboardId}, ${workspaceId}, 0)`;
  const pin = (binding: Binding) =>
    compare.currency && binding.metricKey === "cmp.proceeds"
      ? { currency: compare.currency, ...binding.dimensions }
      : (binding.dimensions ?? {});
  for (const [i, period] of periods.entries()) {
    const widgetId = uuid(index, 100 + i);
    await raw`
      insert into dashboard_widgets ${raw({
        id: widgetId,
        slide_id: slideId,
        dashboard_id: dashboardId,
        workspace_id: workspaceId,
        type: "compare",
        x: i * 3,
        y: 0,
        w: 3,
        h: 3,
        connection_id: compare.numerator.connectionId ?? connectionId,
        metric_key: compare.numerator.metricKey,
        aggregation: compare.numerator.aggregation ?? "sum",
        period,
        denominator_connection_id:
          compare.denominator.connectionId ?? connectionId,
        denominator_metric_key: compare.denominator.metricKey,
        denominator_aggregation: compare.denominator.aggregation ?? "sum",
      })}`;
    await raw`
      update dashboard_widgets
      set options = ${raw.json({ format: compare.format })},
          dimensions = ${raw.json(pin(compare.numerator))},
          denominator_dimensions = ${raw.json(pin(compare.denominator))}
      where id = ${widgetId}`;
  }
  const payload = await withWorkspace(
    db,
    { workspaceId },
    (tx) => buildDeviceDashboardV3(tx, workspaceId, dashboardId, { now: NOW }),
    { isolationLevel: "repeatable read" },
  );
  const widgets = payload.slides[0]!.widgets;
  return new Map(periods.map((period, i) => [period, widgets[i]!]));
}

const between = (from: string, to: string): DataExpression => ({
  kind: "call",
  fn: "and",
  args: [
    {
      kind: "call",
      fn: "gte",
      args: [
        { kind: "field", fieldId: "date" },
        { kind: "literal", type: "date", value: from },
      ],
    },
    {
      kind: "call",
      fn: "lte",
      args: [
        { kind: "field", fieldId: "date" },
        { kind: "literal", type: "date", value: to },
      ],
    },
  ],
});

const request = (compare: Case, period: Period): CompareMeasureRequest => ({
  name: compare.name,
  connectionId: compare.numerator.connectionId ?? connectionId,
  metricKey: compare.numerator.metricKey,
  ...(compare.numerator.aggregation
    ? { aggregation: compare.numerator.aggregation }
    : {}),
  period,
  ...(compare.numerator.dimensions
    ? { dimensions: compare.numerator.dimensions }
    : {}),
  denominator: {
    connectionId: compare.denominator.connectionId ?? connectionId,
    metricKey: compare.denominator.metricKey,
    ...(compare.denominator.aggregation
      ? { aggregation: compare.denominator.aggregation }
      : {}),
    ...(compare.denominator.dimensions
      ? { dimensions: compare.denominator.dimensions }
      : {}),
  },
  format: compare.format,
  ...(compare.currency ? { currency: compare.currency } : {}),
});

const SUPPORTED: readonly Period[] = [
  "today",
  "last_7_days",
  "last_30_days",
  "last_90_days",
];

describe("compare widgets as measures: parity (#506)", () => {
  const cases: Case[] = [
    {
      name: "Signup rate",
      numerator: { metricKey: "cmp.signups" },
      denominator: { metricKey: "cmp.visits" },
      format: "percent",
    },
    {
      name: "Share of app-2",
      numerator: { metricKey: "cmp.visits", dimensions: { resource: "app-2" } },
      denominator: { metricKey: "cmp.visits" },
      format: "percent",
    },
    {
      name: "Signups per visit",
      numerator: {
        metricKey: "cmp.signups",
        dimensions: { resource: "app-1" },
      },
      denominator: {
        metricKey: "cmp.visits",
        dimensions: { resource: "app-1" },
      },
      format: "ratio",
    },
    {
      name: "Daily average signups per visit",
      numerator: { metricKey: "cmp.signups", aggregation: "avg" },
      denominator: { metricKey: "cmp.visits", aggregation: "avg" },
      format: "ratio",
    },
    {
      name: "Visits per active user",
      numerator: { metricKey: "cmp.visits", aggregation: "sum" },
      denominator: { metricKey: "cmp.users", aggregation: "avg" },
      format: "ratio",
    },
    {
      name: "Shop over blog visits",
      numerator: { metricKey: "cmp.visits" },
      denominator: { metricKey: "cmp.visits", connectionId: "second" },
      format: "ratio",
    },
    {
      name: "Revenue per signup",
      numerator: { metricKey: "cmp.proceeds" },
      denominator: { metricKey: "cmp.signups" },
      format: "ratio",
      currency: "EUR",
    },
    {
      name: "Average revenue per visit",
      numerator: {
        metricKey: "cmp.proceeds",
        aggregation: "avg",
        dimensions: { currency: "USD" },
      },
      denominator: { metricKey: "cmp.visits", aggregation: "avg" },
      format: "ratio",
    },
    {
      name: "Spend per signup",
      numerator: { metricKey: "cmp.spend" },
      denominator: { metricKey: "cmp.signups" },
      format: "ratio",
    },
    {
      name: "Return on spend",
      numerator: { metricKey: "cmp.proceeds" },
      denominator: { metricKey: "cmp.spend" },
      format: "ratio",
      currency: "EUR",
    },
    {
      name: "Spend per proceeds",
      numerator: { metricKey: "cmp.spend" },
      denominator: { metricKey: "cmp.proceeds" },
      format: "ratio",
      currency: "EUR",
    },
  ];

  it.each(cases)(
    "$name: the published measure equals the widget for every supported period",
    async (raw0) => {
      const compare: Case = {
        ...raw0,
        denominator: {
          ...raw0.denominator,
          ...(raw0.denominator.connectionId === "second"
            ? { connectionId: secondId }
            : {}),
        },
      };
      const widgets = await widgetsFor(compare, SUPPORTED);
      // The model is the same for every supported period: a closed date
      // range against the range before it.
      const created = await call(
        "POST",
        "/compare-measures",
        owner,
        request(compare, "last_7_days"),
      );
      expect(created.statusCode, created.body).toBe(200);
      const result = compareMeasureResponseSchema.parse(created.json());
      const published = await call(
        "POST",
        `/models/${result.modelId}/publish`,
        owner,
        { version: result.modelVersion },
      );
      expect(published.statusCode, published.body).toBe(200);
      for (const period of SUPPORTED) {
        const window = resolvePeriod(period, NOW, ZONE);
        const queried = await call(
          "POST",
          `/models/${result.modelId}/query`,
          owner,
          {
            measureIds: Object.values(result.measures),
            groupBy: [],
            filter: between(window.dates.from, window.dates.to),
          },
        );
        expect(queried.statusCode, queried.body).toBe(200);
        const cells = modelQueryResponseSchema.parse(queried.json()).rows[0]!
          .measures;
        const value = (id: string) =>
          cells[id]!.value === null ? null : Number(cells[id]!.value);
        const widget = widgets.get(period)!;
        if (widget.type !== "compare") throw new Error("not a compare");
        const expected = {
          numerator: widget.data.numerator.value,
          denominator: widget.data.denominator.value,
          ratio: widget.data.ratio.value,
          previous: widget.data.ratio.previousValue,
          change:
            compareChange({
              value: widget.data.ratio.value,
              previousValue: widget.data.ratio.previousValue,
              format: compare.format,
            })?.value ?? null,
        };
        // Every side has values in every window here: no vacuous nulls.
        expect(expected.ratio, period).not.toBeNull();
        expect(expected.previous, period).not.toBeNull();
        for (const key of Object.keys(expected) as Array<
          keyof typeof expected
        >) {
          const actual = value(result.measures[key]);
          const wanted = expected[key];
          if (wanted === null) expect(actual, `${period} ${key}`).toBeNull();
          else expect(actual, `${period} ${key}`).toBeCloseTo(wanted, 9);
        }
        expect(cells[result.measures.previous]!.comparedTo).toEqual(
          window.previousDates,
        );
        // The ratio has the widget's unit (compareRatioUnit): an amount per
        // unit in the numerator's currency, else none. A per-currency
        // amount reads as `currency_minor` with its currency ("EUR_minor").
        const ratioUnit = compareRatioUnit(
          widget.data.numerator.unit,
          widget.data.denominator.unit,
        );
        for (const id of [result.measures.ratio, result.measures.previous]) {
          const cell = cells[id]!;
          if (cell.currency !== undefined)
            expect(cell.unit, `${period} ${id}`).toBe("currency_minor");
          expect(
            cell.currency ? `${cell.currency}_minor` : (cell.unit ?? null),
            `${period} ${id}`,
          ).toBe(ratioUnit);
          if (ratioUnit !== null)
            expect(amountCurrency(ratioUnit)).not.toBeNull();
        }
      }
    },
    60_000,
  );
});

describe("compare widgets as measures: refusals (#506)", () => {
  const refused = async (
    body: CompareMeasureRequest,
    error: (typeof COMPARE_MEASURE_REFUSALS)[number],
    status = 400,
  ) => {
    const response = await call("POST", "/compare-measures", owner, body);
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toEqual({ error });
    // The preview (#508) refuses the same way, before anything is created.
    const preview = await call(
      "POST",
      "/compare-measures/preview",
      owner,
      body,
    );
    expect(preview.statusCode, preview.body).toBe(status);
    expect(preview.json()).toEqual({ error });
  };
  const base = (overrides: Partial<CompareMeasureRequest> = {}) =>
    ({
      name: "Refused",
      connectionId,
      metricKey: "cmp.signups",
      period: "last_7_days",
      denominator: { connectionId, metricKey: "cmp.visits" },
      format: "percent",
      ...overrides,
    }) as CompareMeasureRequest;

  it.each(["min", "max"] as const)(
    "refuses %s over day totals",
    async (aggregation) => {
      await refused(base({ aggregation }), "compare_aggregation_unsupported");
    },
  );

  it("refuses last over day totals", async () => {
    await refused(
      base({
        denominator: {
          connectionId,
          metricKey: "cmp.users",
          aggregation: "last",
        },
      }),
      "compare_aggregation_unsupported",
    );
    // A counter has only last and max: never a measure.
    await refused(
      base({ metricKey: "cmp.total", format: "ratio" }),
      "compare_aggregation_unsupported",
    );
  });

  it("refuses an amount per currency without a pinned currency", async () => {
    await refused(
      base({ metricKey: "cmp.proceeds", format: "ratio" }),
      "compare_currency_unpinned",
    );
  });

  it("refuses hourly metrics, also for today", async () => {
    for (const period of ["today", "last_7_days"] as const)
      await refused(
        base({ metricKey: "cmp.hourly", format: "ratio", period }),
        "compare_granularity_unsupported",
      );
  });

  it.each([
    "this_quarter",
    "this_week",
    "this_month",
    "this_year",
    "last_12_months",
  ] as const)("compiles %s (#507)", async (period) => {
    // A bound widget reads `ratio` over its own two windows, so no period
    // is refused any more.
    const response = await call("POST", "/compare-measures", owner, {
      ...base({ period }),
      name: `Every period ${period}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    compareMeasureResponseSchema.parse(response.json());
  });

  it("refuses an unavailable source", async () => {
    await refused(
      base({ metricKey: "cmp.missing" }),
      "compare_source_unavailable",
      404,
    );
    await refused(
      base({
        denominator: {
          connectionId: "00000000-0000-4000-8000-000000000000",
          metricKey: "cmp.visits",
        },
      }),
      "compare_source_unavailable",
      404,
    );
  });

  it("refuses units that cannot form the ratio", async () => {
    await refused(
      base({ metricKey: "cmp.proceeds", currency: "EUR" }),
      "compare_units_incompatible",
    );
  });

  it.each(["/compare-measures", "/compare-measures/preview"])(
    "needs a member who may publish data (%s)",
    async (path) => {
      expect((await call("POST", path, undefined, base())).statusCode).toBe(
        401,
      );
      expect((await call("POST", path, viewer, base())).statusCode).toBe(403);
      expect((await call("POST", path, stranger, base())).statusCode).toBe(404);
    },
  );
});

describe("compare widgets as measures: drafts (#506)", () => {
  it("never changes published dashboards", async () => {
    const compare: Case = {
      name: "Draft only",
      numerator: { metricKey: "cmp.signups" },
      denominator: { metricKey: "cmp.visits" },
      format: "percent",
    };
    const before = await widgetsFor(compare, ["last_7_days"]);
    const dashboards = async () =>
      raw`select id, version, updated_at from dashboards
          where workspace_id = ${workspaceId} order by id`;
    const widgetRows = async () =>
      raw`select * from dashboard_widgets
          where workspace_id = ${workspaceId} order by id`;
    const [savedDashboards, savedWidgets] = [
      await dashboards(),
      await widgetRows(),
    ];
    const created = await call(
      "POST",
      "/compare-measures",
      owner,
      request(compare, "last_7_days"),
    );
    expect(created.statusCode, created.body).toBe(200);
    const result = compareMeasureResponseSchema.parse(created.json());
    // The model stays a draft: nothing can read it yet.
    const model = await call("GET", `/models/${result.modelId}`, owner);
    expect(model.json().model.publishedVersion).toBeNull();
    const query = await call("POST", `/models/${result.modelId}/query`, owner, {
      measureIds: [result.measures.ratio],
      groupBy: [],
      filter: between(addDays(TODAY, -6), TODAY),
    });
    expect(query.statusCode).toBe(409);
    expect(query.json()).toEqual({ error: "data_model_not_published" });
    // The preparation is editable and published for the model to read.
    const preparation = await call(
      "GET",
      `/preparations/${result.preparationId}`,
      owner,
    );
    expect(preparation.json().preparation).toMatchObject({
      name: "Draft only",
      publishedVersion: 1,
    });
    expect(
      preparation
        .json()
        .preparation.graph.nodes.map((node: { type: string }) => node.type),
    ).toEqual(["source", "calculate", "source", "calculate", "append"]);
    // Dashboards, widgets and what screens show are unchanged.
    expect(await dashboards()).toEqual(savedDashboards);
    expect(await widgetRows()).toEqual(savedWidgets);
    const dashboardId = uuid(dashboardCount, 0);
    const after = await withWorkspace(
      db,
      { workspaceId },
      (tx) =>
        buildDeviceDashboardV3(tx, workspaceId, dashboardId, { now: NOW }),
      { isolationLevel: "repeatable read" },
    );
    expect(after.slides[0]!.widgets[0]).toEqual(before.get("last_7_days"));
  });
});

describe("compare widgets as measures: preview (#508)", () => {
  const counts = async () =>
    raw`select
      (select count(*)::int from data_preparations
        where workspace_id = ${workspaceId}) as preparations,
      (select count(*)::int from data_models
        where workspace_id = ${workspaceId}) as models`;

  it("shows what would be created, and creates nothing", async () => {
    const body = request(
      {
        name: "Proceeds per signup",
        numerator: { metricKey: "cmp.proceeds" },
        denominator: { metricKey: "cmp.signups", aggregation: "avg" },
        format: "ratio",
        currency: "EUR",
      },
      "last_30_days",
    );
    const before = await counts();
    const response = await call(
      "POST",
      "/compare-measures/preview",
      owner,
      body,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const preview = compareMeasurePreviewResponseSchema.parse(response.json());
    expect(await counts()).toEqual(before);
    expect(preview).toEqual({
      preparation: {
        name: "Proceeds per signup",
        steps: [
          { id: "numerator_source", type: "source" },
          { id: "numerator_scope", type: "filter" },
          { id: "numerator_tag", type: "calculate" },
          { id: "denominator_source", type: "source" },
          { id: "denominator_tag", type: "calculate" },
          { id: "compare", type: "append" },
        ],
      },
      model: { name: "Proceeds per signup" },
      dateDimensionId: "date",
      measures: {
        numerator: { id: "numerator", name: "Proceeds" },
        denominator: { id: "denominator", name: "Signups" },
        ratio: { id: "ratio", name: "Proceeds per signup" },
        previous: {
          id: "ratio_previous",
          name: "Proceeds per signup · previous period",
        },
        change: { id: "ratio_change", name: "Proceeds per signup · change" },
      },
      currency: "EUR",
    });
    // The save creates exactly what the preview named.
    const created = await call("POST", "/compare-measures", owner, body);
    expect(created.statusCode, created.body).toBe(200);
    const result = compareMeasureResponseSchema.parse(created.json());
    const model = (await call("GET", `/models/${result.modelId}`, owner)).json()
      .model as {
      name: string;
      definition: { measures: Array<{ id: string; name: string }> };
    };
    expect(model.name).toBe(preview.model.name);
    for (const measure of Object.values(preview.measures))
      expect(model.definition.measures).toContainEqual(
        expect.objectContaining(measure),
      );
    const preparation = (
      await call("GET", `/preparations/${result.preparationId}`, owner)
    ).json().preparation as {
      name: string;
      graph: { nodes: Array<{ id: string; type: string }> };
    };
    expect(preparation.name).toBe(preview.preparation.name);
    expect(
      preparation.graph.nodes.map(({ id, type }) => ({ id, type })),
    ).toEqual(preview.preparation.steps);
  });

  it("names no currency when no side needs one", async () => {
    const response = await call("POST", "/compare-measures/preview", owner, {
      ...request(
        {
          name: "Conversion",
          numerator: { metricKey: "cmp.signups" },
          denominator: { metricKey: "cmp.visits" },
          format: "percent",
        },
        "last_7_days",
      ),
      // Ignored: neither side is an amount per currency.
      currency: "EUR",
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = compareMeasurePreviewResponseSchema.parse(response.json());
    expect(preview.currency).toBeNull();
    expect(preview.measures.change.name).toBe("Conversion · change (pt)");
  });

  it("names the generated measures, fields and dimension in the author's language (#515)", async () => {
    const setLocale = async (locale: string) => {
      const response = await app.inject({
        method: "PATCH",
        url: "/v1/me",
        headers: { cookie: owner },
        payload: { locale },
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const body = request(
      {
        name: "Signup-Conversion",
        numerator: { metricKey: "cmp.signups" },
        denominator: { metricKey: "cmp.visits" },
        format: "percent",
      },
      "last_7_days",
    );
    await setLocale("de");
    try {
      const response = await call(
        "POST",
        "/compare-measures/preview",
        owner,
        body,
      );
      expect(response.statusCode, response.body).toBe(200);
      const preview = compareMeasurePreviewResponseSchema.parse(
        response.json(),
      );
      // The author's own names stay as typed; the generated ones are German.
      expect(preview.model.name).toBe("Signup-Conversion");
      expect(preview.measures.previous.name).toBe(
        "Signup-Conversion · vorheriger Zeitraum",
      );
      expect(preview.measures.change.name).toBe(
        "Signup-Conversion · Veränderung (Pp.)",
      );

      const created = await call("POST", "/compare-measures", owner, body);
      expect(created.statusCode, created.body).toBe(200);
      const result = compareMeasureResponseSchema.parse(created.json());
      const model = (
        await call("GET", `/models/${result.modelId}`, owner)
      ).json().model as {
        definition: {
          dimensions: Array<{ id: string; name: string }>;
          measures: Array<{ id: string; name: string }>;
        };
      };
      expect(model.definition.dimensions).toContainEqual(
        expect.objectContaining({ id: "date", name: "Datum" }),
      );
      expect(model.definition.measures).toContainEqual(
        expect.objectContaining({
          id: "ratio_previous",
          name: "Signup-Conversion · vorheriger Zeitraum",
        }),
      );
      const preparation = (
        await call("GET", `/preparations/${result.preparationId}`, owner)
      ).json().preparation as {
        graph: { nodes: Array<{ id: string; name?: string }> };
      };
      expect(
        preparation.graph.nodes.find((node) => node.id === "numerator_tag")
          ?.name,
      ).toBe("Vergleichsseite");
    } finally {
      await setLocale("en");
    }
    // Back in English, the same request names them in English again.
    const english = compareMeasurePreviewResponseSchema.parse(
      (await call("POST", "/compare-measures/preview", owner, body)).json(),
    );
    expect(english.measures.previous.name).toBe(
      "Signup-Conversion · previous period",
    );
  });
});
