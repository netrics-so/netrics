import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  dashboardResponseSchema,
  deleteGoalResponseSchema,
  deviceDashboardV2ResponseSchema,
  deviceDashboardV3ResponseSchema,
  errorResponseSchema,
  goalResponseSchema,
  workspaceResponseSchema,
  type Dashboard,
  type DeviceWidget,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { goalTimeText } from "@netrics/domain";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import {
  buildDeviceDashboardV2,
  buildDeviceDashboardV3,
  withDevice,
} from "./devices/dashboard.js";
import { loadConfig } from "./env.js";
import { createTestDatabase } from "./test-db.js";

// The goal widget (#339, ADR 0019 section 5): a gauge names a goal of its
// workspace; the dashboard API labels it with the goal's name and flags a
// deleted goal (`goal_missing`); the device payload resolves the goal's
// progress on the server, the same numbers the Goals API answers, and a
// deleted goal is "Goal deleted" (`goal: null`, `no_data`) while the
// dashboard still saves. Never a goal of another workspace.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

// Thursday 22 October 2026, 15:00 in Berlin.
const NOW = new Date("2026-10-22T13:00:00Z");

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let stranger: string;
let workspaceId: string;
let strangerWorkspaceId: string;
let connectionId: string;
let strangerConnectionId: string;
let goalId: string;
let weeklyGoalId: string;
let strangerGoalId: string;

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  cookie: string,
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

