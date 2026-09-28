import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  errorResponseSchema,
  metricQueryResponseSchema,
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
  app = await buildApp(config, { db, authService, checkDb: async () => true });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });

  owner = await signUp("metrics-owner@example.com");
  stranger = await signUp("metrics-stranger@example.com");
  workspaceId = (await createWorkspace(owner, BERLIN)).id;
  otherWorkspaceId = (await createWorkspace(stranger)).id;
  connectionId = await createConnection(workspaceId);
  otherConnectionId = await createConnection(otherWorkspaceId);

  // Daily signups (delta) for the last 14 reporting dates in Berlin, 1..14
  // with today = 14, plus another workspace's data that must never count.
  const today = civilDate(new Date(), BERLIN);
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
    today,
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
