import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardResponseSchema,
  errorResponseSchema,
  metricCurrenciesResponseSchema,
  metricQueryResponseSchema,
  metricResourcesResponseSchema,
  workspaceMetricListResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { addDays, civilDate } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { buildDeviceDashboard } from "./devices/dashboard.js";
import { loadConfig } from "./env.js";
import { queryMetric } from "./metrics/query.js";
import { createTestDatabase } from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let stranger: string;
let workspaceId: string;
let otherWorkspaceId: string;
let connectionId: string;
let otherConnectionId: string;

const BERLIN = "Europe/Berlin";
// A fixed clock (#144): 22:30 UTC is already the next day in Berlin, so the
// Berlin workspace's "today" differs from the UTC workspace's.
const NOW = new Date("2025-07-15T22:30:00Z");

function call(
  method: "GET" | "POST" | "PATCH",
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

async function createWorkspace(cookie: string, timeZone?: string) {
  const response = await call("POST", "/v1/workspaces", cookie, {
    name: "Metrics",
    ...(timeZone ? { timeZone } : {}),
  });
  expect(response.statusCode).toBe(200);
  return workspaceResponseSchema.parse(response.json()).workspace;
}

async function createConnection(workspace: string): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspace}, 'demo', 'Demo') returning id`;
  return row!.id as string;
}

async function observe(
  workspace: string,
  connection: string,
  metricKey: string,
  date: string,
  value: number,
  resource = "site-1",
) {
  await admin`
    insert into observations (workspace_id, connection_id, metric_definition_id,
      dimensions, source_timestamp, value)
    select ${workspace}, ${connection}, m.id, ${admin.json({ resource })},
           ${`${date}T00:00:00Z`}::timestamptz, ${value}
    from metric_definitions m
    where m.connector_id = 'demo' and m.key = ${metricKey}`;
}

function query(cookie: string | null, workspace: string, body: unknown) {
  return call(
    "POST",
    `/v1/workspaces/${workspace}/metrics/query`,
    cookie,
    body,
  );
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
  app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    now: () => NOW,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  owner = await signUp("metrics-owner@example.com");
  stranger = await signUp("metrics-stranger@example.com");
  workspaceId = (await createWorkspace(owner, BERLIN)).id;
  otherWorkspaceId = (await createWorkspace(stranger)).id;
  connectionId = await createConnection(workspaceId);
  otherConnectionId = await createConnection(otherWorkspaceId);

  // Daily signups (delta) for the last 14 reporting dates in Berlin, 1..14
  // with today = 14, plus another (UTC) workspace's data for its own today
  // that must never count.
  const today = civilDate(NOW, BERLIN);
  for (let i = 0; i < 14; i++) {
    await observe(
      workspaceId,
      connectionId,
      "demo.signups",
      addDays(today, -i),
      14 - i,
    );
  }
  await observe(
    otherWorkspaceId,
    otherConnectionId,
    "demo.signups",
    civilDate(NOW, "UTC"),
    1000,
  );
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("workspace time zone", () => {
  it("is set at creation and defaults to UTC", async () => {
    const berlin = await createWorkspace(owner, BERLIN);
    expect(berlin.timeZone).toBe(BERLIN);
    expect((await createWorkspace(owner)).timeZone).toBe("UTC");
  });

  it("rejects unknown zones", async () => {
    const response = await call("POST", "/v1/workspaces", owner, {
      name: "Nowhere",
      timeZone: "Mars/Olympus",
    });
    expect(response.statusCode).toBe(400);
  });

  it("can be changed by an owner and is audited", async () => {
    const workspace = await createWorkspace(owner);
    const response = await call(
      "PATCH",
      `/v1/workspaces/${workspace.id}`,
      owner,
      { timeZone: "America/New_York" },
    );
    expect(response.statusCode).toBe(200);
    expect(
      workspaceResponseSchema.parse(response.json()).workspace,
    ).toMatchObject({ name: "Metrics", timeZone: "America/New_York" });
    const [event] = await admin`
      select metadata from audit_events
      where workspace_id = ${workspace.id}
        and action = 'workspace.time_zone_changed'`;
    expect(event!.metadata).toEqual({
      oldTimeZone: "UTC",
      newTimeZone: "America/New_York",
    });
  });
});

describe("GET /v1/workspaces/:id/metrics", () => {
  it("lists metrics with the aggregations a tile may use", async () => {
    const response = await call(
      "GET",
      `/v1/workspaces/${workspaceId}/metrics`,
      owner,
    );
    expect(response.statusCode).toBe(200);
    const { metrics } = workspaceMetricListResponseSchema.parse(
      response.json(),
    );
    const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));
    // demo.visitors is a gauge that declares every aggregation: "sum" is
    // not meaningful for a level, so it is not offered.
    expect(byKey["demo.visitors"]?.aggregations).toEqual([
      "last",
      "avg",
      "min",
      "max",
    ]);
    expect(byKey["demo.signups"]?.aggregations).toEqual(["sum"]);
    expect(metrics.every((m) => m.connectionId === connectionId)).toBe(true);
  });
});

describe("POST /v1/workspaces/:id/metrics/query", () => {
  it("sums a delta over the period and compares with the previous one", async () => {
    const response = await query(owner, workspaceId, {
      connectionId,
      metricKey: "demo.signups",
      period: "last_7_days",
    });
    expect(response.statusCode).toBe(200);
    const result = metricQueryResponseSchema.parse(response.json());
    // Last 7 days: 8..14 → 77. The 7 days before: 1..7 → 28.
    expect(result).toMatchObject({
      timeZone: BERLIN,
      aggregation: "sum",
      value: 77,
      previousValue: 28,
      delta: 49,
      ratio: 1.75,
    });
    expect(result.series).toHaveLength(7);
    expect(result.series.at(-1)?.value).toBe(14);
  });

  it("marks buckets without data as null", async () => {
    const response = await query(owner, workspaceId, {
      connectionId,
      metricKey: "demo.signups",
      period: "last_30_days",
    });
    const result = metricQueryResponseSchema.parse(response.json());
    expect(result.series).toHaveLength(30);
    expect(result.series.filter((point) => point.value === null)).toHaveLength(
      16,
    );
    expect(result.previousValue).toBeNull();
    expect(result.ratio).toBeNull();
  });

  it("filters by dimension", async () => {
    const response = await query(owner, workspaceId, {
      connectionId,
      metricKey: "demo.signups",
      period: "today",
      dimensions: { resource: "another-site" },
    });
    expect(metricQueryResponseSchema.parse(response.json()).value).toBeNull();
  });

  it("rejects aggregations that do not fit the metric", async () => {
    const response = await query(owner, workspaceId, {
      connectionId,
      metricKey: "demo.visitors",
      period: "today",
      aggregation: "sum",
    });
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      "aggregation_not_supported",
    );
  });

  it.each([
    ["an unknown metric", () => ({ connectionId, metricKey: "nope" })],
    [
      "another workspace's connection",
      () => ({ connectionId: otherConnectionId, metricKey: "demo.signups" }),
    ],
  ])("answers 404 for %s", async (_label, body) => {
    const response = await query(owner, workspaceId, {
      ...body(),
      period: "today",
    });
    expect(response.statusCode).toBe(404);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      "metric_not_found",
    );
  });

  it("is tenant-scoped", async () => {
    // Not a member of the workspace.
    const response = await query(stranger, workspaceId, {
      connectionId,
      metricKey: "demo.signups",
      period: "today",
    });
    expect(response.statusCode).toBe(404);
    // The other workspace sees only its own data.
    const own = await query(stranger, otherWorkspaceId, {
      connectionId: otherConnectionId,
      metricKey: "demo.signups",
      period: "today",
    });
    expect(metricQueryResponseSchema.parse(own.json()).value).toBe(1000);
  });

  it("requires a session", async () => {
    const response = await query(null, workspaceId, {
      connectionId,
      metricKey: "demo.signups",
      period: "today",
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("queryMetric", () => {
  it("picks the workspace's reporting date just after local midnight", async () => {
    // 22:30 UTC on the 27th is 00:30 on the 28th in Berlin.
    await observe(workspaceId, connectionId, "demo.signups", "2020-09-27", 5);
    await observe(workspaceId, connectionId, "demo.signups", "2020-09-28", 9);
    const result = await withWorkspace(db, { workspaceId }, (tx) =>
      queryMetric(
        tx,
        workspaceId,
        { connectionId, metricKey: "demo.signups", period: "today" },
        new Date("2020-09-27T22:30:00Z"),
      ),
    );
    expect(result.ok && result.value).toMatchObject({
      value: 9,
      previousValue: 5,
      series: [{ bucket: "2020-09-28T00:00:00.000Z", value: 9 }],
    });
  });
});

describe("daily gauges with missing days (#165)", () => {
  // demo.visitors is a daily gauge. Days without a value (a Search Console
  // day without impressions has no position) are skipped, not read as 0.
  const now = new Date("2020-03-10T12:00:00Z");
  const run = (aggregation: "last" | "min" | "max") =>
    withWorkspace(db, { workspaceId }, (tx) =>
      queryMetric(
        tx,
        workspaceId,
        {
          connectionId,
          metricKey: "demo.visitors",
          period: "last_7_days",
          aggregation,
        },
        now,
      ),
    );

  beforeAll(async () => {
    // 03-04..03-08 have values; 03-09 and 03-10 (today) have none.
    for (const [date, value] of [
      ["2020-03-04", 5],
      ["2020-03-05", 3],
      ["2020-03-06", 8],
      ["2020-03-07", 6],
      ["2020-03-08", 4],
    ] as const) {
      await observe(workspaceId, connectionId, "demo.visitors", date, value);
    }
  });

  it("reads Latest day as the latest day that has a value", async () => {
    const result = await run("last");
    expect(result.ok && result.value.value).toBe(4);
    expect(
      result.ok && result.value.series.map((point) => point.value),
    ).toEqual([5, 3, 8, 6, 4, null, null]);
  });

  it("reads Lowest and Highest day over the days that have a value", async () => {
    expect(await run("min")).toMatchObject({ value: { value: 3 } });
    expect(await run("max")).toMatchObject({ value: { value: 8 } });
  });
});

describe("per-currency amounts (#173)", () => {
  // A "currency_minor" metric (ADR 0014): integer minor units, the ISO 4217
  // code in the "currency" dimension. Its own workspace and connector, so
  // the demo metrics above stay as they are.
  let storeWorkspace: string;
  let store: string;
  const today = civilDate(NOW, "UTC");

  async function proceeds(
    date: string,
    value: number,
    currency: string,
    app = "app-1",
  ) {
    await admin`
      insert into observations (workspace_id, connection_id,
        metric_definition_id, dimensions, source_timestamp, value)
      select ${storeWorkspace}, ${store}, m.id, ${admin.json({ app, currency })},
             ${`${date}T00:00:00Z`}::timestamptz, ${value}
      from metric_definitions m
      where m.connector_id = 'test-store' and m.key = 'store.proceeds'`;
  }

  const ask = (dimensions?: Record<string, string>) =>
    query(owner, storeWorkspace, {
      connectionId: store,
      metricKey: "store.proceeds",
      period: "last_7_days",
      ...(dimensions ? { dimensions } : {}),
    });

  beforeAll(async () => {
    storeWorkspace = (await createWorkspace(owner)).id;
    await admin`
      insert into connectors (id, version, manifest)
      values ('test-store', '1.0.0', '{"id":"test-store"}'::jsonb)`;
    await admin`
      insert into metric_definitions (connector_id, key, name, description,
        kind, unit, granularity, dimensions, aggregations)
      values ('test-store', 'store.proceeds', 'Proceeds', 'Proceeds per day',
        'delta', 'currency_minor', 'day', '["app","currency"]', '["sum"]')`;
    const [row] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${storeWorkspace}, 'test-store', 'Store') returning id`;
    store = row!.id as string;

    // Today: €12.34 + €1.00, $5.00, ¥900; yesterday ¥100. A week before
    // (the previous period): €10.00.
    await proceeds(today, 1_234, "EUR");
    await proceeds(today, 100, "EUR", "app-2");
    await proceeds(today, 500, "USD");
    await proceeds(today, 900, "JPY");
    await proceeds(addDays(today, -1), 100, "JPY");
    await proceeds(addDays(today, -7), 1_000, "EUR");
  });

  it("rejects a query that would add up several currencies", async () => {
    const response = await ask();
    expect(response.statusCode).toBe(400);
    expect(errorResponseSchema.parse(response.json()).error).toBe(
      "currency_required",
    );
    // Filtering on another dimension still mixes currencies.
    expect((await ask({ app: "app-1" })).statusCode).toBe(400);
    expect((await ask({ currency: "euro" })).statusCode).toBe(400);
  });

  it("sums one currency's minor units and compares within it", async () => {
    const eur = metricQueryResponseSchema.parse(
      (await ask({ currency: "EUR" })).json(),
    );
    expect(eur).toMatchObject({
      currency: "EUR",
      value: 1_334,
      previousValue: 1_000,
      delta: 334,
    });
    expect(eur.metric.unit).toBe("currency_minor");
    const jpy = metricQueryResponseSchema.parse(
      (await ask({ currency: "JPY" })).json(),
    );
    expect(jpy).toMatchObject({ currency: "JPY", value: 1_000 });
    expect(jpy.series.at(-1)?.value).toBe(900);
  });

  it("reports no currency for other metrics", async () => {
    const response = await query(owner, workspaceId, {
      connectionId,
      metricKey: "demo.signups",
      period: "today",
    });
    expect(metricQueryResponseSchema.parse(response.json()).currency).toBe(
      null,
    );
  });

  it("lists the currencies with their own totals, largest first", async () => {
    const response = await call(
      "POST",
      `/v1/workspaces/${storeWorkspace}/metrics/currencies`,
      owner,
      { connectionId: store, metricKey: "store.proceeds", period: "today" },
    );
    expect(response.statusCode).toBe(200);
    expect(metricCurrenciesResponseSchema.parse(response.json())).toEqual({
      currencies: [
        { currency: "EUR", total: 1_334 },
        { currency: "JPY", total: 900 },
        { currency: "USD", total: 500 },
      ],
    });
  });

  it("lists currencies only for per-currency metrics, within the workspace", async () => {
    const notPerCurrency = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/metrics/currencies`,
      owner,
      { connectionId, metricKey: "demo.signups", period: "today" },
    );
    expect(errorResponseSchema.parse(notPerCurrency.json()).error).toBe(
      "metric_not_per_currency",
    );
    const foreign = await call(
      "POST",
      `/v1/workspaces/${storeWorkspace}/metrics/currencies`,
      stranger,
      { connectionId: store, metricKey: "store.proceeds", period: "today" },
    );
    expect(foreign.statusCode).toBe(404);
  });

  it("saves tiles only with a currency, and shows them on screens", async () => {
    const create = (dimensions: Record<string, string>) =>
      call("POST", `/v1/workspaces/${storeWorkspace}/dashboards`, owner, {
        name: "Proceeds",
        tiles: [
          {
            connectionId: store,
            metricKey: "store.proceeds",
            period: "today",
            dimensions,
          },
        ],
      });
    const without = await create({ app: "app-1" });
    expect(without.statusCode).toBe(400);
    expect(errorResponseSchema.parse(without.json()).error).toBe(
      "currency_required",
    );

    const saved = await create({ currency: "JPY" });
    expect(saved.statusCode).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(saved.json());
    const device = await withWorkspace(
      db,
      { workspaceId: storeWorkspace },
      (tx) =>
        buildDeviceDashboard(tx, storeWorkspace, dashboard.id, { now: NOW }),
    );
    // Screens get the currency's own unit, which they already format.
    expect(device.tiles[0]).toMatchObject({ value: 900, unit: "JPY_minor" });
  });
});

describe("one resource per tile (#194)", () => {
  // A connection with several apps: tiles show them added up (the default)
  // or one of them, by name.
  let appsWorkspace: string;
  let apps: string;
  let otherApps: string;
  const today = civilDate(NOW, "UTC");

  async function downloads(
    connection: string,
    date: string,
    value: number,
    resource: string,
  ) {
    await admin`
      insert into observations (workspace_id, connection_id,
        metric_definition_id, dimensions, source_timestamp, value)
      select ${appsWorkspace}, ${connection}, m.id, ${admin.json({ resource })},
             ${`${date}T00:00:00Z`}::timestamptz, ${value}
      from metric_definitions m
      where m.connector_id = 'test-apps' and m.key = 'apps.downloads'`;
  }

  const ask = (dimensions?: Record<string, string>) =>
    query(owner, appsWorkspace, {
      connectionId: apps,
      metricKey: "apps.downloads",
      period: "last_7_days",
      ...(dimensions ? { dimensions } : {}),
    });

  const resourcesOf = (
    cookie: string,
    workspace: string,
    connection: string,
    metricKey: string,
  ) =>
    call("POST", `/v1/workspaces/${workspace}/metrics/resources`, cookie, {
      connectionId: connection,
      metricKey,
    });

  const tile = (dimensions: Record<string, string>, title?: string) => ({
    connectionId: apps,
    metricKey: "apps.downloads",
    period: "last_7_days",
    dimensions,
    ...(title ? { title } : {}),
  });

  const createDashboard = (tiles: unknown[]) =>
    call("POST", `/v1/workspaces/${appsWorkspace}/dashboards`, owner, {
      name: "Apps",
      tiles,
    });

  beforeAll(async () => {
    appsWorkspace = (await createWorkspace(owner)).id;
    await admin`
      insert into connectors (id, version, manifest)
      values ('test-apps', '1.0.0', '{"id":"test-apps"}'::jsonb)`;
    await admin`
      insert into metric_definitions (connector_id, key, name, description,
        kind, unit, granularity, dimensions, aggregations)
      values
        ('test-apps', 'apps.downloads', 'Downloads', 'Downloads per day',
         'delta', 'count', 'day', '["resource"]', '["sum"]'),
        ('test-apps', 'apps.crashes', 'Crashes', 'Crashes per day',
         'delta', 'count', 'day', '["build"]', '["sum"]')`;
    const [row] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${appsWorkspace}, 'test-apps', 'App Store') returning id`;
    apps = row!.id as string;
    const [other] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${appsWorkspace}, 'test-apps', 'Other account') returning id`;
    otherApps = other!.id as string;

    // Today and the previous period (a week before) per app; app-9 has no
    // name yet, app-3 a name but no data. "other-app" is another
    // connection's.
    await downloads(apps, today, 10, "app-1");
    await downloads(apps, today, 5, "app-2");
    await downloads(apps, today, 1, "app-9");
    await downloads(apps, addDays(today, -7), 4, "app-1");
    await downloads(apps, addDays(today, -7), 6, "app-2");
    await downloads(otherApps, today, 100, "other-app");
    await admin`
      insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values
        (${apps}, ${appsWorkspace}, 'app-1', 'Wurfel', 'app'),
        (${apps}, ${appsWorkspace}, 'app-2', 'Dicey', 'app'),
        (${apps}, ${appsWorkspace}, 'app-3', 'Quiet', 'app'),
        (${otherApps}, ${appsWorkspace}, 'other-app', 'Elsewhere', 'app')`;
  });

  it("filters the value and the previous period by resource", async () => {
    const all = metricQueryResponseSchema.parse((await ask()).json());
    expect(all).toMatchObject({ value: 16, previousValue: 10 });
    const one = metricQueryResponseSchema.parse(
      (await ask({ resource: "app-1" })).json(),
    );
    expect(one).toMatchObject({ value: 10, previousValue: 4, delta: 6 });
    expect(one.series.at(-1)?.value).toBe(10);
  });

  it("lists the connection's resources with names, named first", async () => {
    const response = await resourcesOf(
      owner,
      appsWorkspace,
      apps,
      "apps.downloads",
    );
    expect(response.statusCode).toBe(200);
    expect(metricResourcesResponseSchema.parse(response.json())).toEqual({
      resources: [
        { id: "app-2", name: "Dicey" },
        { id: "app-3", name: "Quiet" },
        { id: "app-1", name: "Wurfel" },
        { id: "app-9", name: null },
      ],
    });
  });

  it("lists no resources for a metric without them, and stays in its workspace", async () => {
    const none = await resourcesOf(owner, appsWorkspace, apps, "apps.crashes");
    expect(metricResourcesResponseSchema.parse(none.json())).toEqual({
      resources: [],
    });
    const foreign = await resourcesOf(
      stranger,
      appsWorkspace,
      apps,
      "apps.downloads",
    );
    // Not a member: the workspace does not exist for them.
    expect(foreign.statusCode).toBe(404);
    const elsewhere = await resourcesOf(
      stranger,
      otherWorkspaceId,
      apps,
      "apps.downloads",
    );
    expect(elsewhere.statusCode).toBe(404);
  });

  it("saves a tile only with a resource of its connection", async () => {
    for (const resource of ["nope", "other-app"]) {
      const response = await createDashboard([tile({ resource })]);
      expect(response.statusCode).toBe(400);
      expect(errorResponseSchema.parse(response.json()).error).toBe(
        "unknown_resource",
      );
    }
  });

  it("names the resource of saved tiles and keeps tiles of all resources", async () => {
    const saved = await createDashboard([
      tile({}),
      tile({ resource: "app-1" }),
      tile({ resource: "app-9" }),
      tile({ resource: "app-2" }, "Dice installs"),
    ]);
    expect(saved.statusCode).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(saved.json());
    const shape = (tiles: typeof dashboard.tiles) =>
      tiles.map(({ dimensions, title, resourceName }) => ({
        dimensions,
        title,
        resourceName,
      }));
    const expected = [
      { dimensions: {}, title: null, resourceName: null },
      {
        dimensions: { resource: "app-1" },
        title: null,
        resourceName: "Wurfel",
      },
      { dimensions: { resource: "app-9" }, title: null, resourceName: null },
      {
        dimensions: { resource: "app-2" },
        title: "Dice installs",
        resourceName: "Dicey",
      },
    ];
    expect(shape(dashboard.tiles)).toEqual(expected);

    const loaded = await call(
      "GET",
      `/v1/workspaces/${appsWorkspace}/dashboards/${dashboard.id}`,
      owner,
    );
    expect(
      shape(dashboardResponseSchema.parse(loaded.json()).dashboard.tiles),
    ).toEqual(expected);

    // Screens: the resource's name in the label, its own numbers.
    const device = await withWorkspace(
      db,
      { workspaceId: appsWorkspace },
      (tx) =>
        buildDeviceDashboard(tx, appsWorkspace, dashboard.id, { now: NOW }),
    );
    expect(
      device.tiles.map(({ label, value, change }) => ({
        label,
        value,
        previousValue: change.previousValue,
      })),
    ).toEqual([
      { label: "Downloads", value: 16, previousValue: 10 },
      { label: "Downloads · Wurfel", value: 10, previousValue: 4 },
      { label: "Downloads · app-9", value: 1, previousValue: null },
      { label: "Dice installs", value: 5, previousValue: 6 },
    ]);
  });
});
