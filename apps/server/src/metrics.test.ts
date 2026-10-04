import type { FastifyInstance, InjectOptions } from "fastify";
import { sql } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  currencyConversionOptionsResponseSchema,
  dashboardResponseSchema,
  errorResponseSchema,
  metricBreakdownResponseSchema,
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
import { queryMetric, queryMetricBreakdown } from "./metrics/query.js";
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

  it("without a currency shows the largest one exactly, never a sum", async () => {
    // The workspace has no display currency (the default): per currency.
    const largest = metricQueryResponseSchema.parse((await ask()).json());
    expect(largest).toMatchObject({
      currency: "EUR",
      conversion: null,
      value: 1_334,
      previousValue: 1_000,
    });
    const app1 = metricQueryResponseSchema.parse(
      (await ask({ app: "app-1" })).json(),
    );
    expect(app1).toMatchObject({ currency: "EUR", value: 1_234 });
    const invalid = await ask({ currency: "euro" });
    expect(invalid.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalid.json()).error).toBe(
      "currency_required",
    );
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

  it("saves tiles with a currency or following the workspace, and shows them on screens", async () => {
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
    const invalid = await create({ currency: "yen" });
    expect(invalid.statusCode).toBe(400);
    expect(errorResponseSchema.parse(invalid.json()).error).toBe(
      "currency_required",
    );
    // Without a currency the tile follows the workspace: per currency, the
    // largest one today.
    const following = await create({ app: "app-1" });
    expect(following.statusCode).toBe(200);
    const followingTiles = await withWorkspace(
      db,
      { workspaceId: storeWorkspace },
      (tx) =>
        buildDeviceDashboard(
          tx,
          storeWorkspace,
          dashboardResponseSchema.parse(following.json()).dashboard.id,
          { now: NOW, exchangeRates: true },
        ),
    );
    expect(followingTiles.tiles[0]).toMatchObject({
      value: 1_234,
      unit: "EUR_minor",
      conversion: null,
    });

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

  describe("display currency with ECB reference rates (#191)", () => {
    // Its own workspace and connection of the same metric, with rates
    // published on some days only. NOW is Tuesday 2025-07-15; last 7 days
    // are 07-09..07-15, the previous ones 07-02..07-08.
    let fxWorkspace: string;
    let fx: string;
    let offApp: FastifyInstance;

    async function amount(date: string, value: number, currency: string) {
      await admin`
        insert into observations (workspace_id, connection_id,
          metric_definition_id, dimensions, source_timestamp, value)
        select ${fxWorkspace}, ${fx}, m.id,
               ${admin.json({ app: "app-1", currency })},
               ${`${date}T00:00:00Z`}::timestamptz, ${value}
        from metric_definitions m
        where m.connector_id = 'test-store' and m.key = 'store.proceeds'`;
    }

    const askFx = (
      body: Record<string, unknown> = {},
      target: FastifyInstance = app,
    ) =>
      target.inject({
        method: "POST",
        url: `/v1/workspaces/${fxWorkspace}/metrics/query`,
        headers: { cookie: owner },
        payload: {
          connectionId: fx,
          metricKey: "store.proceeds",
          period: "last_7_days",
          ...body,
        },
      });

    const setDisplayCurrency = (
      displayCurrency: string | null,
      target: FastifyInstance = app,
    ) =>
      target.inject({
        method: "PATCH",
        url: `/v1/workspaces/${fxWorkspace}`,
        headers: { cookie: owner },
        payload: { displayCurrency },
      });

    beforeAll(async () => {
      fxWorkspace = (await createWorkspace(owner)).id;
      const [row] = await admin`
        insert into connections (workspace_id, connector_id, name)
        values (${fxWorkspace}, 'test-store', 'Store') returning id`;
      fx = row!.id as string;
      // Units per euro: USD 2 on Friday 07-04, 1.25 on Monday 07-14; JPY
      // 100 on 07-14. Nothing yet for today, 07-15.
      await admin`
        insert into exchange_rates (rate_date, currency, units_per_eur)
        values ('2025-07-04', 'USD', '2'), ('2025-07-14', 'USD', '1.25'),
               ('2025-07-14', 'JPY', '100')`;
      // Today: €13.34, $5.00, ¥900 and NT$30.00 (no ECB rate); yesterday
      // ¥100. Previous period: €10.00 on 07-08, $10.00 on Saturday 07-05.
      await amount(today, 1_334, "EUR");
      await amount(today, 500, "USD");
      await amount(today, 900, "JPY");
      await amount(today, 3_000, "TWD");
      await amount(addDays(today, -1), 100, "JPY");
      await amount(addDays(today, -7), 1_000, "EUR");
      await amount("2025-07-05", 1_000, "USD");

      const offConfig = loadConfig({
        DATABASE_URL: "postgres://unused@localhost/unused",
        LOG_LEVEL: "silent",
        BETTER_AUTH_URL: "http://localhost:3001",
        WEB_ORIGIN: "http://localhost:3000",
        NETRICS_EXCHANGE_RATES: "off",
      });
      offApp = await buildApp(offConfig, {
        db,
        authService: createAuthService(offConfig, db, {
          logger: pino({ level: "silent" }),
        }),
        checkDb: async () => true,
        now: () => NOW,
      });
    });

    afterAll(async () => {
      await offApp.close();
    });

    it("lists EUR and the currencies with recent rates", async () => {
      const response = await call(
        "GET",
        `/v1/workspaces/${fxWorkspace}/currency-conversion`,
        owner,
      );
      expect(
        currencyConversionOptionsResponseSchema.parse(response.json()),
      ).toMatchObject({
        enabled: true,
        currencies: ["EUR", "JPY", "USD"],
        latestRateDate: "2025-07-14",
      });
      const off = await offApp.inject({
        method: "GET",
        url: `/v1/workspaces/${fxWorkspace}/currency-conversion`,
        headers: { cookie: owner },
      });
      expect(
        currencyConversionOptionsResponseSchema.parse(off.json()),
      ).toMatchObject({ enabled: false, currencies: [] });
    });

    it("is per currency by default", async () => {
      const workspace = await call(
        "GET",
        `/v1/workspaces/${fxWorkspace}`,
        owner,
      );
      expect(
        workspaceResponseSchema.parse(workspace.json()).workspace
          .displayCurrency,
      ).toBeNull();
      // The largest currency, exactly. With rates, "largest" compares
      // values in EUR: €13.34 beats ¥1000 (€10), $5.00 (€4) and NT$30.00,
      // which has no rate (raw minor units would pick TWD's 3000).
      expect(
        metricQueryResponseSchema.parse((await askFx()).json()),
      ).toMatchObject({ currency: "EUR", value: 1_334, conversion: null });
    });

    it("ranks currencies by their value in EUR when rates exist", async () => {
      const list = (target: FastifyInstance) =>
        target.inject({
          method: "POST",
          url: `/v1/workspaces/${fxWorkspace}/metrics/currencies`,
          headers: { cookie: owner },
          payload: {
            connectionId: fx,
            metricKey: "store.proceeds",
            period: "last_7_days",
          },
        });
      const ranked = metricCurrenciesResponseSchema.parse(
        (await list(app)).json(),
      );
      // Totals stay in their own minor units; only the order changes.
      expect(ranked.currencies).toEqual([
        { currency: "EUR", total: 1_334 },
        { currency: "JPY", total: 1_000 },
        { currency: "USD", total: 500 },
        { currency: "TWD", total: 3_000 },
      ]);
      // Without rates, by minor units as before.
      const raw = metricCurrenciesResponseSchema.parse(
        (await list(offApp)).json(),
      );
      expect(raw.currencies.map((entry) => entry.currency)).toEqual([
        "TWD",
        "EUR",
        "JPY",
        "USD",
      ]);
    });

    it("sets the workspace's display currency to EUR or a covered one", async () => {
      const uncovered = await setDisplayCurrency("TWD");
      expect(uncovered.statusCode).toBe(400);
      expect(errorResponseSchema.parse(uncovered.json()).error).toBe(
        "currency_not_covered",
      );
      const off = await setDisplayCurrency("EUR", offApp);
      expect(off.statusCode).toBe(400);
      expect(errorResponseSchema.parse(off.json()).error).toBe(
        "currency_conversion_off",
      );
      const eur = await setDisplayCurrency("EUR");
      expect(eur.statusCode).toBe(200);
      expect(
        workspaceResponseSchema.parse(eur.json()).workspace.displayCurrency,
      ).toBe("EUR");
      const [audit] = await admin`
        select metadata from audit_events
        where workspace_id = ${fxWorkspace}
          and action = 'workspace.display_currency_changed'`;
      expect(audit?.metadata).toEqual({
        oldDisplayCurrency: null,
        newDisplayCurrency: "EUR",
      });
    });

    it("converts each day at its rate and keeps uncovered currencies apart", async () => {
      const result = metricQueryResponseSchema.parse((await askFx()).json());
      // Today at Monday's rates (none yet for today): €13.34 + $5.00 / 1.25
      // + ¥900 / 100 = €26.34; yesterday ¥100 / 100 = €1.00. Previous
      // period: €10.00, and Saturday's $10.00 at Friday's rate 2 = €5.00.
      expect(result).toMatchObject({
        currency: "EUR",
        value: 2_734,
        previousValue: 1_500,
        delta: 1_234,
        conversion: {
          displayCurrency: "EUR",
          approximate: true,
          unconverted: [{ currency: "TWD", value: 3_000, previousValue: null }],
        },
      });
      expect(result.conversion?.source.url).toContain("ecb.europa.eu");
      expect(result.series.at(-1)?.value).toBe(2_634);
      expect(result.series.at(-2)?.value).toBe(100);
      // One currency stays exact, whatever the workspace converts into.
      expect(
        metricQueryResponseSchema.parse(
          (await askFx({ dimensions: { currency: "USD" } })).json(),
        ),
      ).toMatchObject({ currency: "USD", value: 500, conversion: null });
    });

    it("converts into a tile's own display currency", async () => {
      // In USD at 1.25 per euro: €13.34 → $16.675, ¥900 → $11.25, plus
      // $5.00 = $32.925 → 3293 cents today; ¥100 → $1.25 yesterday.
      const result = metricQueryResponseSchema.parse(
        (await askFx({ displayCurrency: "USD" })).json(),
      );
      expect(result).toMatchObject({ currency: "USD", value: 3_418 });
      expect(result.series.at(-1)?.value).toBe(3_293);
    });

    it("converts per day before rolling days into months (#212)", async () => {
      // July holds $10.00 on 07-05 at Friday's rate 2 (€5.00) and $5.00
      // today at Monday's 1.25 (€4.00): €9.00, where one rate for the
      // month's $15.00 would say €7.50 or €12.00.
      const result = metricQueryResponseSchema.parse(
        (
          await askFx({
            period: "last_12_months",
            displayCurrency: "EUR",
            dimensions: {},
          })
        ).json(),
      );
      expect(result.series).toHaveLength(12);
      expect(result.series[0]?.bucket).toBe("2024-08-01T00:00:00.000Z");
      // €26.34 today, €1.00 yesterday, €10.00 on 07-08, €5.00 on 07-05.
      expect(result.series.at(-1)).toEqual({
        bucket: "2025-07-01T00:00:00.000Z",
        value: 4_234,
      });
      expect(result).toMatchObject({
        currency: "EUR",
        value: 4_234,
        previousValue: null,
        conversion: {
          unconverted: [{ currency: "TWD", value: 3_000, previousValue: null }],
        },
      });
      const usd = metricQueryResponseSchema.parse(
        (
          await askFx({
            period: "last_90_days",
            displayCurrency: "EUR",
            dimensions: { currency: "USD" },
          })
        ).json(),
      );
      // One currency stays exact; weeks start Monday 07-14 and 06-30.
      expect(usd).toMatchObject({ currency: "USD", value: 1_500 });
      expect(usd.series.at(-1)).toEqual({
        bucket: "2025-07-14T00:00:00.000Z",
        value: 500,
      });
      expect(usd.series.at(-3)).toEqual({
        bucket: "2025-06-30T00:00:00.000Z",
        value: 1_000,
      });
    });

    it("does not convert when the instance fetches no rates", async () => {
      const result = metricQueryResponseSchema.parse(
        (await askFx({}, offApp)).json(),
      );
      expect(result).toMatchObject({
        currency: "TWD",
        value: 3_000,
        conversion: null,
      });
    });

    it("saves tiles that convert, and labels them on screens", async () => {
      const create = (tile: Record<string, unknown>) =>
        call("POST", `/v1/workspaces/${fxWorkspace}/dashboards`, owner, {
          name: "Proceeds",
          tiles: [
            {
              connectionId: fx,
              metricKey: "store.proceeds",
              period: "last_7_days",
              ...tile,
            },
          ],
        });
      const conflict = await create({
        dimensions: { currency: "USD" },
        displayCurrency: "EUR",
      });
      expect(conflict.statusCode).toBe(400);
      expect(errorResponseSchema.parse(conflict.json()).error).toBe(
        "currency_choice_conflict",
      );

      const following = dashboardResponseSchema.parse(
        (await create({})).json(),
      ).dashboard;
      const inUsd = dashboardResponseSchema.parse(
        (await create({ displayCurrency: "USD" })).json(),
      ).dashboard;
      expect(inUsd.tiles[0]?.displayCurrency).toBe("USD");

      const screen = (dashboardId: string, exchangeRates: boolean) =>
        withWorkspace(db, { workspaceId: fxWorkspace }, (tx) =>
          buildDeviceDashboard(tx, fxWorkspace, dashboardId, {
            now: NOW,
            exchangeRates,
          }),
        );
      const eurTile = (await screen(following.id, true)).tiles[0];
      expect(eurTile).toMatchObject({
        value: 2_734,
        unit: "EUR_minor",
        // The title stays readable; the conversion is its own field.
        label: "Proceeds",
        conversion: {
          displayCurrency: "EUR",
          unconverted: [{ currency: "TWD", value: 3_000 }],
        },
      });
      expect((await screen(inUsd.id, true)).tiles[0]).toMatchObject({
        value: 3_418,
        unit: "USD_minor",
      });
      // Rates off: the same tile shows the largest currency, exactly.
      expect((await screen(following.id, false)).tiles[0]).toMatchObject({
        value: 3_000,
        unit: "TWD_minor",
        label: "Proceeds",
        conversion: null,
      });
    });

    it("goes back to amounts per currency", async () => {
      const reset = await setDisplayCurrency(null);
      expect(
        workspaceResponseSchema.parse(reset.json()).workspace.displayCurrency,
      ).toBeNull();
      expect(
        metricQueryResponseSchema.parse((await askFx()).json()),
      ).toMatchObject({ currency: "EUR", value: 1_334, conversion: null });
    });
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

  const tile = (
    dimensions: Record<string, string>,
    title?: string,
    connectionId = apps,
    metricKey = "apps.downloads",
  ) => ({
    connectionId,
    metricKey,
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
      values ('test-apps', '1.0.0', ${admin.json({
        id: "test-apps",
        resourceNoun: { singular: "app", plural: "apps" },
      })})`;
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
      resourceNoun: { singular: "app", plural: "apps" },
    });
  });

  it("lists no resources for a metric without them, and stays in its workspace", async () => {
    const none = await resourcesOf(owner, appsWorkspace, apps, "apps.crashes");
    expect(metricResourcesResponseSchema.parse(none.json())).toEqual({
      resources: [],
      resourceNoun: { singular: "app", plural: "apps" },
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
      // All apps under a title of its own; one app in all; no apps at all.
      tile({}, "Installs"),
      tile({}, undefined, otherApps),
      tile({}, undefined, apps, "apps.crashes"),
    ]);
    expect(saved.statusCode).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(saved.json());
    const shape = (tiles: typeof dashboard.tiles) =>
      tiles.map(({ dimensions, title, resourceName, allResourcesName }) => ({
        dimensions,
        title,
        resourceName,
        allResourcesName,
      }));
    const none = { resourceName: null, allResourcesName: null };
    const expected = [
      // Several apps added up name their scope (#208).
      {
        dimensions: {},
        title: null,
        resourceName: null,
        allResourcesName: "All apps",
      },
      {
        dimensions: { resource: "app-1" },
        title: null,
        resourceName: "Wurfel",
        allResourcesName: null,
      },
      { dimensions: { resource: "app-9" }, title: null, ...none },
      {
        dimensions: { resource: "app-2" },
        title: "Dice installs",
        resourceName: "Dicey",
        allResourcesName: null,
      },
      {
        dimensions: {},
        title: "Installs",
        resourceName: null,
        allResourcesName: "All apps",
      },
      // One app is the same as all of them; a metric without apps.
      { dimensions: {}, title: null, ...none },
      { dimensions: {}, title: null, ...none },
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

    // Screens: the resource's name (or their scope) in the label, its own
    // numbers.
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
      { label: "Downloads · All apps", value: 16, previousValue: 10 },
      { label: "Downloads · Wurfel", value: 10, previousValue: 4 },
      { label: "Downloads · app-9", value: 1, previousValue: null },
      { label: "Dice installs", value: 5, previousValue: 6 },
      { label: "Installs", value: 16, previousValue: 10 },
      { label: "Downloads", value: 100, previousValue: null },
      { label: "Crashes", value: null, previousValue: null },
    ]);
  });
});

describe("longer periods (#212)", () => {
  // Its own Berlin workspace. Monday 2026-09-28: the last 90 days are
  // 07-01 (a Wednesday)..09-28 against 04-02..06-30; the last 12 months
  // 2025-10-01..2026-09-28 against 2024-10-01..2025-09-28.
  const now = new Date("2026-09-28T12:00:00Z");
  let longWorkspace: string;
  let long: string;
  const run = (
    period: "last_90_days" | "last_12_months",
    aggregation: "sum" | "avg" | "last" = "sum",
    metricKey = "demo.signups",
  ) =>
    withWorkspace(db, { workspaceId: longWorkspace }, (tx) =>
      queryMetric(
        tx,
        longWorkspace,
        { connectionId: long, metricKey, period, aggregation },
        now,
      ),
    );

  beforeAll(async () => {
    longWorkspace = (await createWorkspace(owner, BERLIN)).id;
    long = await createConnection(longWorkspace);
    for (const [date, value] of [
      ["2024-09-30", 1_000],
      ["2025-09-28", 50],
      ["2025-10-01", 100],
      ["2026-04-01", 1_000],
      ["2026-04-02", 2],
      ["2026-06-30", 5],
      ["2026-07-01", 3],
      ["2026-07-05", 1],
      ["2026-07-06", 10],
      ["2026-07-12", 20],
      ["2026-09-28", 7],
    ] as const) {
      await observe(longWorkspace, long, "demo.signups", date, value);
      // The same numbers as a daily gauge, which may be averaged.
      await observe(longWorkspace, long, "demo.visitors", date, value);
    }
  });

  it("sums 90 days, compares with the 90 before and draws weeks", async () => {
    const result = await run("last_90_days");
    expect(result).toMatchObject({
      ok: true,
      value: { value: 41, previousValue: 7, delta: 34 },
    });
    const series = result.ok ? result.value.series : [];
    expect(series).toHaveLength(14);
    expect(series.slice(0, 3)).toEqual([
      { bucket: "2026-07-01T00:00:00.000Z", value: 4 },
      { bucket: "2026-07-06T00:00:00.000Z", value: 30 },
      { bucket: "2026-07-13T00:00:00.000Z", value: null },
    ]);
    expect(series.at(-1)).toEqual({
      bucket: "2026-09-28T00:00:00.000Z",
      value: 7,
    });
  });

  it("averages days, not weeks, and reads the latest day", async () => {
    // Five days with data: 41 / 5; averaging the weeks' totals would say
    // 41 / 3. A week's point is its average day.
    const result = await run("last_90_days", "avg", "demo.visitors");
    expect(result).toMatchObject({
      ok: true,
      value: { value: 8.2, previousValue: 3.5 },
    });
    expect(result.ok && result.value.series[1]?.value).toBe(15);
    const latest = await run("last_12_months", "last", "demo.visitors");
    expect(latest).toMatchObject({
      ok: true,
      value: { value: 7, previousValue: 50 },
    });
    expect(latest.ok && latest.value.series[6]?.value).toBe(2);
  });

  it("sums 12 months, compares with the 12 before up to the same day and draws months", async () => {
    const result = await run("last_12_months");
    expect(result).toMatchObject({
      ok: true,
      value: { value: 1_148, previousValue: 50 },
    });
    expect(
      result.ok &&
        result.value.series.map((point) => [
          point.bucket.slice(0, 7),
          point.value,
        ]),
    ).toEqual([
      ["2025-10", 100],
      ["2025-11", null],
      ["2025-12", null],
      ["2026-01", null],
      ["2026-02", null],
      ["2026-03", null],
      ["2026-04", 1_002],
      ["2026-05", null],
      ["2026-06", 5],
      ["2026-07", 34],
      ["2026-08", null],
      ["2026-09", 7],
    ]);
  });

  it("saves tiles of the longer periods and shows them on screens", async () => {
    const response = await call(
      "POST",
      `/v1/workspaces/${longWorkspace}/dashboards`,
      owner,
      {
        name: "Long",
        tiles: [
          {
            connectionId: long,
            metricKey: "demo.signups",
            period: "last_90_days",
          },
          {
            connectionId: long,
            metricKey: "demo.signups",
            period: "last_12_months",
          },
        ],
      },
    );
    expect(response.statusCode).toBe(200);
    const { dashboard } = dashboardResponseSchema.parse(response.json());
    expect(dashboard.tiles.map((tile) => tile.period)).toEqual([
      "last_90_days",
      "last_12_months",
    ]);
    const device = await withWorkspace(
      db,
      { workspaceId: longWorkspace },
      (tx) => buildDeviceDashboard(tx, longWorkspace, dashboard.id, { now }),
    );
    expect(
      device.tiles.map((tile) => [tile.period, tile.value, tile.spark.length]),
    ).toEqual([
      ["last_90_days", 41, 14],
      ["last_12_months", 1_148, 12],
    ]);
    // Over HTTP too, the period passes the contract.
    const http = await query(owner, longWorkspace, {
      connectionId: long,
      metricKey: "demo.signups",
      period: "last_12_months",
    });
    expect(http.statusCode).toBe(200);
    expect(metricQueryResponseSchema.parse(http.json()).period).toBe(
      "last_12_months",
    );
  });
});

describe("chart queries (#218)", () => {
  // Its own UTC workspace and connector. NOW is Tuesday 2025-07-15: the
  // last 7 days are 07-09..07-15, the previous ones 07-02..07-08.
  let chartWorkspace: string;
  let chart: string;
  const today = civilDate(NOW, "UTC");

  async function put(
    metricKey: string,
    date: string,
    value: number,
    dimensions: Record<string, string>,
    workspace = chartWorkspace,
    connection = chart,
  ) {
    await admin`
      insert into observations (workspace_id, connection_id,
        metric_definition_id, dimensions, source_timestamp, value)
      select ${workspace}, ${connection}, m.id, ${admin.json(dimensions)},
             ${`${date}T00:00:00Z`}::timestamptz, ${value}
      from metric_definitions m
      where m.connector_id = 'test-chart' and m.key = ${metricKey}`;
  }

  const breakdown = (
    body: Record<string, unknown>,
    cookie: string = owner,
    workspace: string = chartWorkspace,
  ) =>
    call("POST", `/v1/workspaces/${workspace}/metrics/breakdown`, cookie, {
      connectionId: chart,
      period: "last_7_days",
      ...body,
    });

  const errorOf = (response: InjectResponse) =>
    errorResponseSchema.parse(response.json()).error;

  beforeAll(async () => {
    chartWorkspace = (await createWorkspace(owner)).id;
    await admin`
      insert into connectors (id, version, manifest)
      values ('test-chart', '1.0.0', '{"id":"test-chart"}'::jsonb)`;
    await admin`
      insert into metric_definitions (connector_id, key, name, description,
        kind, unit, granularity, dimensions, aggregations)
      values
        ('test-chart', 'chart.downloads', 'Downloads', 'Downloads per day',
         'delta', 'count', 'day', '["resource","territory"]', '["sum","avg"]'),
        ('test-chart', 'chart.users', 'Users', 'Active users',
         'gauge', 'count', 'day', '["resource","device"]',
         '["last","avg","min","max"]'),
        ('test-chart', 'chart.proceeds', 'Proceeds', 'Proceeds per day',
         'delta', 'currency_minor', 'day', '["resource","currency"]', '["sum"]')`;
    const [row] = await admin`
      insert into connections (workspace_id, connector_id, name)
      values (${chartWorkspace}, 'test-chart', 'Store') returning id`;
    chart = row!.id as string;
    await admin`
      insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values
        (${chart}, ${chartWorkspace}, 'app-1', 'Wurfel', 'app'),
        (${chart}, ${chartWorkspace}, 'app-2', 'Dicey', 'app'),
        (${chart}, ${chartWorkspace}, 'app-3', 'Quiet', 'app')`;

    // Downloads this week per app and territory: app-1 40 (DE 30, US 10),
    // app-2 25 (DE), app-3 12, app-4 8, app-5 3 (no names for 4 and 5),
    // and App Store's own "Others" territory 5 on app-1. The week before:
    // 07-02 6, 07-08 9; nothing on the days between.
    await put("chart.downloads", today, 30, {
      resource: "app-1",
      territory: "DE",
    });
    await put("chart.downloads", addDays(today, -1), 10, {
      resource: "app-1",
      territory: "US",
    });
    await put("chart.downloads", addDays(today, -2), 5, {
      resource: "app-1",
      territory: "Others",
    });
    await put("chart.downloads", today, 25, {
      resource: "app-2",
      territory: "DE",
    });
    await put("chart.downloads", today, 12, {
      resource: "app-3",
      territory: "FR",
    });
    await put("chart.downloads", today, 8, {
      resource: "app-4",
      territory: "FR",
    });
    await put("chart.downloads", today, 3, {
      resource: "app-5",
      territory: "JP",
    });
    await put("chart.downloads", "2025-07-02", 6, {
      resource: "app-1",
      territory: "DE",
    });
    await put("chart.downloads", "2025-07-08", 9, {
      resource: "app-2",
      territory: "DE",
    });

    // Active users per device: the latest day counts per group.
    await put("chart.users", addDays(today, -1), 100, {
      resource: "app-1",
      device: "iPhone",
    });
    await put("chart.users", today, 70, {
      resource: "app-1",
      device: "iPhone",
    });
    await put("chart.users", today, 80, { resource: "app-1", device: "iPad" });
    await put("chart.users", addDays(today, -1), 50, {
      resource: "app-1",
      device: "Mac",
    });

    // Proceeds: app-1 €10.00 + £1.00, app-2 €3.00 on 07-10. £1 per €0.5
    // that day, so £1.00 is €2.00.
    await put("chart.proceeds", "2025-07-10", 1_000, {
      resource: "app-1",
      currency: "EUR",
    });
    await put("chart.proceeds", "2025-07-10", 100, {
      resource: "app-1",
      currency: "GBP",
    });
    await put("chart.proceeds", "2025-07-10", 300, {
      resource: "app-2",
      currency: "EUR",
    });
    await admin`
      insert into exchange_rates (rate_date, currency, units_per_eur)
      values ('2025-07-10', 'GBP', '0.5')
      on conflict do nothing`;
  });

  describe("line: the previous period aligned (POST …/metrics/query)", () => {
    it("returns the previous window's points under the current ones", async () => {
      const response = await query(owner, chartWorkspace, {
        connectionId: chart,
        metricKey: "chart.downloads",
        period: "last_7_days",
      });
      expect(response.statusCode).toBe(200);
      const result = metricQueryResponseSchema.parse(response.json());
      expect(result.previousValue).toBe(15);
      expect(result.previousSeries.map((p) => p.bucket)).toEqual(
        result.series.map((p) => p.bucket),
      );
      // 07-02 sits under 07-09, 07-08 under 07-15; the days between are gaps.
      expect(result.previousSeries.map((p) => p.value)).toEqual([
        6,
        null,
        null,
        null,
        null,
        null,
        9,
      ]);
    });

    it("forms a gauge's previous points like its own", async () => {
      const response = await query(owner, chartWorkspace, {
        connectionId: chart,
        metricKey: "chart.users",
        period: "last_7_days",
      });
      const result = metricQueryResponseSchema.parse(response.json());
      expect(result.previousSeries.every((p) => p.value === null)).toBe(true);
      expect(result.series.at(-1)?.value).toBe(150);
    });

    it("converts the previous points like the current ones", async () => {
      const response = await query(owner, chartWorkspace, {
        connectionId: chart,
        metricKey: "chart.proceeds",
        period: "last_7_days",
        displayCurrency: "EUR",
      });
      const result = metricQueryResponseSchema.parse(response.json());
      expect(result.currency).toBe("EUR");
      expect(result.series[1]?.value).toBe(1_500);
      expect(result.previousSeries).toHaveLength(7);
    });
  });

  describe("bar: POST …/metrics/breakdown", () => {
    it("ranks resources by name, largest first, the rest as Others", async () => {
      const response = await breakdown({
        metricKey: "chart.downloads",
        groupBy: "resource",
        limit: 3,
      });
      expect(response.statusCode).toBe(200);
      expect(
        metricBreakdownResponseSchema.parse(response.json()),
      ).toMatchObject({
        aggregation: "sum",
        groupBy: "resource",
        currency: null,
        conversion: null,
        groups: [
          { key: "app-1", label: "Wurfel", value: 45 },
          { key: "app-2", label: "Dicey", value: 25 },
          { key: "app-3", label: "Quiet", value: 12 },
        ],
        others: { label: "Others", value: 11, groups: 2 },
      });
    });

    it("shows every group within the limit and no Others", async () => {
      const response = await breakdown({
        metricKey: "chart.downloads",
        groupBy: "resource",
      });
      const result = metricBreakdownResponseSchema.parse(response.json());
      expect(result.groups.map((g) => g.label)).toEqual([
        "Wurfel",
        "Dicey",
        "Quiet",
        "app-4",
        "app-5",
      ]);
      expect(result.others).toBeNull();
    });

    it("names territories and adds the connector's Others to its own", async () => {
      const response = await breakdown({
        metricKey: "chart.downloads",
        groupBy: "territory",
        limit: 3,
      });
      const result = metricBreakdownResponseSchema.parse(response.json());
      expect(result.groups).toEqual([
        { key: "DE", label: "Germany", value: 55 },
        { key: "FR", label: "France", value: 20 },
        { key: "US", label: "United States", value: 10 },
      ]);
      expect(result.others).toEqual({ label: "Others", value: 8, groups: 2 });
    });

    it("labels Others and territories in a screen's language", async () => {
      const result = await withWorkspace(
        db,
        { workspaceId: chartWorkspace },
        (tx) =>
          queryMetricBreakdown(
            tx,
            chartWorkspace,
            {
              connectionId: chart,
              metricKey: "chart.downloads",
              period: "last_7_days",
              groupBy: "territory",
              limit: 3,
            },
            NOW,
            { locale: "de" },
          ),
      );
      expect(result.ok && result.value.groups.map((g) => g.label)).toEqual([
        "Deutschland",
        "Frankreich",
        "Vereinigte Staaten",
      ]);
      expect(result.ok && result.value.others?.label).toBe("Andere");
    });

    it("filters by other dimensions and aggregates like the tile", async () => {
      const filtered = metricBreakdownResponseSchema.parse(
        (
          await breakdown({
            metricKey: "chart.downloads",
            groupBy: "territory",
            dimensions: { resource: "app-1" },
          })
        ).json(),
      );
      expect(filtered.groups.map((g) => [g.key, g.value])).toEqual([
        ["DE", 30],
        ["US", 10],
      ]);
      expect(filtered.others).toMatchObject({ value: 5, groups: 1 });

      // An average day per territory: DE 55 on one day.
      const average = metricBreakdownResponseSchema.parse(
        (
          await breakdown({
            metricKey: "chart.downloads",
            groupBy: "territory",
            aggregation: "avg",
            limit: 3,
          })
        ).json(),
      );
      expect(average.groups[0]).toMatchObject({ key: "DE", value: 55 });
    });

    it("reads a gauge's latest day per group", async () => {
      const response = await breakdown({
        metricKey: "chart.users",
        groupBy: "device",
      });
      const result = metricBreakdownResponseSchema.parse(response.json());
      expect(result.aggregation).toBe("last");
      expect(result.groups).toEqual([
        { key: "iPad", label: "iPad", value: 80 },
        { key: "iPhone", label: "iPhone", value: 70 },
        { key: "Mac", label: "Mac", value: 50 },
      ]);
    });

    it("is empty without data in the period", async () => {
      const response = await breakdown({
        metricKey: "chart.downloads",
        groupBy: "resource",
        dimensions: { resource: "nope" },
      });
      expect(
        metricBreakdownResponseSchema.parse(response.json()),
      ).toMatchObject({
        groups: [],
        others: null,
      });
    });

    it("refuses unknown dimensions, the currency, and limits out of range", async () => {
      const unknown = await breakdown({
        metricKey: "chart.downloads",
        groupBy: "device",
      });
      expect(unknown.statusCode).toBe(400);
      expect(errorOf(unknown)).toBe("unknown_dimension");
      const currency = await breakdown({
        metricKey: "chart.proceeds",
        groupBy: "currency",
      });
      expect(currency.statusCode).toBe(400);
      expect(errorOf(currency)).toBe("unknown_dimension");
      for (const limit of [2, 11]) {
        const response = await breakdown({
          metricKey: "chart.downloads",
          groupBy: "resource",
          limit,
        });
        expect(response.statusCode).toBe(400);
        expect(errorOf(response)).toBe("invalid_request");
      }
      const aggregation = await breakdown({
        metricKey: "chart.downloads",
        groupBy: "resource",
        aggregation: "last",
      });
      expect(errorOf(aggregation)).toBe("aggregation_not_supported");
    });

    it("refuses amounts in several currencies with nothing to convert them", async () => {
      const response = await breakdown({
        metricKey: "chart.proceeds",
        groupBy: "resource",
      });
      expect(response.statusCode).toBe(400);
      expect(errorOf(response)).toBe("currency_required");
    });

    it("shows one currency exactly", async () => {
      const response = await breakdown({
        metricKey: "chart.proceeds",
        groupBy: "resource",
        dimensions: { currency: "EUR" },
      });
      expect(
        metricBreakdownResponseSchema.parse(response.json()),
      ).toMatchObject({
        currency: "EUR",
        conversion: null,
        groups: [
          { key: "app-1", value: 1_000 },
          { key: "app-2", value: 300 },
        ],
      });
    });

    it("converts each group into the display currency", async () => {
      const response = await breakdown({
        metricKey: "chart.proceeds",
        groupBy: "resource",
        displayCurrency: "EUR",
      });
      const result = metricBreakdownResponseSchema.parse(response.json());
      expect(result).toMatchObject({
        currency: "EUR",
        conversion: {
          displayCurrency: "EUR",
          approximate: true,
          unconverted: [],
        },
        groups: [
          { key: "app-1", label: "Wurfel", value: 1_200 },
          { key: "app-2", label: "Dicey", value: 300 },
        ],
      });
    });

    it("stays in its workspace", async () => {
      // Not a member.
      const stranger404 = await breakdown(
        { metricKey: "chart.downloads", groupBy: "resource" },
        stranger,
      );
      expect(stranger404.statusCode).toBe(404);
      // Another workspace's connection is not found from this one.
      const other = await call(
        "POST",
        `/v1/workspaces/${otherWorkspaceId}/metrics/breakdown`,
        stranger,
        {
          connectionId: chart,
          metricKey: "chart.downloads",
          period: "last_7_days",
          groupBy: "resource",
        },
      );
      expect(other.statusCode).toBe(404);
      expect(errorOf(other)).toBe("metric_not_found");
      // Each workspace's bars hold only its own data.
      const [row] = await admin`
        insert into connections (workspace_id, connector_id, name)
        values (${otherWorkspaceId}, 'test-chart', 'Theirs') returning id`;
      const theirs = row!.id as string;
      await put(
        "chart.downloads",
        today,
        1_000,
        { resource: "app-1", territory: "DE" },
        otherWorkspaceId,
        theirs,
      );
      const own = metricBreakdownResponseSchema.parse(
        (
          await breakdown({ metricKey: "chart.downloads", groupBy: "resource" })
        ).json(),
      );
      expect(own.groups[0]).toMatchObject({
        key: "app-1",
        label: "Wurfel",
        value: 45,
      });
      const theirBars = metricBreakdownResponseSchema.parse(
        (
          await call(
            "POST",
            `/v1/workspaces/${otherWorkspaceId}/metrics/breakdown`,
            stranger,
            {
              connectionId: theirs,
              metricKey: "chart.downloads",
              period: "last_7_days",
              groupBy: "resource",
            },
          )
        ).json(),
      );
      // No name: this workspace's resource names stay here.
      expect(theirBars.groups).toEqual([
        { key: "app-1", label: "app-1", value: 1_000 },
      ]);
      expect(theirBars.others).toBeNull();
    });

    it("runs under a time budget and restores the transaction's timeout", async () => {
      const setting = await withWorkspace(
        db,
        { workspaceId: chartWorkspace },
        async (tx) => {
          await tx.execute(sql`set local statement_timeout = '42s'`);
          const result = await queryMetricBreakdown(
            tx,
            chartWorkspace,
            {
              connectionId: chart,
              metricKey: "chart.downloads",
              period: "last_7_days",
              groupBy: "resource",
              limit: 5,
            },
            NOW,
          );
          expect(result.ok).toBe(true);
          const [row] = await tx.execute(
            sql`select current_setting('statement_timeout') as value`,
          );
          return row?.value;
        },
      );
      expect(setting).toBe("42s");
    });

    it("requires a session", async () => {
      const response = await breakdown(
        { metricKey: "chart.downloads", groupBy: "resource" },
        null as unknown as string,
      );
      expect(response.statusCode).toBe(401);
    });
  });
});
