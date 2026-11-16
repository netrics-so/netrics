import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionDetailResponseSchema,
  goalReadResponseSchema,
  metricBreakdownResponseSchema,
  metricQueryResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  createAppStoreConnectConnector,
  createDemoConnector,
} from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Freshness in the signed-in live queries (#727, ADR 0025 sections 6 and
// 7): the metric query (metric, line, compare), the breakdown (bar,
// table) and a gauge's goal resolve it as the device payload does, from
// the widget's resource (its filter or the slide scope) else every
// selected app; a provider overdue by a day is `stale`. The connection's
// page lists the selected apps' rows only. Without rows the responses stay
// as they were.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const NOW = new Date("2026-11-16T12:00:00Z");
const MINUTE = 60_000,
  HOUR = 60 * MINUTE;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const DOWNLOADS = "app_store_connect.downloads";
const IMPRESSIONS = "app_store_connect.impressions";

/** App Store Connect as it ships (sales and analytics streams) and demo. */
const registry = new ConnectorRegistry();
registry.register(createAppStoreConnectConnector());
registry.register(createDemoConnector());

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let cookie: string;
let workspaceId: string;
let apps: string;
let overdue: string;
let quiet: string;
let demo: string;

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

async function connection(
  connector: string,
  name: string,
  config: Record<string, unknown> = {},
): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name, config)
    values (${workspaceId}, ${connector}, ${name}, ${admin.json(config as never)})
    returning id`;
  const id = row!.id as string;
  await admin`
    insert into connection_state (connection_id, workspace_id,
      last_success_at, poll_interval_seconds, next_due_at)
    values (${id}, ${workspaceId}, ${at(-5 * MINUTE)}, 21600, ${at(2 * HOUR)})`;
  for (const resource of ["app-1", "app-2", "app-9"]) {
    await admin`
      insert into connection_resources (connection_id, workspace_id,
        resource_id, name, kind)
      values (${id}, ${workspaceId}, ${resource}, ${resource}, 'app')`;
    await admin`
      insert into observations (workspace_id, connection_id,
        metric_definition_id, dimensions, source_timestamp, value)
      select ${workspaceId}, ${id}, m.id, ${admin.json({ resource })},
             '2026-11-15T00:00:00Z'::timestamptz, 7
      from metric_definitions m where m.connector_id = ${connector}`;
  }
  return id;
}

async function freshness(
  connectionId: string,
  stream: string,
  row: {
    resource?: string;
    dataThrough: string;
    nextExpectedAt: Date;
    checkedAt: Date;
  },
) {
  await admin`
    insert into connection_freshness (workspace_id, connection_id, stream,
      resource, data_through, time_zone, next_expected_at, checked_at,
      advanced_at)
    values (${workspaceId}, ${connectionId}, ${stream}, ${row.resource ?? ""},
      ${row.dataThrough}, 'America/Los_Angeles', ${row.nextExpectedAt},
      ${row.checkedAt}, ${row.checkedAt})`;
}

const query = (connectionId: string, fields: Record<string, unknown> = {}) =>
  call("POST", `/v1/workspaces/${workspaceId}/metrics/query`, {
    connectionId,
    metricKey: DOWNLOADS,
    period: "last_7_days",
    aggregation: "sum",
    ...fields,
  });

function ok(response: InjectResponse) {
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Record<string, unknown>;
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
  cookie = await signUp("live-freshness@example.com");
  const created = await call("POST", "/v1/workspaces", { name: "Live" });
  workspaceId = workspaceResponseSchema.parse(created.json()).workspace.id;

  const ascConfig = { vendorNumber: "85000000" };
  apps = await connection("app-store-connect", "Apps", {
    ...ascConfig,
    resourceSelection: ["app-1", "app-2"],
  });
  overdue = await connection("app-store-connect", "Overdue", ascConfig);
  quiet = await connection("app-store-connect", "Quiet", ascConfig);
  demo = await connection("demo", "Demo");

  // Sales: one report for the connection. Analytics: per app; app-9 is
  // not selected and must never count.
  await freshness(apps, "sales", {
    dataThrough: "2026-11-14",
    nextExpectedAt: at(8 * HOUR),
    checkedAt: at(-5 * MINUTE),
  });
  await freshness(apps, "analytics", {
    resource: "app-1",
    dataThrough: "2026-11-13",
    nextExpectedAt: at(8 * HOUR),
    checkedAt: at(-5 * MINUTE),
  });
  await freshness(apps, "analytics", {
    resource: "app-2",
    dataThrough: "2026-11-12",
    nextExpectedAt: at(9 * HOUR),
    checkedAt: at(-10 * MINUTE),
  });
  await freshness(apps, "analytics", {
    resource: "app-9",
    dataThrough: "2026-10-01",
    nextExpectedAt: at(-40 * 24 * HOUR),
    checkedAt: at(-HOUR),
  });
  // A sync 24 h after the expected time: overdue.
  await freshness(overdue, "sales", {
    dataThrough: "2026-11-14",
    nextExpectedAt: at(-25 * HOUR),
    checkedAt: at(-HOUR),
  });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("metric query freshness (#727)", () => {
  it("gives a periodic stream as the device payload does", async () => {
    const body = ok(await query(apps));
    expect(metricQueryResponseSchema.parse(body)).toEqual(body);
    expect(body.freshness).toEqual({
      kind: "periodic",
      stream: "Sales",
      fetchedAt: at(-5 * MINUTE).toISOString(),
      dataThrough: "2026-11-14",
      nextExpectedAt: at(8 * HOUR).toISOString(),
      nextCheckAt: at(2 * HOUR).toISOString(),
    });
    expect(body).not.toHaveProperty("status");
  });

  it("uses the least fresh selected app, and one app's rows for a scoped widget", async () => {
    const all = ok(await query(apps, { metricKey: IMPRESSIONS }));
    expect(all.freshness).toMatchObject({
      stream: "App Store analytics",
      fetchedAt: at(-10 * MINUTE).toISOString(),
      dataThrough: "2026-11-12",
    });
    // The slide scope arrives as the widget's resource filter.
    const scoped = ok(
      await query(apps, {
        metricKey: IMPRESSIONS,
        dimensions: { resource: "app-1" },
      }),
    );
    expect(scoped.freshness).toMatchObject({
      fetchedAt: at(-5 * MINUTE).toISOString(),
      dataThrough: "2026-11-13",
      nextExpectedAt: at(8 * HOUR).toISOString(),
    });
  });

  it("says `stale` for a provider overdue by 24 h", async () => {
    const body = ok(await query(overdue));
    expect(body).toMatchObject({
      status: "stale",
      freshness: { dataThrough: "2026-11-14", late: true },
    });
  });

  it("leaves responses without rows as they were", async () => {
    for (const connectionId of [quiet, demo]) {
      const body = ok(
        await query(
          connectionId,
          connectionId === demo ? { metricKey: "demo.signups" } : {},
        ),
      );
      expect(Object.keys(body)).toEqual(
        Object.keys(metricQueryResponseSchema.shape).filter(
          (key) => key !== "freshness" && key !== "status",
        ),
      );
    }
  });
});

describe("breakdown freshness (#727)", () => {
  const breakdown = (connectionId: string, fields = {}) =>
    call("POST", `/v1/workspaces/${workspaceId}/metrics/breakdown`, {
      connectionId,
      metricKey: IMPRESSIONS,
      period: "last_7_days",
      aggregation: "sum",
      groupBy: "resource",
      ...fields,
    });

  it("gives bars and tables the widget's freshness", async () => {
    const body = ok(await breakdown(apps));
    expect(metricBreakdownResponseSchema.parse(body)).toEqual(body);
    expect(body.freshness).toMatchObject({
      stream: "App Store analytics",
      dataThrough: "2026-11-12",
    });
    const sales = ok(await breakdown(overdue, { metricKey: DOWNLOADS }));
    expect(sales).toMatchObject({
      status: "stale",
      freshness: { late: true },
    });
    const none = ok(await breakdown(quiet));
    expect(none).not.toHaveProperty("freshness");
    expect(none).not.toHaveProperty("status");
  });
});

describe("gauge freshness (#727)", () => {
  it("gives a goal read for a gauge its metric's freshness", async () => {
    const goal = async (connectionId: string, dimensions = {}) => {
      const created = ok(
        await call("POST", `/v1/workspaces/${workspaceId}/goals`, {
          name: `Downloads ${connectionId}`,
          connectionId,
          metricKey: DOWNLOADS,
          aggregation: "sum",
          period: "this_month",
          dimensions,
          target: 100,
        }),
      );
      const id = (created.goal as { id: string }).id;
      const read = ok(
        await call("GET", `/v1/workspaces/${workspaceId}/goals/${id}`),
      );
      expect(goalReadResponseSchema.parse(read)).toEqual(read);
      return read;
    };
    expect((await goal(apps)).freshness).toMatchObject({
      stream: "Sales",
      dataThrough: "2026-11-14",
    });
    expect(await goal(overdue)).toMatchObject({
      status: "stale",
      freshness: { late: true },
    });
    const none = await goal(quiet);
    expect(Object.keys(none)).toEqual(["goal"]);
  });
});

describe("connection detail freshness (#727)", () => {
  it("lists the selected apps' rows only", async () => {
    const body = connectionDetailResponseSchema.parse(
      ok(
        await call("GET", `/v1/workspaces/${workspaceId}/connections/${apps}`),
      ),
    );
    const analytics = body.freshness.find(
      (stream) => stream.key === "analytics",
    );
    expect(analytics!.entries.map((entry) => entry.resource)).toEqual([
      "app-1",
      "app-2",
    ]);
  });
});
