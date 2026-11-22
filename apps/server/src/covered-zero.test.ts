import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deviceDashboardV2ResponseSchema,
  goalListResponseSchema,
  goalResponseSchema,
  metricBreakdownResponseSchema,
  metricQueryResponseSchema,
  workspaceResponseSchema,
  type DeviceDashboardV2Response,
  type DeviceWidget,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import { createAppleAdsConnector } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { connectionResourceKey } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { buildDeviceDashboardV2 } from "./devices/dashboard.js";
import { loadConfig } from "./env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// An inactive but synced ad account (#378): Apple Ads answers days without
// activity as date-only entries, which the sync does not store (#370), so
// the account has no observations in the window. Its spend and installs
// read 0, not "No data yet", once its freshness says the days are read;
// cost per install has no ratio. Without freshness, for days not read yet
// and while a backfill runs, an empty window stays "no data".

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const NOW = new Date("2026-11-16T12:00:00Z");
const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const SPEND = "apple_ads.spend";
const INSTALLS = "apple_ads.installs";

const registry = new ConnectorRegistry();
registry.register(createAppleAdsConnector());

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
/** Read through yesterday, no activity at all. */
let inactive: string;
/** No freshness row: an older connector or a sync that reported none. */
let unreported: string;
/** Read, but a backfill of its history is queued. */
let backfilling: string;
/** Read through yesterday, with installs on one day of the window. */
let active: string;
/**
 * Its backfill failed (a key refused halfway); incrementals moved its
 * dataThrough on since: only the last few days are read.
 */
let unfinished: string;
/** Its last complete backfill started a week ago. */
let recent: string;

function call(
  method: "GET" | "POST",
  url: string,
  payload?: unknown,
): Promise<InjectResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { cookie },
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

/** Where a complete 12-month backfill started. */
const BACKFILLED_FROM = "2025-11-17T09:00:00Z";

