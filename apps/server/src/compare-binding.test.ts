import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceResponseSchema } from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { addDays, type Period } from "@netrics/domain";

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
let owner: string;
let workspaceId: string;

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

/** Daily values over two years, so every period has a previous window. */
async function observe(
  connection: string,
  metricKey: string,
  dimensions: Record<string, string>,
  value: (day: number) => number | null,
) {
  const rows: Array<{ dimensions: string; at: string; value: number }> = [];
  for (let day = 0; day < 800; day++) {
    const v = value(day);
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
        numerator:
          i % 3 === 0
            ? { metricKey: "cmb.signups" }
            : i % 3 === 1
              ? {
                  metricKey: "cmb.proceeds",
                  aggregation: "avg",
                  dimensions: { currency: "EUR" },
                }
              : { metricKey: "cmb.visits", dimensions: { resource: "app-2" } },
        denominator:
          i % 3 === 2
            ? { metricKey: "cmb.visits", connectionId: BLOG }
            : { metricKey: "cmb.visits", aggregation: i % 2 ? "avg" : "sum" },
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