async function newWorkspace(cookie: string): Promise<string> {
  const response = await call("POST", "/v1/workspaces", cookie, {
    name: "Gauges",
    timeZone: "Europe/Berlin",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

async function newConnection(workspace: string): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspace}, 'demo', 'Demo') returning id`;
  return row!.id as string;
}

async function observe(date: string, value: number) {
  await admin`
    insert into observations (workspace_id, connection_id, metric_definition_id,
      dimensions, source_timestamp, value)
    select ${workspaceId}, ${connectionId}, m.id, '{}'::jsonb,
           ${`${date}T00:00:00Z`}::timestamptz, ${value}
    from metric_definitions m
    where m.connector_id = 'demo' and m.key = 'demo.signups'`;
}

async function createGoal(
  workspace: string,
  cookie: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await call(
    "POST",
    `/v1/workspaces/${workspace}/goals`,
    cookie,
    body,
  );
  expect(response.statusCode).toBe(200);
  return goalResponseSchema.parse(response.json()).goal.id;
}

const dashboards = (workspace = workspaceId) =>
  `/v1/workspaces/${workspace}/dashboards`;

function gauge(
  goal: string | null,
  x = 0,
  extra: Record<string, unknown> = {},
) {
  return { type: "gauge", x, y: 0, w: 3, h: 3, goalId: goal, ...extra };
}

async function createDashboard(
  name: string,
  widgets: unknown[],
): Promise<Dashboard> {
  const response = await call("POST", dashboards(), owner, {
    name,
    slides: [{ widgets }],
  });
  expect(response.statusCode).toBe(200);
  return dashboardResponseSchema.parse(response.json()).dashboard;
}

async function readDashboard(id: string): Promise<Dashboard> {
  const response = await call("GET", `${dashboards()}/${id}`, owner);
  expect(response.statusCode).toBe(200);
  return dashboardResponseSchema.parse(response.json()).dashboard;
}

function payloadV2(dashboardId: string) {
  return withWorkspace(db, { workspaceId }, (tx) =>
    buildDeviceDashboardV2(tx, workspaceId, dashboardId, {
      now: NOW,
      exchangeRates: false,
    }),
  );
}

async function gaugesOf(dashboardId: string) {
  const payload = deviceDashboardV2ResponseSchema.parse(
    await payloadV2(dashboardId),
  );
  return payload.slides
    .flatMap((slide) => slide.widgets)
    .filter(
      (widget): widget is Extract<DeviceWidget, { type: "gauge" }> =>
        widget.type === "gauge",
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

  owner = await signUp("gauge-owner@example.com");
  stranger = await signUp("gauge-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  strangerWorkspaceId = await newWorkspace(stranger);
  connectionId = await newConnection(workspaceId);
  strangerConnectionId = await newConnection(strangerWorkspaceId);
  await admin`
    insert into connection_state (connection_id, workspace_id,
      last_success_at, poll_interval_seconds)
    values (${connectionId}, ${workspaceId}, '2026-10-22T12:55:00Z', 300)`;

  // October so far: 12,480 signups; this week (from Monday 19 October):
  // 400 + 212 = 612.
  await observe("2026-10-01", 5_000);
  await observe("2026-10-05", 6_000);
  await observe("2026-10-10", 868);
  await observe("2026-10-20", 400);
  await observe("2026-10-21", 212);

  goalId = await createGoal(workspaceId, owner, {
    name: "Monthly downloads",
    connectionId,
    metricKey: "demo.signups",
    period: "this_month",
    target: 15_000,
  });
  weeklyGoalId = await createGoal(workspaceId, owner, {
    name: "Weekly signups",
    connectionId,
    metricKey: "demo.signups",
    period: "this_week",
    target: 500,
  });
  strangerGoalId = await createGoal(strangerWorkspaceId, stranger, {
    name: "Theirs",
    connectionId: strangerConnectionId,
    metricKey: "demo.signups",
    period: "this_month",
    target: 10,
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("goal widgets in the dashboard API", () => {
  it("stores a gauge with its goal, named after it", async () => {
    const dashboard = await createDashboard("Goals", [
      gauge(goalId, 0, { options: { showTimeLeft: false } }),
      gauge(weeklyGoalId, 3, { title: "This week" }),
    ]);
    const [first, second] = dashboard.slides[0]!.widgets;
    expect(first).toMatchObject({
      type: "gauge",
      goalId,
      goalName: "Monthly downloads",
      title: null,
      options: { showTimeLeft: false },
    });
    expect(second).toMatchObject({
      type: "gauge",
      goalId: weeklyGoalId,
      goalName: "Weekly signups",
      title: "This week",
      // The default.
      options: { showTimeLeft: true },
    });
    expect(
      dashboard.slides[0]!.formatWarnings.filter(
        (warning) => warning.code === "goal_missing",
      ),
    ).toEqual([]);
  });

  it("never stores a goal of another workspace", async () => {
    const dashboard = await createDashboard("Foreign goal", [
      gauge(strangerGoalId),
    ]);
    expect(dashboard.slides[0]!.widgets[0]).toMatchObject({
      type: "gauge",
      goalId: null,
      goalName: null,
    });
    const [row] = await admin`
      select goal_id from dashboard_widgets where dashboard_id = ${dashboard.id}`;
    expect(row!.goal_id).toBeNull();
  });

  it("refuses a gauge below 3 × 3 and counts it as a data widget", async () => {
    const small = await call("POST", dashboards(), owner, {
      name: "Small",
      slides: [{ widgets: [{ ...gauge(goalId), h: 2 }] }],
    });
    expect(small.statusCode).toBe(400);
    // 48 data widgets at most: 47 metrics and a gauge are fine, 48 and a
    // gauge are not.
    const metric = (slide: number, index: number) => ({
      type: "metric",
      x: (index % 4) * 3,
      y: Math.floor(index / 4) * 2,
      w: 3,
      h: 2,
      connectionId,
      metricKey: "demo.signups",
      period: "this_month",
      _slide: slide,
    });
    const slides = (metrics: number) => {
      const result: Array<{ widgets: unknown[] }> = [];
      for (let index = 0; index < metrics; index++) {
        const slide = Math.floor(index / 12);
        result[slide] ??= { widgets: [] };
        const { _slide, ...widget } = metric(slide, index % 12);
        result[slide]!.widgets.push(widget);
      }
      result.push({ widgets: [gauge(goalId)] });
      return result;
    };
    const fits = await call("POST", dashboards(), owner, {
      name: "Many",
      slides: slides(47),
    });
    expect(fits.statusCode).toBe(200);
    const tooMany = await call("POST", dashboards(), owner, {
      name: "Too many",
      slides: slides(48),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(errorResponseSchema.parse(tooMany.json()).error).toBe(
      "too_many_data_widgets",
    );
  });
});

describe("goal widgets on screens", () => {
  it("resolve their goal's progress like the Goals API", async () => {
    const dashboard = await createDashboard("Screens", [
      gauge(goalId),
      gauge(weeklyGoalId, 3),
    ]);
    const [monthly, weekly] = await gaugesOf(dashboard.id);
    expect(monthly).toMatchObject({
      type: "gauge",
      label: "Monthly downloads",
      options: { showTimeLeft: true },
      data: {
        goal: { id: goalId, name: "Monthly downloads" },
        period: "this_month",
        aggregation: "sum",
        unit: "signups",
        status: "ok",
        value: 12_480,
        target: 15_000,
        reachedAt: null,
        periodEnd: "2026-11-01T00:00:00+01:00",
      },
    });
    expect(monthly!.data.progress).toBeCloseTo(0.832, 9);
    const goalApi = goalResponseSchema.parse(
      (
        await call(
          "GET",
          `/v1/workspaces/${workspaceId}/goals/${goalId}`,
          owner,
        )
      ).json(),
    ).goal;
    expect(goalApi.current).toMatchObject({
      value: monthly!.data.value,
      progress: monthly!.data.progress,
      periodEnd: monthly!.data.periodEnd,
    });
    // "9 days left" on the screen's clock.
    expect(
      goalTimeText({
        period: monthly!.data.period!,
        periodEnd: monthly!.data.periodEnd!,
        reachedAt: monthly!.data.reachedAt,
        progress: monthly!.data.progress,
        now: NOW,
        timeZone: "Europe/Berlin",
      }),
    ).toEqual({ kind: "days", days: 9 });

    // Reached this week on Wednesday 21 October: 612 of 500.
    expect(weekly!.data).toMatchObject({
      value: 612,
      target: 500,
      periodEnd: "2026-10-26T00:00:00+01:00",
    });
    expect(weekly!.data.progress).toBeCloseTo(1.224, 9);
    expect(
      goalTimeText({
        period: "this_week",
        periodEnd: weekly!.data.periodEnd!,
        reachedAt: weekly!.data.reachedAt,
        progress: weekly!.data.progress,
        now: NOW,
        timeZone: "Europe/Berlin",
      }),
    ).toEqual({ kind: "early", days: 4 });
  });

  it("carry their minimum in schema 3", async () => {
    const dashboard = await createDashboard("Schema 3", [gauge(goalId)]);
    const content = await withWorkspace(db, { workspaceId }, (tx) =>
      buildDeviceDashboardV3(tx, workspaceId, dashboard.id, {
        now: NOW,
        exchangeRates: false,
      }),
    );
    const payload = deviceDashboardV3ResponseSchema.parse(
      withDevice(content, { rotation: 0, displayMode: "screen" }),
    );
    expect(payload.slides[0]!.widgets[0]).toMatchObject({
      type: "gauge",
      min: { w: 3, h: 3 },
    });
  });

  it("show 'Goal deleted' once the goal is gone, and the dashboard still saves", async () => {
    const doomed = await createGoal(workspaceId, owner, {
      name: "Doomed",
      connectionId,
      metricKey: "demo.signups",
      period: "this_month",
      target: 100,
    });
    const first = await createDashboard("Uses doomed", [
      gauge(doomed),
      gauge(goalId, 3),
    ]);
    const second = await createDashboard("Also doomed", [
      gauge(doomed, 0, { title: "Launch" }),
    ]);

    const removed = await call(
      "DELETE",
      `/v1/workspaces/${workspaceId}/goals/${doomed}`,
      owner,
    );
    expect(removed.statusCode).toBe(200);
    expect(
      deleteGoalResponseSchema
        .parse(removed.json())
        .dashboards.map((dashboard) => dashboard.name),
    ).toEqual(["Also doomed", "Uses doomed"]);

    // The Studio sees the gauge without its goal and a warning per format.
    const read = await readDashboard(first.id);
    expect(read.slides[0]!.widgets[0]).toMatchObject({
      type: "gauge",
      goalId: null,
      goalName: null,
    });
    const missing = read.slides[0]!.formatWarnings.filter(
      (warning) => warning.code === "goal_missing",
    );
    expect(missing.length).toBe(5);
    expect(missing[0]).toMatchObject({
      severity: "attention",
      widgetId: read.slides[0]!.widgets[0]!.id,
    });

    // Screens: "Goal deleted", no data, the title or "Goal".
    const [deleted, kept] = await gaugesOf(first.id);
    expect(deleted).toMatchObject({
      label: "Goal",
      data: {
        goal: null,
        status: "no_data",
        value: null,
        target: null,
        progress: null,
        periodEnd: null,
      },
    });
    expect(kept!.data.goal?.id).toBe(goalId);
    const [titled] = await gaugesOf(second.id);
    expect(titled!.label).toBe("Launch");

    // Saving it back as it was read (goalId null) works, as does a client
    // that still holds the deleted id.
    for (const goal of [null, doomed]) {
      const current = await readDashboard(first.id);
      const saved = await call("PUT", `${dashboards()}/${first.id}`, owner, {
        version: current.version,
        name: current.name,
        projectId: null,
        slides: [
          {
            id: current.slides[0]!.id,
            widgets: [gauge(goal), gauge(goalId, 3)],
          },
        ],
      });
      expect(saved.statusCode).toBe(200);
      expect(
        dashboardResponseSchema.parse(saved.json()).dashboard.slides[0]!
          .widgets[0],
      ).toMatchObject({ goalId: null });
    }
  });
});