async function connection(
  name: string,
  dataThrough: string | null,
  /** The start of the last complete backfill; null: none succeeded. */
  historyFrom: string | null = BACKFILLED_FROM,
): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name, config)
    values (${workspaceId}, 'apple-ads', ${name},
      ${admin.json({ adAccountId: "1000", currency: "EUR", timeZone: "Europe/Berlin" })})
    returning id`;
  const id = row!.id as string;
  await admin`
    insert into connection_state (connection_id, workspace_id,
      last_success_at, poll_interval_seconds, next_due_at, history_from)
    values (${id}, ${workspaceId}, ${at(-5 * MINUTE)}, 21600,
      ${at(2 * HOUR)}, ${historyFrom})`;
  if (dataThrough !== null) {
    await admin`
      insert into connection_freshness (workspace_id, connection_id, stream,
        resource, data_through, time_zone, checked_at, advanced_at)
      values (${workspaceId}, ${id}, 'ads', '', ${dataThrough},
        'Europe/Berlin', ${at(-5 * MINUTE)}, ${at(-5 * MINUTE)})`;
  }
  return id;
}

const query = (connectionId: string, fields: Record<string, unknown> = {}) =>
  call("POST", `/v1/workspaces/${workspaceId}/metrics/query`, {
    connectionId,
    metricKey: INSTALLS,
    period: "last_7_days",
    aggregation: "sum",
    ...fields,
  });

function ok(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  return metricQueryResponseSchema.parse(response.json());
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
  app = await buildApp(config, {
    db,
    registry,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
    now: () => NOW,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  cookie = await signUp("covered-zero@example.com");
  const created = await call("POST", "/v1/workspaces", { name: "Ads" });
  workspaceId = workspaceResponseSchema.parse(created.json()).workspace.id;
  await admin`update workspaces set time_zone = 'Europe/Berlin'
    where id = ${workspaceId}`;

  inactive = await connection("Inactive", "2026-11-15");
  unreported = await connection("Unreported", null);
  backfilling = await connection("Backfilling", "2026-11-15");
  await admin`
    insert into jobs (workspace_id, connection_id, kind, status, payload)
    values (${workspaceId}, ${backfilling}, 'connection.backfill', 'pending',
      ${admin.json({ connectionId: backfilling })})`;
  unfinished = await connection("Unfinished", "2026-11-15", null);
  recent = await connection("Recent", "2026-11-15", "2026-11-09T09:00:00Z");
  active = await connection("Active", "2026-11-15");
  await admin`
    insert into observations (workspace_id, connection_id,
      metric_definition_id, dimensions, source_timestamp, value)
    select ${workspaceId}, ${active}, m.id,
           ${admin.json({ resource: "app-1", campaign: "1", country: "DE" })},
           '2026-11-12T00:00:00Z'::timestamptz, 3
    from metric_definitions m where m.key = ${INSTALLS}`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("an empty window of read days (#378)", () => {
  it("reads installs and spend as 0 for an inactive account", async () => {
    const installs = ok(await query(inactive));
    expect(installs).toMatchObject({
      value: 0,
      // The previous window can reach before the history: not a zero.
      previousValue: null,
      delta: null,
      ratio: null,
    });
    const spend = ok(
      await query(inactive, {
        metricKey: SPEND,
        dimensions: { currency: "EUR" },
      }),
    );
    expect(spend).toMatchObject({ value: 0, currency: "EUR" });
  });

  it("reads spend without a currency filter as 0 in the account's currency", async () => {
    // Nothing in the window to rank: the connection's own currency.
    const spend = ok(await query(inactive, { metricKey: SPEND }));
    expect(spend).toMatchObject({ value: 0, currency: "EUR" });
  });

  it("keeps no data under a filter that could hide activity", async () => {
    // Countries (and keywords) are stored as the top 10 plus Others: a
    // country outside them has no rows although it had spend.
    const country = ok(
      await query(inactive, {
        metricKey: SPEND,
        dimensions: { currency: "EUR", country: "FR" },
      }),
    );
    expect(country.value).toBeNull();
    // An app may be outside the selection, or selected after the history
    // was read; a slide scoped to it sends it as this filter.
    const app = ok(
      await query(inactive, { dimensions: { resource: "app-9" } }),
    );
    expect(app.value).toBeNull();
  });

  it("keeps no data where the history was never read completely", async () => {
    // A backfill that ended failed claims no history, however far
    // incrementals moved dataThrough since.
    expect(ok(await query(unfinished)).value).toBeNull();
    expect(
      ok(await query(unfinished, { period: "last_90_days" })).value,
    ).toBeNull();
    // A window that starts before the last complete backfill did.
    expect(ok(await query(recent, { period: "last_7_days" })).value).toBe(0);
    expect(
      ok(await query(recent, { period: "last_30_days" })).value,
    ).toBeNull();
    // A year back is within the 12-month backfill.
    expect(ok(await query(inactive, { period: "last_90_days" })).value).toBe(0);
  });

  it("keeps a window of days not read yet as no data", async () => {
    // Today is after the last day read.
    expect(ok(await query(inactive, { period: "today" })).value).toBeNull();
  });

  it("keeps no data without freshness or while a backfill runs", async () => {
    expect(ok(await query(unreported)).value).toBeNull();
    expect(ok(await query(backfilling)).value).toBeNull();
  });

  it("leaves a window with data as it was", async () => {
    expect(ok(await query(active)).value).toBe(3);
  });
});

// Breakdowns have nothing to rank over a quiet window (#799): the same
// rule says whether that is "no activity" or still "no data yet".
describe("an empty breakdown of read days (#799)", () => {
  const breakdown = async (
    connectionId: string,
    fields: Record<string, unknown> = {},
  ) => {
    const response = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/metrics/breakdown`,
      {
        connectionId,
        metricKey: INSTALLS,
        period: "last_7_days",
        aggregation: "sum",
        groupBy: "country",
        ...fields,
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    return metricBreakdownResponseSchema.parse(response.json());
  };

  it("says no activity for an inactive account", async () => {
    const installs = await breakdown(inactive);
    expect(installs).toMatchObject({ groups: [], others: null });
    expect(installs.noActivity).toBe(true);
    // No amount is shown, so spend needs no currency filter.
    expect((await breakdown(inactive, { metricKey: SPEND })).noActivity).toBe(
      true,
    );
    expect(
      (await breakdown(inactive, { groupBy: "campaign", withPrevious: true }))
        .noActivity,
    ).toBe(true);
  });

  it("keeps no data for a window that is not covered", async () => {
    // Today is after the last day read.
    expect(
      (await breakdown(inactive, { period: "today" })).noActivity,
    ).toBeUndefined();
    // Before the last complete backfill started, or none completed.
    expect((await breakdown(recent)).noActivity).toBe(true);
    expect(
      (await breakdown(recent, { period: "last_30_days" })).noActivity,
    ).toBeUndefined();
    expect((await breakdown(unfinished)).noActivity).toBeUndefined();
    // No freshness, and a running backfill.
    expect((await breakdown(unreported)).noActivity).toBeUndefined();
    expect((await breakdown(backfilling)).noActivity).toBeUndefined();
  });

  it("keeps no data under a filter, an app scope or chosen groups", async () => {
    // A slide scoped to an app or a product sends its app as this filter.
    expect(
      (await breakdown(inactive, { dimensions: { resource: "app-9" } }))
        .noActivity,
    ).toBeUndefined();
    expect(
      (await breakdown(inactive, { dimensions: { campaign: "7" } })).noActivity,
    ).toBeUndefined();
    // A table of chosen groups (#847) cannot tell quiet from not stored.
    expect(
      (await breakdown(inactive, { groups: ["DE", "FR"] })).noActivity,
    ).toBeUndefined();
    // An average has no "nothing happened".
    expect(
      (await breakdown(inactive, { aggregation: "avg" })).noActivity,
    ).toBeUndefined();
  });

  it("leaves a breakdown with groups as it was", async () => {
    const found = await breakdown(active);
    expect(found.groups).toMatchObject([{ key: "DE", value: 3 }]);
    expect(found.noActivity).toBeUndefined();
  });
});

