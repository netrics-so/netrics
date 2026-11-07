import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareMeasureReadingsResponseSchema,
  compareMeasureResponseSchema,
  dashboardResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  dashboardHasModelWidgets,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  addDays,
  compareChange,
  compareMeasureFilter,
  type CompareMeasureBinding,
  type Period,
} from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import {
  buildDeviceDashboard,
  buildDeviceDashboardV2,
  buildDeviceDashboardV3,
  withDevice,
} from "./devices/dashboard.js";
import { loadConfig } from "./env.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";
import { addMemberViaInvitation } from "./test-helpers.js";

// #507: an optional measure binding on compare widgets. An unbound widget
// is exactly what it was; a bound one reads the published measures for the
// widget's own current and previous windows.

const NOW = new Date("2026-11-07T15:30:00Z");
const ZONE = "Europe/Berlin";
const TODAY = "2026-11-07";
const SHOP = "0c000000-0000-4000-8000-000000000001";
const BLOG = "0c000000-0000-4000-8000-000000000002";
const PERIODS: readonly Period[] = [
  "today",
  "this_week",
  "this_month",
  "this_quarter",
  "this_year",
  "last_7_days",
  "last_30_days",
  "last_90_days",
  "last_12_months",
];

let testDb: TestDatabase;
let app: FastifyInstance;
let db: Database;
let raw: Sql;
let owner: string, viewer: string, stranger: string;
let workspaceId: string, otherWorkspaceId: string;

