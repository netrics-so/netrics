import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deviceDashboardV2ResponseSchema,
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