// A goal reads its metric with the metric query, so a quiet period the
// source read stands at 0 % instead of without a value (#799).
describe("a goal over a quiet period (#799)", () => {
  const goal = async (name: string, fields: Record<string, unknown>) => {
    const response = await call("POST", `/v1/workspaces/${workspaceId}/goals`, {
      name,
      metricKey: INSTALLS,
      aggregation: "sum",
      period: "this_month",
      target: 100,
      ...fields,
    });
    expect(response.statusCode, response.body).toBe(200);
    return goalResponseSchema.parse(response.json()).goal;
  };

  it("stands at 0 when the period was read and quiet", async () => {
    const quiet = await goal("Quiet", { connectionId: inactive });
    expect(quiet.current).toMatchObject({
      value: 0,
      progress: 0,
      reachedAt: null,
    });
    // Reading and listing agree.
    const read = await call(
      "GET",
      `/v1/workspaces/${workspaceId}/goals/${quiet.id}`,
    );
    expect(read.json().goal.current).toMatchObject({ value: 0, progress: 0 });
    const listed = goalListResponseSchema.parse(
      (await call("GET", `/v1/workspaces/${workspaceId}/goals`)).json(),
    );
    expect(
      listed.goals.find((entry) => entry.id === quiet.id)?.current,
    ).toMatchObject({ value: 0, progress: 0 });
    // A spend goal in its fixed currency.
    const spend = await goal("Quiet spend", {
      connectionId: inactive,
      metricKey: SPEND,
      dimensions: { currency: "EUR" },
    });
    expect(spend.current).toMatchObject({ value: 0, currency: "EUR" });
  });

  it("keeps no value for a period that is not covered", async () => {
    // NOW is a Monday: the week starts today, after the last day read.
    const week = await goal("This week", {
      connectionId: inactive,
      period: "this_week",
    });
    expect(week.current).toMatchObject({ value: null, progress: null });
    // The month starts before the last complete backfill did.
    const early = await goal("Recent", { connectionId: recent });
    expect(early.current).toMatchObject({ value: null, progress: null });
    const none = await goal("Unreported", { connectionId: unreported });
    expect(none.current).toMatchObject({ value: null, progress: null });
    const loading = await goal("Backfilling", { connectionId: backfilling });
    expect(loading.current).toMatchObject({ value: null, progress: null });
  });

  it("keeps no value under an app or another filter", async () => {
    await admin`
      insert into connection_resources (connection_id, workspace_id,
        resource_id, name, kind)
      values (${inactive}, ${workspaceId}, 'app-9', 'Nine', 'app')`;
    const app = await goal("One app", {
      connectionId: inactive,
      dimensions: { resource: "app-9" },
    });
    expect(app.current).toMatchObject({ value: null, progress: null });
    const country = await goal("One country", {
      connectionId: inactive,
      dimensions: { country: "FR" },
    });
    expect(country.current).toMatchObject({ value: null, progress: null });
  });

  it("leaves a goal with data as it was", async () => {
    const busy = await goal("Busy", { connectionId: active });
    expect(busy.current).toMatchObject({ value: 3, progress: 0.03 });
  });
});