const call = (
  method: "GET" | "POST" | "PUT",
  url: string,
  cookie: string | undefined,
  payload?: unknown,
) =>
  app.inject({
    method,
    url: `/v1/workspaces/${workspaceId}${url}`,
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

/**
 * Daily values from 2023 to 2029 (day 0 is TODAY, negative days after it),
 * so every period has a previous window on every clock below.
 */
async function observe(
  connection: string,
  metricKey: string,
  dimensions: Record<string, string>,
  value: (day: number) => number | null,
) {
  const rows: Array<{ dimensions: string; at: string; value: number }> = [];
  for (let day = -1200; day < 1420; day++) {
    // Days before TODAY as recorded for the legacy payloads; later ones
    // folded onto positive days, so the same rules give their values.
    const v = value(day < 0 ? 5000 + day : day);
    if (v === null) continue;
    rows.push({
      dimensions: JSON.stringify(dimensions),
      at: `${addDays(TODAY, -day)}T00:00:00Z`,
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
    where m.connector_id = 'cmb' and m.key = ${metricKey}`;
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
    // The seeded days end on TODAY, so browser reads resolve their windows
    // on NOW like the screens do, not on the real date in the workspace zone.
    now: () => NOW,
  });
  owner = await signup("binding-owner@example.com");
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: owner },
    payload: { name: "Binding" },
  });
  workspaceId = workspaceResponseSchema.parse(created.json()).workspace.id;
  await raw`update workspaces set time_zone = ${ZONE} where id = ${workspaceId}`;
  viewer = await signup("binding-viewer@example.com");
  expect(
    (
      await addMemberViaInvitation(
        app,
        db,
        owner,
        workspaceId,
        "binding-viewer@example.com",
        "viewer",
      )
    ).statusCode,
  ).toBe(200);
  stranger = await signup("binding-stranger@example.com");
  const other = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: stranger },
    payload: { name: "Other" },
  });
  otherWorkspaceId = workspaceResponseSchema.parse(other.json()).workspace.id;
  await raw`insert into connectors (id, version, manifest) values
    ('cmb', '1.0.0', ${raw.json({ id: "cmb" })})`;
  await raw`
    insert into metric_definitions (connector_id, key, name, description,
      kind, unit, granularity, dimensions, aggregations)
    values
      ('cmb', 'cmb.visits', 'Visits', '', 'delta', 'count', 'day',
       '["resource"]', '["sum","avg","min","max"]'),
      ('cmb', 'cmb.signups', 'Signups', '', 'delta', 'count', 'day',
       '["resource"]', '["sum","avg","min","max"]'),
      ('cmb', 'cmb.proceeds', 'Proceeds', '', 'delta', 'currency_minor',
       'day', '["resource","currency"]', '["sum","avg"]')`;
  await raw`
    insert into connections (id, workspace_id, connector_id, name) values
      (${SHOP}, ${workspaceId}, 'cmb', 'Shop'),
      (${BLOG}, ${workspaceId}, 'cmb', 'Blog')`;
  // Gaps and zero days, so averages and sums differ.
  await observe(SHOP, "cmb.visits", { resource: "app-1" }, (d) =>
    d === 40 ? null : 100 + ((d * 7) % 23),
  );
  await observe(SHOP, "cmb.visits", { resource: "app-2" }, (d) =>
    d % 5 === 4 ? null : 40 + (d % 9),
  );
  await observe(SHOP, "cmb.signups", { resource: "app-1" }, (d) =>
    d % 4 === 3 ? null : 3 + (d % 6),
  );
  await observe(SHOP, "cmb.signups", { resource: "app-2" }, (d) =>
    d % 3 === 0 ? 0 : 1 + (d % 2),
  );
  await observe(
    SHOP,
    "cmb.proceeds",
    { resource: "app-1", currency: "EUR" },
    (d) => 990 * (1 + (d % 3)),
  );
  await observe(
    SHOP,
    "cmb.proceeds",
    { resource: "app-1", currency: "USD" },
    (d) => 1290 * (1 + (d % 2)),
  );
  await observe(BLOG, "cmb.visits", { resource: "blog" }, (d) =>
    d % 6 === 5 ? null : 300 + ((d * 5) % 17),
  );
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 });
  await raw?.end({ timeout: 5 });
});

const uuid = (group: number, n: number) =>
  `${String(group).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Side {
  connectionId?: string;
  metricKey: string;
  aggregation?: "sum" | "avg";
  dimensions?: Record<string, string>;
}

/** Inserts a dashboard of compare widgets, one per period. */
async function insertCompares(
  group: number,
  widgets: Array<{
    period: Period;
    numerator: Side;
    denominator: Side;
    format: "percent" | "ratio";
    /** The measure binding (#507), stored as the API stores it. */
    measure?: CompareMeasureBinding | Record<string, unknown>;
  }>,
) {
  const dashboardId = uuid(group, 0);
  const slideId = uuid(group, 1);
  await raw`insert into dashboards (id, workspace_id, name)
    values (${dashboardId}, ${workspaceId}, ${`Compares ${group}`})`;
  await raw`insert into dashboard_slides (id, dashboard_id, workspace_id, position)
    values (${slideId}, ${dashboardId}, ${workspaceId}, 0)`;
  const ids: string[] = [];
  for (const [i, widget] of widgets.entries()) {
    const id = uuid(group, 100 + i);
    ids.push(id);
    await raw`
      insert into dashboard_widgets ${raw({
        id,
        slide_id: slideId,
        dashboard_id: dashboardId,
        workspace_id: workspaceId,
        type: "compare",
        x: (i % 5) * 3,
        y: Math.floor(i / 5) * 3,
        w: 3,
        h: 3,
        connection_id: widget.numerator.connectionId ?? SHOP,
        metric_key: widget.numerator.metricKey,
        aggregation: widget.numerator.aggregation ?? "sum",
        period: widget.period,
        denominator_connection_id: widget.denominator.connectionId ?? SHOP,
        denominator_metric_key: widget.denominator.metricKey,
        denominator_aggregation: widget.denominator.aggregation ?? "sum",
      })}`;
    await raw`
      update dashboard_widgets
      set options = ${raw.json({ format: widget.format })},
          dimensions = ${raw.json(widget.numerator.dimensions ?? {})},
          denominator_dimensions = ${raw.json(widget.denominator.dimensions ?? {})}
      where id = ${id}`;
    if (widget.measure)
      await raw`
        update dashboard_widgets
        set model_id = ${String(widget.measure.modelId)},
            model_binding = ${raw.json(widget.measure as never)}
        where id = ${id}`;
  }
  return { dashboardId, ids };
}

const asWorkspace = <T>(
  run: (tx: Parameters<Parameters<typeof withWorkspace>[2]>[0]) => Promise<T>,
) =>
  withWorkspace(db, { workspaceId }, run, {
    isolationLevel: "repeatable read",
  });

const LEGACY_FIXTURE = path.join(
  import.meta.dirname,
  "devices",
  "fixtures",
  "compare-legacy-payloads.json",
);

describe("unbound compare widgets: legacy parity (#507)", () => {
  it("gives payloads of schemas 1–3 byte for byte as before", async () => {
    const { dashboardId } = await insertCompares(
      1,
      PERIODS.map((period, i) => ({
        period,
        numerator: (i % 3 === 0
          ? { metricKey: "cmb.signups" }
          : i % 3 === 1
            ? {
                metricKey: "cmb.proceeds",
                aggregation: "avg",
                dimensions: { currency: "EUR" },
              }
            : {
                metricKey: "cmb.visits",
                dimensions: { resource: "app-2" },
              }) as Side,
        denominator: (i % 3 === 2
          ? { metricKey: "cmb.visits", connectionId: BLOG }
          : {
              metricKey: "cmb.visits",
              aggregation: i % 2 ? "avg" : "sum",
            }) as Side,
        format: i % 3 === 0 || i % 3 === 2 ? "percent" : "ratio",
      })),
    );
    // A metric widget, so schema 1 has a tile beside the compares.
    await raw`
      insert into dashboard_widgets ${raw({
        id: uuid(1, 900),
        slide_id: uuid(1, 1),
        dashboard_id: dashboardId,
        workspace_id: workspaceId,
        type: "metric",
        x: 0,
        y: 9,
        w: 3,
        h: 3,
        connection_id: SHOP,
        metric_key: "cmb.visits",
        aggregation: "sum",
        period: "last_7_days",
      })}`;
    const options = { now: NOW };
    const payloads = await asWorkspace(async (tx) => ({
      schema1: await buildDeviceDashboard(
        tx,
        workspaceId,
        dashboardId,
        options,
      ),
      schema2: await buildDeviceDashboardV2(
        tx,
        workspaceId,
        dashboardId,
        options,
      ),
      schema3: withDevice(
        await buildDeviceDashboardV3(tx, workspaceId, dashboardId, options),
        { rotation: 0, displayMode: "screen" },
      ),
      german: withDevice(
        await buildDeviceDashboardV3(tx, workspaceId, dashboardId, {
          ...options,
          locale: "de",
        }),
        { rotation: 90, displayMode: "scroll" },
      ),
    }));
    // The bytes screens receive, with the versions (and so ETags) by which
    // screens keep playing their cached payload offline.
    const actual = JSON.stringify(payloads);
    if (process.env.UPDATE_COMPARE_LEGACY === "1")
      writeFileSync(LEGACY_FIXTURE, JSON.stringify(payloads, null, 2) + "\n");
    // Parsing keeps the key order: these are the bytes screens got on main.
    expect(actual).toBe(
      JSON.stringify(JSON.parse(readFileSync(LEGACY_FIXTURE, "utf8"))),
    );
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Bound widgets

interface Compare {
  name: string;
  numerator: Side;
  denominator: Side;
  format: "percent" | "ratio";
  /** A source currency pinned at compile time; the widget filters by it. */
  currency?: string;
}

type Compiled = CompareMeasureBinding & { version: number };

/** Compiles a compare (#506), publishes its model, and returns the binding. */
async function compile(
  compare: Compare,
  options: { publish?: boolean } = {},
): Promise<Compiled> {
  const side = (binding: Side) => ({
    connectionId: binding.connectionId ?? SHOP,
    metricKey: binding.metricKey,
    ...(binding.aggregation ? { aggregation: binding.aggregation } : {}),
    ...(binding.dimensions ? { dimensions: binding.dimensions } : {}),
  });
  const created = await call("POST", "/data/compare-measures", owner, {
    name: compare.name,
    ...side(compare.numerator),
    period: "this_month",
    denominator: side(compare.denominator),
    format: compare.format,
    ...(compare.currency ? { currency: compare.currency } : {}),
  });
  expect(created.statusCode, created.body).toBe(200);
  const result = compareMeasureResponseSchema.parse(created.json());
  if (options.publish !== false) {
    const published = await call(
      "POST",
      `/data/models/${result.modelId}/publish`,
      owner,
      { version: result.modelVersion },
    );
    expect(published.statusCode, published.body).toBe(200);
  }
  return {
    modelId: result.modelId,
    dateDimensionId: result.dateDimensionId,
    measureIds: {
      numerator: result.measures.numerator,
      denominator: result.measures.denominator,
      ratio: result.measures.ratio,
    },
    version: result.modelVersion,
  };
}

/** The inline widget's sides; a pinned currency is its currency filter. */
const inline = (compare: Compare) => {
  const pin = (side: Side): Side =>
    compare.currency && side.metricKey === "cmb.proceeds"
      ? {
          ...side,
          dimensions: { currency: compare.currency, ...side.dimensions },
        }
      : side;
  return {
    numerator: pin(compare.numerator),
    denominator: pin(compare.denominator),
    format: compare.format,
  };
};

const bindingOf = ({
  version: _version,
  ...binding
}: Compiled): CompareMeasureBinding => binding;

type ScreenWidget = Awaited<
  ReturnType<typeof buildDeviceDashboardV3>
>["slides"][number]["widgets"][number];
type CompareScreenWidget = Extract<ScreenWidget, { type: "compare" }>;

const screen = (dashboardId: string, now: Date, scope?: object) =>
  asWorkspace((tx) =>
    buildDeviceDashboardV3(tx, workspaceId, dashboardId, {
      now,
      ...(scope ? { scope: scope as never } : {}),
    }),
  );

const compares = (widgets: ScreenWidget[]) =>
  widgets.map((widget) => {
    if (widget.type !== "compare") throw new Error("not a compare");
    return widget as CompareScreenWidget;
  });

// The clocks of #510's findings: month ends after a longer month, 28
// February after a leap year (and before one), a leap day, a quarter's
// last day, New Year's Eve in the workspace zone, and TODAY.
const CLOCKS = [
  "2026-11-07T15:30:00Z",
  "2025-04-30T10:00:00Z",
  "2025-02-28T10:00:00Z",
  "2029-02-28T10:00:00Z",
  "2028-02-29T10:00:00Z",
  "2025-03-31T10:00:00Z",
  "2025-12-31T22:30:00Z",
].map((at) => new Date(at));

const close = (
  actual: number | null,
  expected: number | null,
  label: string,
) => {
  if (expected === null) expect(actual, label).toBeNull();
  else expect(actual, label).toBeCloseTo(expected, 9);
};

let group = 10;

describe("bound compare widgets: rebound parity (#507)", () => {
  const cases: Compare[] = [
    {
      name: "Signup rate",
      numerator: { metricKey: "cmb.signups" },
      denominator: { metricKey: "cmb.visits" },
      format: "percent",
    },
    {
      name: "Average signups per visit",
      numerator: { metricKey: "cmb.signups", aggregation: "avg" },
      denominator: {
        metricKey: "cmb.visits",
        aggregation: "avg",
        dimensions: { resource: "app-1" },
      },
      format: "ratio",
    },
    {
      name: "Shop over blog visits",
      numerator: { metricKey: "cmb.visits", dimensions: { resource: "app-2" } },
      denominator: { metricKey: "cmb.visits", connectionId: BLOG },
      format: "percent",
    },
    {
      name: "Revenue per signup",
      numerator: { metricKey: "cmb.proceeds" },
      denominator: { metricKey: "cmb.signups" },
      format: "ratio",
      currency: "EUR",
    },
  ];

  it.each(cases)(
    "$name: a bound widget shows what the inline one does, for every period and clock",
    async (compare) => {
      const binding = bindingOf(await compile(compare));
      const sides = inline(compare);
      const { dashboardId } = await insertCompares(++group, [
        ...PERIODS.map((period) => ({ period, ...sides })),
        ...PERIODS.map((period) => ({ period, ...sides, measure: binding })),
      ]);
      let compared = 0;
      for (const now of CLOCKS) {
        const widgets = compares(
          (await screen(dashboardId, now)).slides[0]!.widgets,
        );
        for (const [i, period] of PERIODS.entries()) {
          const at = `${period} at ${now.toISOString()}`;
          const a = widgets[i]!.data;
          const b = widgets[PERIODS.length + i]!.data;
          if (a.ratio.value !== null && a.ratio.previousValue !== null)
            compared += 1;
          close(b.numerator.value, a.numerator.value, `${at} numerator`);
          close(b.denominator.value, a.denominator.value, `${at} denominator`);
          close(b.ratio.value, a.ratio.value, `${at} ratio`);
          close(b.ratio.previousValue, a.ratio.previousValue, `${at} previous`);
          const change = (data: typeof a) =>
            compareChange({
              value: data.ratio.value,
              previousValue: data.ratio.previousValue,
              format: compare.format,
            });
          const [before, after] = [change(a), change(b)];
          expect(after?.kind, at).toBe(before?.kind);
          expect(after?.direction, at).toBe(before?.direction);
          close(after?.value ?? null, before?.value ?? null, `${at} change`);
          expect(b.unit, at).toBe(a.unit);
          expect(b.status, at).toBe(a.status);
          expect(b.updatedAt, at).toBe(a.updatedAt);
          expect(b.period, at).toBe(a.period);
          expect(b.ratio.format, at).toBe(a.ratio.format);
          // Read from the model, not the metrics: measures carry no kind.
          expect([a.kind, b.kind], at).toEqual(["delta", null]);
        }
      }
      // Gaps empty some one-day windows (today); the rest compare numbers.
      expect(compared).toBeGreaterThanOrEqual(
        CLOCKS.length * (PERIODS.length - 1),
      );
    },
    300_000,
  );
});

// ---------------------------------------------------------------------------
// Saving, reading in browsers, failures and scoped screens

const SIGNUP_RATE: Compare = {
  name: "Signup rate",
  numerator: { metricKey: "cmb.signups" },
  denominator: { metricKey: "cmb.visits" },
  format: "percent",
};

/** A compare widget as the Studio saves it, with an optional binding. */
const compareInput = (measure?: unknown) => ({
  type: "compare",
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  connectionId: SHOP,
  metricKey: "cmb.signups",
  period: "this_month",
  denominator: { connectionId: SHOP, metricKey: "cmb.visits" },
  options: { format: "percent" },
  ...(measure === undefined ? {} : { measure }),
});

const saveDashboard = (widgets: unknown[], cookie = owner) =>
  call("POST", "/dashboards", cookie, {
    name: "Saved compares",
    slides: [{ widgets }],
  });

/** Reads bound widgets as a signed-in page does. */
const readInBrowser = (
  widgets: Array<{
    id: string;
    period: Period;
    measure: unknown;
    format?: "percent" | "ratio";
  }>,
  cookie: string | undefined = owner,
) =>
  call("POST", "/dashboards/data/compare", cookie, {
    widgets: widgets.map((widget) => ({ format: "percent", ...widget })),
  });

/** A bound widget on a screen: an outage without values, never metrics. */
async function expectVisibleFailure(
  measure: CompareMeasureBinding | Record<string, unknown>,
) {
  const { dashboardId } = await insertCompares(++group, [
    { period: "this_month", ...inline(SIGNUP_RATE) },
    { period: "this_month", ...inline(SIGNUP_RATE), measure },
  ]);
  const [unbound, bound] = compares(
    (await screen(dashboardId, NOW)).slides[0]!.widgets,
  );
  expect(unbound!.data.ratio.value).not.toBeNull();
  expect(bound!.data).toMatchObject({
    status: "outage",
    numerator: { value: null },
    denominator: { value: null },
    ratio: { value: null, previousValue: null },
  });
}

describe("bound compare widgets: saving and reading (#507)", () => {
  it("saves, returns and reads a binding; an unbound widget has none", async () => {
    const binding = bindingOf(await compile(SIGNUP_RATE));
    const saved = await saveDashboard([
      compareInput(binding),
      { ...compareInput(), x: 4 },
      { ...compareInput(null), x: 8 },
    ]);
    expect(saved.statusCode, saved.body).toBe(200);
    const [bound, unbound, cleared] = dashboardResponseSchema.parse(
      saved.json(),
    ).dashboard.slides[0]!.widgets;
    expect(bound).toMatchObject({ type: "compare", measure: binding });
    expect(unbound).not.toHaveProperty("measure");
    expect(cleared).not.toHaveProperty("measure");
    const rows = await raw`
      select model_id, model_binding from dashboard_widgets
      where id in (${unbound!.id}, ${cleared!.id})`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      { model_id: null, model_binding: null },
      { model_id: null, model_binding: null },
    ]);

    // A signed-in page reads the same numbers as the screen.
    const read = await readInBrowser([
      { id: bound!.id, period: "this_month", measure: binding },
    ]);
    expect(read.statusCode, read.body).toBe(200);
    const [reading] = compareMeasureReadingsResponseSchema.parse(
      read.json(),
    ).widgets;
    const dashboardId = dashboardResponseSchema.parse(saved.json()).dashboard
      .id;
    const [onScreen] = compares(
      (await screen(dashboardId, NOW)).slides[0]!.widgets,
    );
    expect(reading).toMatchObject({
      widgetId: bound!.id,
      error: null,
      numerator: onScreen!.data.numerator,
      denominator: onScreen!.data.denominator,
      ratio: {
        value: onScreen!.data.ratio.value,
        previousValue: onScreen!.data.ratio.previousValue,
      },
      unit: onScreen!.data.unit,
      sources: ["Shop"],
    });
    expect(reading!.numerator.label).toBe("Signups");
  }, 60_000);

  it("is read by members who may query data, and by no one else", async () => {
    const binding = bindingOf(await compile(SIGNUP_RATE));
    const widgets = [
      { id: uuid(99, 1), period: "last_7_days" as Period, measure: binding },
    ];
    expect((await readInBrowser(widgets, viewer)).statusCode).toBe(200);
    expect((await readInBrowser(widgets, "")).statusCode).toBe(401);
    expect((await readInBrowser(widgets, stranger)).statusCode).toBe(404);
  }, 60_000);
});

describe("bound compare widgets: failures are typed and visible (#507)", () => {
  it("unpublished: saves, but shows an outage and data_model_not_published", async () => {
    const draft = bindingOf(await compile(SIGNUP_RATE, { publish: false }));
    expect((await saveDashboard([compareInput(draft)])).statusCode).toBe(200);
    await expectVisibleFailure(draft);
    const read = await readInBrowser([
      { id: uuid(98, 1), period: "this_month", measure: draft },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "data_model_not_published",
      ratio: { value: null, previousValue: null },
    });
  }, 60_000);

  it("deleted: a measure removed from the published model is an error", async () => {
    const compiled = await compile(SIGNUP_RATE);
    const binding = bindingOf(compiled);
    const model = await call("GET", `/data/models/${binding.modelId}`, owner);
    const definition = model.json().model.definition as {
      measures: Array<{ id: string }>;
    };
    // Without the ratio and the measures built on it.
    const saved = await call("PUT", `/data/models/${binding.modelId}`, owner, {
      name: "Signup rate",
      version: compiled.version,
      definition: {
        ...definition,
        measures: definition.measures.filter(
          (measure) => !measure.id.startsWith("ratio"),
        ),
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await call(
      "POST",
      `/data/models/${binding.modelId}/publish`,
      owner,
      { version: saved.json().model.version },
    );
    expect(published.statusCode, published.body).toBe(200);
    await expectVisibleFailure(binding);
    const read = await readInBrowser([
      { id: uuid(98, 2), period: "this_month", measure: binding },
    ]);
    const [reading] = read.json().widgets;
    expect(reading).toMatchObject({ status: "outage" });
    expect(reading.error).toBe("model_measure_not_found");
    // Saving it again is refused: the measure is no longer the model's.
    const refused = await saveDashboard([compareInput(binding)]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: "compare_measure_not_found",
    });
  }, 60_000);

  it("unauthorized: another workspace's model is refused and never read", async () => {
    // The same compiled model, in another workspace.
    const own = bindingOf(await compile(SIGNUP_RATE));
    const [copy] = await raw`
      insert into data_models (workspace_id, name, definition)
      select ${otherWorkspaceId}, name, definition from data_models
      where id = ${own.modelId} returning id`;
    const foreign = {
      modelId: copy!.id as string,
      dateDimensionId: "date",
      measureIds: {
        numerator: "numerator",
        denominator: "denominator",
        ratio: "ratio",
      },
    };
    const refused = await saveDashboard([compareInput(foreign)]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: "compare_measure_model_not_found",
    });
    // The database refuses it too (the model's workspace is the widget's).
    await expect(expectVisibleFailure(foreign)).rejects.toThrow(
      /dashboard_widgets_model_fk/,
    );
    const read = await readInBrowser([
      { id: uuid(98, 3), period: "this_month", measure: foreign },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "data_model_not_published",
      numerator: { value: null },
    });
  }, 60_000);

  it("mismatched: measures or a date that are not the model's are refused and fail visibly", async () => {
    const binding = bindingOf(await compile(SIGNUP_RATE));
    for (const [mismatched, error] of [
      [
        {
          ...binding,
          measureIds: { ...binding.measureIds, ratio: "conversion" },
        },
        "model_measure_not_found",
      ],
      [{ ...binding, dateDimensionId: "day" }, "model_dimension_not_found"],
    ] as const) {
      const refused = await saveDashboard([compareInput(mismatched)]);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        error: "compare_measure_not_found",
      });
      await expectVisibleFailure(mismatched);
      const read = await readInBrowser([
        { id: uuid(98, 4), period: "this_month", measure: mismatched },
      ]);
      expect(read.json().widgets[0]).toMatchObject({ status: "outage" });
      expect(read.json().widgets[0].error).toBe(error);
    }
    // A "date" that is not a date: the windows cannot be read on it.
    const model = (
      await call("GET", `/data/models/${binding.modelId}`, owner)
    ).json().model;
    const saved = await call("PUT", `/data/models/${binding.modelId}`, owner, {
      name: model.name,
      version: model.version,
      definition: {
        ...model.definition,
        dimensions: [
          ...model.definition.dimensions,
          {
            id: "side",
            name: "Side",
            datasetId: model.definition.datasets[0],
            fieldId: "compare_side",
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(
      (
        await call("POST", `/data/models/${binding.modelId}/publish`, owner, {
          version: saved.json().model.version,
        })
      ).statusCode,
    ).toBe(200);
    const notADate = { ...binding, dateDimensionId: "side" };
    await expectVisibleFailure(notADate);
    const read = await readInBrowser([
      { id: uuid(98, 5), period: "this_month", measure: notADate },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "compare_measure_date_required",
    });
    // A stored binding that is not one at all.
    await expectVisibleFailure({ modelId: binding.modelId, broken: true });
  }, 60_000);
});

describe("bound compare widgets: scoped screens (#507)", () => {
  it("are withheld from a scoped screen, as unbound ones are", async () => {
    const binding = bindingOf(await compile(SIGNUP_RATE));
    const { dashboardId } = await insertCompares(++group, [
      { period: "this_month", ...inline(SIGNUP_RATE), measure: binding },
    ]);
    expect((await screen(dashboardId, NOW)).slides[0]!.widgets).toHaveLength(1);
    const scoped = await screen(dashboardId, NOW, {
      country: { kind: "values", values: ["DE"] },
    });
    expect(scoped.slides[0]!.widgets).toEqual([]);
  }, 60_000);
});

describe("bound compare widgets: source health (#507)", () => {
  it("ranks each source by its own data, as the inline widget's two sides", async () => {
    // A synced source with data over a source still loading its history
    // (pending, values only in 2023): the inline widget says backfilling,
    // never no data.
    const LIVE = "0c000000-0000-4000-8000-000000000003";
    const FRESH = "0c000000-0000-4000-8000-000000000004";
    await raw`
      insert into connections (id, workspace_id, connector_id, name) values
        (${LIVE}, ${workspaceId}, 'cmb', 'Live'),
        (${FRESH}, ${workspaceId}, 'cmb', 'Fresh')`;
    await raw`
      insert into connection_state (connection_id, workspace_id, last_success_at)
      values (${LIVE}, ${workspaceId}, ${NOW.toISOString()})`;
    await observe(
      LIVE,
      "cmb.visits",
      { resource: "live" },
      (d) => 50 + (d % 7),
    );
    await observe(FRESH, "cmb.visits", { resource: "fresh" }, (d) =>
      d > 1300 ? 10 : null,
    );
    const compare: Compare = {
      name: "Live over fresh visits",
      numerator: { metricKey: "cmb.visits", connectionId: LIVE },
      denominator: { metricKey: "cmb.visits", connectionId: FRESH },
      format: "ratio",
    };
    const binding = bindingOf(await compile(compare));
    const { dashboardId } = await insertCompares(++group, [
      { period: "last_7_days", ...inline(compare) },
      { period: "last_7_days", ...inline(compare), measure: binding },
    ]);
    const [unbound, bound] = compares(
      (await screen(dashboardId, NOW)).slides[0]!.widgets,
    );
    expect(unbound!.data.numerator.value).not.toBeNull();
    expect(unbound!.data.denominator.value).toBeNull();
    expect(unbound!.data.status).toBe("backfilling");
    expect(bound!.data.status).toBe(unbound!.data.status);
    expect(bound!.data.numerator.value).toBe(unbound!.data.numerator.value);
  }, 60_000);
});

describe("bound compare widgets: source retention (#507)", () => {
  it("carries the earliest expiry of its two windows to browsers", async () => {
    // Any model with these three measures can be bound; one over records
    // kept for 30 days expires with them.
    const field = (id: string, type: string) => ({
      id,
      name: id,
      type,
      nullable: false,
      classification: "internal",
    });
    const records = [];
    for (let day = 0; day < 70; day++)
      records.push({
        values: {
          id: `r${day}`,
          day: addDays(TODAY, -day),
          num: 1 + (day % 4),
          den: 10 + (day % 3),
        },
      });
    const manual = await call("POST", "/data/manual", owner, {
      definition: {
        key: "kept",
        name: "Kept",
        version: 1,
        mode: "snapshot",
        grain: "one day",
        keyFields: ["id"],
        retentionDays: 30,
        fields: [
          field("id", "string"),
          field("day", "date"),
          field("num", "number"),
          field("den", "number"),
        ],
      },
      records,
    });
    expect(manual.statusCode, manual.body).toBe(200);
    const datasetId = manual.json().datasetId as string;
    const sum = (id: string, fieldId: string) => ({
      id,
      name: id,
      kind: "aggregate",
      datasetId,
      aggregate: { id, name: id, op: "sum", fieldId },
    });
    const model = await call("POST", "/data/models", owner, {
      name: "Kept ratio",
      definition: {
        version: 1,
        datasets: [datasetId],
        relationships: [],
        dimensions: [
          {
            id: "date",
            name: "Date",
            datasetId,
            fieldId: "day",
            timeAlignment: "reporting_date",
          },
        ],
        measures: [
          sum("numerator", "num"),
          sum("denominator", "den"),
          {
            id: "ratio",
            name: "Ratio",
            kind: "formula",
            expression: {
              kind: "call",
              fn: "divide",
              args: [
                { kind: "field", fieldId: "numerator" },
                { kind: "field", fieldId: "denominator" },
              ],
            },
          },
        ],
      },
    });
    expect(model.statusCode, model.body).toBe(200);
    const { id: modelId, version } = model.json().model;
    const published = await call(
      "POST",
      `/data/models/${modelId}/publish`,
      owner,
      { version },
    );
    expect(published.statusCode, published.body).toBe(200);
    const measure = {
      modelId,
      dateDimensionId: "date",
      measureIds: {
        numerator: "numerator",
        denominator: "denominator",
        ratio: "ratio",
      },
    };
    const read = await readInBrowser([
      { id: uuid(97, 1), period: "last_7_days", measure },
    ]);
    expect(read.statusCode, read.body).toBe(200);
    const [reading] = compareMeasureReadingsResponseSchema.parse(
      read.json(),
    ).widgets;
    expect(reading!.error).toBeNull();
    expect(reading!.ratio.value).not.toBeNull();
    // The same model queried for each window: the earlier expiry wins.
    const expiries = [];
    for (const range of [reading!.dates.current, reading!.dates.previous]) {
      const queried = await call(
        "POST",
        `/data/models/${modelId}/query`,
        owner,
        {
          measureIds: ["numerator", "denominator", "ratio"],
          groupBy: [],
          filter: compareMeasureFilter("date", range),
        },
      );
      expiries.push(queried.json().expiresAt as string);
    }
    expect(expiries.every((at) => typeof at === "string")).toBe(true);
    expect(reading!.expiresAt).toBe(
      [...expiries].sort((a, b) => Date.parse(a) - Date.parse(b))[0],
    );
  }, 60_000);
});

/**
 * A published "revenue per order" model over a manual dataset: amounts in
 * major units of `currencyOf(day)`, 4 orders a day, for the last 14 days.
 */
async function revenueModel(
  key: string,
  currencyOf: (day: number) => string,
  /** The orders' unit; with one, the ratio is "currency/<unit>". */
  ordersUnit?: string,
  /** The day's amount; null: none that day. */
  amountOf: (day: number) => string | null = () => "150",
  /** A fixed unit of the amount ("EUR_minor") instead of a currency field. */
  amountUnit?: string,
): Promise<CompareMeasureBinding> {
  const field = (id: string, type: string, extra: object = {}) => ({
    id,
    name: id,
    type,
    nullable: false,
    classification: "internal",
    ...extra,
  });
  // 150 (major units) and 4 orders on each of the last 14 days.
  const records = [];
  for (let day = 0; day < 14; day++)
    records.push({
      values: {
        id: `o${day}`,
        day: addDays(TODAY, -day),
        amount: amountOf(day),
        currency: currencyOf(day),
        orders: ordersUnit ? "4" : 4,
      },
    });
  const manual = await call("POST", "/data/manual", owner, {
    definition: {
      key,
      name: "Orders",
      version: 1,
      mode: "snapshot",
      grain: "one day",
      keyFields: ["id"],
      fields: [
        field("id", "string"),
        field("day", "date"),
        field("amount", "decimal", {
          nullable: true,
          ...(amountUnit
            ? { unit: amountUnit }
            : { unit: "currency", currencyField: "currency" }),
        }),
        field("currency", "string"),
        field(
          "orders",
          ordersUnit ? "decimal" : "number",
          ordersUnit ? { unit: ordersUnit } : {},
        ),
      ],
    },
    records,
  });
  expect(manual.statusCode, manual.body).toBe(200);
  const datasetId = manual.json().datasetId as string;
  const sum = (id: string, fieldId: string) => ({
    id,
    name: id === "numerator" ? "Revenue" : "Orders",
    kind: "aggregate",
    datasetId,
    aggregate: { id, name: id, op: "sum", fieldId },
  });
  const model = await call("POST", "/data/models", owner, {
    name: "Revenue per order",
    definition: {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions: [
        {
          id: "date",
          name: "Date",
          datasetId,
          fieldId: "day",
          timeAlignment: "reporting_date",
        },
      ],
      measures: [
        sum("numerator", "amount"),
        sum("denominator", "orders"),
        // Another count, so operands can both be counts.
        { ...sum("orders_again", "orders"), name: "Orders again" },
        // Not numbers: a string, empty here (no currency is "XXX").
        {
          id: "no_currency",
          name: "No currency",
          kind: "aggregate",
          datasetId,
          aggregate: {
            id: "no_currency",
            name: "no_currency",
            op: "max",
            fieldId: "currency",
            filter: {
              kind: "call",
              fn: "eq",
              args: [
                { kind: "field", fieldId: "currency" },
                { kind: "literal", type: "string", value: "XXX" },
              ],
            },
          },
        },
        // Orders per revenue, an inverse amount, with units on both.
        ...(ordersUnit
          ? [
              {
                id: "orders_per_revenue",
                name: "Orders per revenue",
                kind: "formula",
                expression: {
                  kind: "call",
                  fn: "divide",
                  args: [
                    { kind: "field", fieldId: "denominator" },
                    { kind: "field", fieldId: "numerator" },
                  ],
                },
              },
            ]
          : []),
        {
          id: "ratio",
          name: "Revenue per order",
          kind: "formula",
          expression: {
            kind: "call",
            fn: "divide",
            args: [
              { kind: "field", fieldId: "numerator" },
              // With a unit the orders keep it: "currency/<unit>".
              ordersUnit
                ? { kind: "field", fieldId: "denominator" }
                : {
                    kind: "call",
                    fn: "to_decimal",
                    args: [{ kind: "field", fieldId: "denominator" }],
                  },
            ],
          },
        },
      ],
    },
  });
  expect(model.statusCode, model.body).toBe(200);
  const { id: modelId, version } = model.json().model;
  const published = await call(
    "POST",
    `/data/models/${modelId}/publish`,
    owner,
    { version },
  );
  expect(published.statusCode, published.body).toBe(200);
  return {
    modelId,
    dateDimensionId: "date",
    measureIds: {
      numerator: "numerator",
      denominator: "denominator",
      ratio: "ratio",
    },
  };
}

describe("bound compare widgets: units of any model (#507)", () => {
  it("shows major-unit amounts in minor units and unitless operands as counts", async () => {
    const measure = await revenueModel("orders", () => "EUR");
    const read = await readInBrowser([
      { id: uuid(96, 1), period: "last_7_days", measure, format: "ratio" },
    ]);
    expect(read.statusCode, read.body).toBe(200);
    const [reading] = compareMeasureReadingsResponseSchema.parse(
      read.json(),
    ).widgets;
    // 7 days × 150 EUR = 1050 EUR, in cents as every compare amount is.
    expect(reading).toMatchObject({
      error: null,
      numerator: { value: 105_000, unit: "EUR_minor" },
      denominator: { value: 28, unit: "count" },
      ratio: { value: 3750, previousValue: 3750 },
      unit: "EUR_minor",
    });
    // Screens get the same reading, which they can show (units not null).
    const { dashboardId } = await insertCompares(++group, [
      {
        period: "last_7_days",
        ...inline({ ...SIGNUP_RATE, format: "ratio" }),
        measure,
      },
    ]);
    const [bound] = compares(
      (await screen(dashboardId, NOW)).slides[0]!.widgets,
    );
    expect(bound!.data).toMatchObject({
      numerator: reading!.numerator,
      denominator: reading!.denominator,
      ratio: reading!.ratio,
      unit: "EUR_minor",
    });
    // An amount per order is no percentage: a percent widget bound to it
    // fails (the units rule of ADR 0019 section 10), it never shows cents
    // as percent.
    await expectVisibleFailure(measure);
    const percent = await readInBrowser([
      { id: uuid(96, 2), period: "last_7_days", measure, format: "percent" },
    ]);
    expect(percent.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "compare_units_incompatible",
      ratio: { value: null, previousValue: null },
    });
  }, 60_000);
});

describe("bound compare widgets: currencies across windows (#507)", () => {
  it("refuses a ratio whose previous window is in another currency", async () => {
    // EUR this week, JPY the week before: no change can be formed.
    const measure = await revenueModel("mixed", (day) =>
      day < 7 ? "EUR" : "JPY",
    );
    const read = await readInBrowser([
      { id: uuid(95, 1), period: "last_7_days", measure, format: "ratio" },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "compare_units_incompatible",
      ratio: { value: null, previousValue: null },
    });
    const { dashboardId } = await insertCompares(++group, [
      {
        period: "last_7_days",
        ...inline({ ...SIGNUP_RATE, format: "ratio" }),
        measure,
      },
    ]);
    const [bound] = compares(
      (await screen(dashboardId, NOW)).slides[0]!.widgets,
    );
    expect(bound!.data).toMatchObject({
      status: "outage",
      ratio: { value: null, previousValue: null },
    });
  }, 60_000);
});

describe("bound compare widgets: compound units and payload caching (#507)", () => {
  it("scales an amount per unit in major units, whatever the unit", async () => {
    const measure = await revenueModel("per_count", () => "EUR", "count");
    const read = await readInBrowser([
      { id: uuid(94, 1), period: "last_7_days", measure, format: "ratio" },
    ]);
    // €37.50 per order, in cents: never €0.38.
    expect(read.json().widgets[0]).toMatchObject({
      error: null,
      numerator: { value: 105_000, unit: "EUR_minor" },
      denominator: { value: 28, unit: "count" },
      ratio: { value: 3750, previousValue: 3750 },
      unit: "EUR_minor",
    });
  }, 60_000);

  it("counts a dashboard with bound compares as semantic, so its payload is not cached", async () => {
    const binding = bindingOf(await compile(SIGNUP_RATE));
    const unbound = await insertCompares(++group, [
      { period: "this_month", ...inline(SIGNUP_RATE) },
    ]);
    const bound = await insertCompares(++group, [
      { period: "this_month", ...inline(SIGNUP_RATE), measure: binding },
    ]);
    const semantic = (dashboardId: string) =>
      asWorkspace((tx) =>
        dashboardHasModelWidgets(tx, workspaceId, dashboardId),
      );
    expect(await semantic(unbound.dashboardId)).toBe(false);
    expect(await semantic(bound.dashboardId)).toBe(true);
  }, 60_000);
});

describe("bound compare widgets: measures shared and ratio units (#507)", () => {
  it("reads a measure used for both operands once", async () => {
    const binding = bindingOf(await compile(SIGNUP_RATE));
    const same = {
      ...binding,
      measureIds: { ...binding.measureIds, denominator: "numerator" },
    };
    const read = await readInBrowser([
      { id: uuid(93, 1), period: "last_7_days", measure: same },
    ]);
    const [reading] = compareMeasureReadingsResponseSchema.parse(
      read.json(),
    ).widgets;
    expect(reading!.error).toBeNull();
    expect(reading!.numerator.value).not.toBeNull();
    expect(reading!.denominator.value).toBe(reading!.numerator.value);
  }, 60_000);

  it("refuses a ratio measure whose unit is not the operands' ratio", async () => {
    // Orders over orders as operands, but revenue per order as the ratio:
    // a percent widget would show cents as percent.
    const model = await revenueModel("mixed_ratio", () => "EUR");
    const measure = {
      ...model,
      measureIds: {
        numerator: "denominator",
        denominator: "orders_again",
        ratio: "ratio",
      },
    };
    const read = await readInBrowser([
      { id: uuid(93, 2), period: "last_7_days", measure, format: "percent" },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "compare_units_incompatible",
    });
  }, 60_000);
});

describe("bound compare widgets: empty operands (#507)", () => {
  it("says no data when both are empty and one source has synced", async () => {
    // A synced source and a pending one, neither with values this week:
    // the inline widget's sides say no data and backfilling; no data wins.
    const SYNCED = "0c000000-0000-4000-8000-000000000005";
    const PENDING = "0c000000-0000-4000-8000-000000000006";
    await raw`
      insert into connections (id, workspace_id, connector_id, name) values
        (${SYNCED}, ${workspaceId}, 'cmb', 'Synced'),
        (${PENDING}, ${workspaceId}, 'cmb', 'Pending')`;
    await raw`
      insert into connection_state (connection_id, workspace_id, last_success_at)
      values (${SYNCED}, ${workspaceId}, ${NOW.toISOString()})`;
    for (const connection of [SYNCED, PENDING])
      await observe(connection, "cmb.visits", { resource: "old" }, (d) =>
        d > 1300 ? 10 : null,
      );
    const compare: Compare = {
      name: "Synced over pending visits",
      numerator: { metricKey: "cmb.visits", connectionId: SYNCED },
      denominator: { metricKey: "cmb.visits", connectionId: PENDING },
      format: "ratio",
    };
    const binding = bindingOf(await compile(compare));
    const { dashboardId } = await insertCompares(++group, [
      { period: "last_7_days", ...inline(compare) },
      { period: "last_7_days", ...inline(compare), measure: binding },
    ]);
    const [unbound, bound] = compares(
      (await screen(dashboardId, NOW)).slides[0]!.widgets,
    );
    expect(unbound!.data.numerator.value).toBeNull();
    expect(unbound!.data.denominator.value).toBeNull();
    expect(unbound!.data.status).toBe("no_data");
    expect(bound!.data.status).toBe(unbound!.data.status);
  }, 60_000);
});

describe("bound compare widgets: empty windows (#507)", () => {
  it("shows an empty current amount as no data, not a currency mismatch", async () => {
    // Revenue only the week before; orders every day.
    const measure = await revenueModel(
      "late_revenue",
      () => "EUR",
      undefined,
      (day) => (day < 7 ? null : "150"),
    );
    const read = await readInBrowser([
      { id: uuid(92, 1), period: "last_7_days", measure, format: "ratio" },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      error: null,
      numerator: { value: null },
      denominator: { value: 28 },
      ratio: { value: null, previousValue: 3750 },
    });
  }, 60_000);

  it("says backfilling when both are empty and every source is loading", async () => {
    const FIRST = "0c000000-0000-4000-8000-000000000007";
    const SECOND = "0c000000-0000-4000-8000-000000000008";
    await raw`
      insert into connections (id, workspace_id, connector_id, name) values
        (${FIRST}, ${workspaceId}, 'cmb', 'First'),
        (${SECOND}, ${workspaceId}, 'cmb', 'Second')`;
    for (const connection of [FIRST, SECOND])
      await observe(connection, "cmb.visits", { resource: "old" }, (d) =>
        d > 1300 ? 10 : null,
      );
    const compare: Compare = {
      name: "Two pending sources",
      numerator: { metricKey: "cmb.visits", connectionId: FIRST },
      denominator: { metricKey: "cmb.visits", connectionId: SECOND },
      format: "ratio",
    };
    const binding = bindingOf(await compile(compare));
    const { dashboardId } = await insertCompares(++group, [
      { period: "last_7_days", ...inline(compare) },
      { period: "last_7_days", ...inline(compare), measure: binding },
    ]);
    const [unbound, bound] = compares(
      (await screen(dashboardId, NOW)).slides[0]!.widgets,
    );
    expect(unbound!.data.status).toBe("backfilling");
    expect(bound!.data.status).toBe(unbound!.data.status);
  }, 60_000);
});

describe("bound compare widgets: fixed-currency amounts per unit (#507)", () => {
  it("reads EUR_minor per count as an amount per unit", async () => {
    // 15000 cents and 4 orders a day: €37.50 per order.
    const measure = await revenueModel(
      "fixed_per_count",
      () => "EUR",
      "count",
      () => "15000",
      "EUR_minor",
    );
    const read = await readInBrowser([
      { id: uuid(91, 1), period: "last_7_days", measure, format: "ratio" },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      error: null,
      numerator: { value: 105_000, unit: "EUR_minor" },
      denominator: { value: 28, unit: "count" },
      ratio: { value: 3750, previousValue: 3750 },
      unit: "EUR_minor",
    });
  }, 60_000);
});

describe("bound compare widgets: amounts per amount in two scales (#507)", () => {
  it("scales euros over cents to a plain number", async () => {
    // 150 EUR (major) over 4 cents a day (minor): 1050 EUR / 28 cents.
    const measure = await revenueModel(
      "major_per_minor",
      () => "EUR",
      "EUR_minor",
    );
    const read = await readInBrowser([
      { id: uuid(90, 1), period: "last_7_days", measure, format: "ratio" },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      error: null,
      numerator: { value: 105_000, unit: "EUR_minor" },
      denominator: { value: 28, unit: "EUR_minor" },
      ratio: { value: 3750, previousValue: 3750 },
      unit: null,
    });
  }, 60_000);
});

describe("bound compare widgets: inverse amounts and empty non-numbers (#507)", () => {
  it("refuses an amount in the denominator of the ratio's unit", async () => {
    const model = await revenueModel(
      "inverse",
      () => "EUR",
      "count",
      () => "15000",
      "EUR_minor",
    );
    const measure = {
      ...model,
      measureIds: {
        numerator: "denominator",
        denominator: "orders_again",
        ratio: "orders_per_revenue",
      },
    };
    const read = await readInBrowser([
      { id: uuid(89, 1), period: "last_7_days", measure, format: "percent" },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "compare_units_incompatible",
    });
  }, 60_000);

  it("refuses a measure that is not a number, also when it is empty", async () => {
    const model = await revenueModel("not_a_number", () => "EUR");
    const measure = {
      ...model,
      measureIds: {
        numerator: "denominator",
        denominator: "orders_again",
        ratio: "no_currency",
      },
    };
    const read = await readInBrowser([
      { id: uuid(89, 2), period: "last_7_days", measure },
    ]);
    expect(read.json().widgets[0]).toMatchObject({
      status: "outage",
      error: "compare_measure_not_numeric",
    });
  }, 60_000);
});

describe("bound compare widgets: which source an empty operand waits for (#507)", () => {
  it("says no data when the empty side has synced, though the other is backfilling", async () => {
    // The numerator's source has data and a backfill running; the
    // denominator's has synced but nothing this week. The inline sides say
    // ok and no data: the backfill is not why the denominator is empty.
    const FULL = "0c000000-0000-4000-8000-000000000009";
    const EMPTY = "0c000000-0000-4000-8000-000000000010";
    await raw`
      insert into connections (id, workspace_id, connector_id, name) values
        (${FULL}, ${workspaceId}, 'cmb', 'Full'),
        (${EMPTY}, ${workspaceId}, 'cmb', 'Empty')`;
    await raw`
      insert into connection_state (connection_id, workspace_id, last_success_at)
      values (${FULL}, ${workspaceId}, ${NOW.toISOString()}),
             (${EMPTY}, ${workspaceId}, ${NOW.toISOString()})`;
    await raw`
      insert into jobs (kind, workspace_id, connection_id, status)
      values ('connection.backfill', ${workspaceId}, ${FULL}, 'running')`;
    await observe(
      FULL,
      "cmb.visits",
      { resource: "full" },
      (d) => 20 + (d % 3),
    );
    await observe(EMPTY, "cmb.visits", { resource: "old" }, (d) =>
      d > 1300 ? 10 : null,
    );
    const compare: Compare = {
      name: "Full over empty visits",
      numerator: { metricKey: "cmb.visits", connectionId: FULL },
      denominator: { metricKey: "cmb.visits", connectionId: EMPTY },
      format: "ratio",
    };
    const binding = bindingOf(await compile(compare));
    const { dashboardId } = await insertCompares(++group, [
      { period: "last_7_days", ...inline(compare) },
      { period: "last_7_days", ...inline(compare), measure: binding },
    ]);
    const [unbound, bound] = compares(
      (await screen(dashboardId, NOW)).slides[0]!.widgets,
    );
    expect(unbound!.data.numerator.value).not.toBeNull();
    expect(unbound!.data.denominator.value).toBeNull();
    expect(unbound!.data.status).toBe("no_data");
    expect(bound!.data.status).toBe(unbound!.data.status);
  }, 60_000);
});