describe("goals and breakdowns of an inactive account on screens (#799)", () => {
  let dashboardId: string;

  beforeAll(async () => {
    const [dashboard] = await admin`
      insert into dashboards (workspace_id, name)
      values (${workspaceId}, 'Quiet') returning id`;
    dashboardId = dashboard!.id as string;
    const slide = async (position: number, scope: unknown = {}) => {
      const [row] = await admin`
        insert into dashboard_slides (dashboard_id, workspace_id, position,
          scope)
        values (${dashboardId}, ${workspaceId}, ${position},
          ${admin.json(scope as never)}) returning id`;
      return row!.id as string;
    };
    const plain = await slide(0);
    let placed = 0;
    const widget = async (slideId: string, fields: Record<string, unknown>) => {
      const { dimensions, options, ...rest } = fields;
      const cell = placed++;
      await admin`
        insert into dashboard_widgets ${admin({
          slide_id: slideId,
          dashboard_id: dashboardId,
          workspace_id: workspaceId,
          x: (cell % 3) * 4,
          y: Math.floor(cell / 3),
          w: 4,
          h: 1,
          ...rest,
          dimensions: admin.json((dimensions ?? {}) as never),
          options: admin.json((options ?? {}) as never),
        } as never)}`;
    };
    const breakdown = (
      type: "bar" | "table",
      title: string,
      connectionId: string,
      more: Record<string, unknown> = {},
    ) => ({
      type,
      title,
      connection_id: connectionId,
      metric_key: INSTALLS,
      aggregation: "sum",
      period: "last_30_days",
      options: { groupBy: "country" },
      ...more,
    });
    await widget(plain, breakdown("bar", "Quiet bar", inactive));
    await widget(plain, breakdown("table", "Quiet table", inactive));
    await widget(
      plain,
      breakdown("table", "Chosen rows", inactive, {
        options: { groupBy: "country", groupKeys: ["DE"] },
      }),
    );
    await widget(
      plain,
      breakdown("bar", "One app", inactive, {
        dimensions: { resource: "app-9" },
      }),
    );
    await widget(
      plain,
      breakdown("bar", "Today", inactive, { period: "today" }),
    );
    await widget(plain, breakdown("bar", "Unreported bar", unreported));
    await widget(plain, breakdown("table", "Backfilling table", backfilling));
    await widget(plain, breakdown("bar", "Busy bar", active));
    const goalId = async (name: string, fields: Record<string, unknown>) => {
      const response = await call(
        "POST",
        `/v1/workspaces/${workspaceId}/goals`,
        {
          name,
          metricKey: INSTALLS,
          aggregation: "sum",
          period: "this_month",
          target: 100,
          ...fields,
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      return goalResponseSchema.parse(response.json()).goal.id;
    };
    const gauge = async (title: string, fields: Record<string, unknown>) =>
      widget(plain, {
        type: "gauge",
        title,
        goal_id: await goalId(`Screen ${title}`, fields),
      });
    await gauge("Quiet goal", { connectionId: inactive });
    await gauge("Week goal", { connectionId: inactive, period: "this_week" });
    await gauge("Unreported goal", { connectionId: unreported });
    // A slide scoped to an app: its breakdowns read that app only.
    const scoped = await slide(1, {
      app: { kind: "values", values: [`${inactive}:app-9`] },
    });
    await widget(scoped, breakdown("bar", "Scoped bar", inactive));
  });

  const payload = async () =>
    deviceDashboardV2ResponseSchema.parse(
      await withWorkspace(db, { workspaceId }, (tx) =>
        buildDeviceDashboardV2(tx, workspaceId, dashboardId, {
          now: NOW,
          freshness: registry,
        }),
      ),
    );

  const dataOf = (found: DeviceDashboardV2Response, label: string) => {
    const widget = found.slides
      .flatMap((slide) => slide.widgets)
      .find((entry) => "label" in entry && entry.label === label);
    if (!widget) throw new Error(`no widget ${label}`);
    return (widget as Extract<DeviceWidget, { data: unknown }>).data as Record<
      string,
      unknown
    >;
  };

  it("marks a read, quiet breakdown and keeps its status", async () => {
    const found = await payload();
    // `no_data` stays, so a screen without the field says "No data yet".
    expect(dataOf(found, "Quiet bar")).toMatchObject({
      status: "no_data",
      bars: [],
      others: null,
      noActivity: true,
    });
    expect(dataOf(found, "Quiet table")).toMatchObject({
      status: "no_data",
      rows: [],
      noActivity: true,
    });
  });

  it("leaves every other breakdown without the field", async () => {
    const found = await payload();
    for (const label of [
      "Chosen rows",
      "One app",
      "Scoped bar",
      "Today",
      "Unreported bar",
    ]) {
      const data = dataOf(found, label);
      expect(data.status, label).toBe("no_data");
      expect("noActivity" in data, label).toBe(false);
    }
    const loading = dataOf(found, "Backfilling table");
    expect(loading.status).toBe("backfilling");
    expect("noActivity" in loading).toBe(false);
    const busy = dataOf(found, "Busy bar");
    expect(busy).toMatchObject({ status: "ok", bars: [{ key: "DE" }] });
    expect("noActivity" in busy).toBe(false);
  });

  it("shows a goal over a read, quiet period at 0", async () => {
    const found = await payload();
    expect(dataOf(found, "Quiet goal")).toMatchObject({
      status: "ok",
      value: 0,
      progress: 0,
      target: 100,
    });
    for (const label of ["Week goal", "Unreported goal"]) {
      expect(dataOf(found, label), label).toMatchObject({
        status: "no_data",
        value: null,
        progress: null,
      });
    }
  });
});

// A slide scoped to a linked product (#777) reads the product's app of
// the widget's connection: a scoped widget, outside the rule like one
// fixed to an app, although the whole account was read and quiet.
describe("a product-scoped slide of an inactive account (#799)", () => {
  let dashboardId: string;

  beforeAll(async () => {
    const data = `/v1/workspaces/${workspaceId}/data`;
    const mapping = await call("POST", `${data}/manual`, {
      definition: {
        key: "store_mapping",
        name: "Mapping",
        version: 1,
        mode: "snapshot",
        grain: "One product per source app",
        keyFields: ["app_key"],
        retentionDays: null,
        fields: ["app_key", "product_id"].map((id) => ({
          id,
          name: id,
          type: "string",
          nullable: false,
          classification: "internal",
        })),
      },
      records: [
        {
          values: {
            app_key: connectionResourceKey(inactive, "app-9"),
            product_id: "product:quiet",
          },
        },
      ],
    });
    expect(mapping.statusCode, mapping.body).toBe(200);
    const datasetId = (mapping.json() as { datasetId: string }).datasetId;
    const model = await call("POST", `${data}/models`, {
      name: "Products",
      definition: {
        version: 1,
        datasets: [datasetId],
        relationships: [],
        dimensions: [
          { id: "app", name: "App", datasetId, fieldId: "product_id" },
        ],
        measures: [
          {
            id: "apps",
            name: "Apps",
            kind: "aggregate",
            datasetId,
            aggregate: { id: "apps", name: "apps", op: "count" },
          },
        ],
      },
    });
    expect(model.statusCode, model.body).toBe(200);
    const modelId = (model.json() as { model: { id: string } }).model.id;
    const published = await call("POST", `${data}/models/${modelId}/publish`, {
      version: 1,
    });
    expect(published.statusCode, published.body).toBe(200);
    await admin`
      insert into data_template_installs (workspace_id, request_id,
        request_hash, result)
      values (${workspaceId}, gen_random_uuid(), ${"0".repeat(64)},
        ${admin.json({ mappingDatasetId: datasetId })})`;
    const [dashboard] = await admin`
      insert into dashboards (workspace_id, name, data_filters)
      values (${workspaceId}, 'Product', ${admin.json([
        {
          id: "app",
          name: "App",
          type: "string",
          mode: "values",
          mappings: [{ modelId, dimensionId: "app" }],
          defaultValue: null,
        },
      ] as never)}) returning id`;
    dashboardId = dashboard!.id as string;
    const slide = async (position: number, scope: unknown) => {
      const [row] = await admin`
        insert into dashboard_slides (dashboard_id, workspace_id, position,
          scope)
        values (${dashboardId}, ${workspaceId}, ${position},
          ${admin.json(scope as never)}) returning id`;
      return row!.id as string;
    };
    const widgets = async (slideId: string, prefix: string) => {
      const kinds = [
        { type: "metric", options: {} },
        { type: "bar", options: { groupBy: "country" } },
        { type: "table", options: { groupBy: "country" } },
      ];
      for (const [index, kind] of kinds.entries()) {
        await admin`
          insert into dashboard_widgets ${admin({
            slide_id: slideId,
            dashboard_id: dashboardId,
            workspace_id: workspaceId,
            x: index * 4,
            y: 0,
            w: 4,
            h: 1,
            type: kind.type,
            title: `${prefix} ${kind.type}`,
            connection_id: inactive,
            metric_key: INSTALLS,
            aggregation: "sum",
            period: "last_30_days",
            dimensions: admin.json({} as never),
            options: admin.json(kind.options as never),
          } as never)}`;
      }
    };
    await widgets(
      await slide(0, { app: { kind: "values", values: ["product:quiet"] } }),
      "Product",
    );
    await widgets(await slide(1, {}), "Account");
  }, 120_000);

  it("keeps no data on the product's slide and 0 on the account's", async () => {
    const found = deviceDashboardV2ResponseSchema.parse(
      await withWorkspace(db, { workspaceId }, (tx) =>
        buildDeviceDashboardV2(tx, workspaceId, dashboardId, {
          now: NOW,
          freshness: registry,
        }),
      ),
    );
    const dataOf = (label: string) => {
      const widget = found.slides
        .flatMap((slide) => slide.widgets)
        .find((entry) => "label" in entry && entry.label === label);
      if (!widget) throw new Error(`no widget ${label}`);
      return (widget as Extract<DeviceWidget, { data: unknown }>)
        .data as Record<string, unknown>;
    };
    // The same widgets without the scope: the control.
    expect(dataOf("Account metric")).toMatchObject({ status: "ok", value: 0 });
    expect(dataOf("Account bar")).toMatchObject({
      status: "no_data",
      noActivity: true,
    });
    expect(dataOf("Account table")).toMatchObject({
      status: "no_data",
      noActivity: true,
    });
    // Scoped to the product's app: no 0, no "no activity".
    expect(dataOf("Product metric")).toMatchObject({
      status: "no_data",
      value: null,
    });
    for (const label of ["Product bar", "Product table"]) {
      const data = dataOf(label);
      expect(data.status, label).toBe("no_data");
      expect("noActivity" in data, label).toBe(false);
    }
  });
});

describe("Apple Ads tiles of an inactive account on screens (#378)", () => {
  let dashboardId: string;

  beforeAll(async () => {
    const [dashboard] = await admin`
      insert into dashboards (workspace_id, name)
      values (${workspaceId}, 'Ads') returning id`;
    dashboardId = dashboard!.id as string;
    const [slide] = await admin`
      insert into dashboard_slides (dashboard_id, workspace_id, position)
      values (${dashboardId}, ${workspaceId}, 0) returning id`;
    const widget = async (fields: Record<string, unknown>, y: number) => {
      const { dimensions, ...rest } = fields;
      await admin`
        insert into dashboard_widgets ${admin({
          slide_id: slide!.id as string,
          dashboard_id: dashboardId,
          workspace_id: workspaceId,
          x: 0,
          y,
          w: 4,
          h: 1,
          aggregation: "sum",
          period: "last_30_days",
          ...rest,
          dimensions: admin.json((dimensions ?? {}) as never),
        } as never)}`;
    };
    await widget(
      {
        type: "metric",
        title: "Spend",
        connection_id: inactive,
        metric_key: SPEND,
        dimensions: { currency: "EUR" },
      },
      0,
    );
    await widget(
      {
        type: "metric",
        title: "Installs",
        connection_id: inactive,
        metric_key: INSTALLS,
      },
      1,
    );
    await widget(
      {
        type: "compare",
        title: "Cost per install",
        connection_id: inactive,
        metric_key: SPEND,
        dimensions: { currency: "EUR" },
        denominator_connection_id: inactive,
        denominator_metric_key: INSTALLS,
        denominator_aggregation: "sum",
        options: admin.json({ format: "ratio" } as never),
      },
      2,
    );
    await widget(
      {
        type: "metric",
        title: "Backfilling installs",
        connection_id: backfilling,
        metric_key: INSTALLS,
      },
      3,
    );
  });

  const payload = () =>
    withWorkspace(db, { workspaceId }, (tx) =>
      buildDeviceDashboardV2(tx, workspaceId, dashboardId, {
        now: NOW,
        freshness: registry,
      }),
    );

  const dataOf = (found: DeviceDashboardV2Response, label: string) => {
    const widget = found.slides
      .flatMap((slide) => slide.widgets)
      .find((entry) => "label" in entry && entry.label === label);
    if (!widget) throw new Error(`no widget ${label}`);
    return (widget as Extract<DeviceWidget, { data: unknown }>).data as Record<
      string,
      unknown
    >;
  };

  it("shows 0 and €0, and cost per install without a ratio", async () => {
    const found = deviceDashboardV2ResponseSchema.parse(await payload());
    expect(dataOf(found, "Spend")).toMatchObject({
      status: "ok",
      value: 0,
      unit: "EUR_minor",
    });
    expect(dataOf(found, "Installs")).toMatchObject({ status: "ok", value: 0 });
    expect(dataOf(found, "Cost per install")).toMatchObject({
      status: "ok",
      numerator: { value: 0 },
      denominator: { value: 0 },
      ratio: { value: null },
    });
  });

  it("keeps a backfilling account's empty window as backfilling", async () => {
    const found = deviceDashboardV2ResponseSchema.parse(await payload());
    expect(dataOf(found, "Backfilling installs")).toMatchObject({
      status: "backfilling",
      value: null,
    });
  });
});
