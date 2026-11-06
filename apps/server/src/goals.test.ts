import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  deleteGoalResponseSchema,
  errorResponseSchema,
  goalListResponseSchema,
  goalResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

// Goals (#335, ADR 0019 section 4): a shared entity with its current
// progress, the binding checked like a widget's plus what a goal needs,
// dashboard permissions, optimistic concurrency, audit events, and never a
// goal of another workspace.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

// Wednesday 14 October 2026, 15:00 in Berlin.
const NOW = new Date("2026-10-14T13:00:00Z");

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let workspaceAdmin: string;
let editor: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let strangerWorkspaceId: string;
let connectionId: string;
let testConnectionId: string;
let strangerConnectionId: string;

function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
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

async function newWorkspace(cookie: string): Promise<string> {
  const response = await call("POST", "/v1/workspaces", cookie, {
    name: "Goals",
    timeZone: "Europe/Berlin",
  });
  return workspaceResponseSchema.parse(response.json()).workspace.id;
}

async function newConnection(
  workspace: string,
  connector = "demo",
): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspace}, ${connector}, 'Demo') returning id`;
  return row!.id as string;
}

async function observe(
  connection: string,
  metricKey: string,
  date: string,
  value: number,
  dimensions: Record<string, string>,
  workspace = workspaceId,
  connector = "demo",
) {
  await admin`
    insert into observations (workspace_id, connection_id, metric_definition_id,
      dimensions, source_timestamp, value)
    select ${workspace}, ${connection}, m.id, ${admin.json(dimensions)},
           ${`${date}T00:00:00Z`}::timestamptz, ${value}
    from metric_definitions m
    where m.connector_id = ${connector} and m.key = ${metricKey}`;
}

const goals = (workspace = workspaceId) => `/v1/workspaces/${workspace}/goals`;

function wurfelGoal(overrides: Record<string, unknown> = {}) {
  return {
    name: "Monthly downloads · Wurfel",
    connectionId,
    metricKey: "demo.signups",
    period: "this_month",
    dimensions: { resource: "wurfel" },
    target: 15_000,
    ...overrides,
  };
}

function expectError(response: InjectResponse, status: number, error: string) {
  expect(response.statusCode).toBe(status);
  expect(errorResponseSchema.parse(response.json()).error).toBe(error);
}

async function createGoal(body: Record<string, unknown>, cookie = editor) {
  const response = await call("POST", goals(), cookie, body);
  expect(response.statusCode).toBe(200);
  return goalResponseSchema.parse(response.json()).goal;
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

  owner = await signUp("goal-owner@example.com");
  workspaceAdmin = await signUp("goal-admin@example.com");
  editor = await signUp("goal-editor@example.com");
  viewer = await signUp("goal-viewer@example.com");
  stranger = await signUp("goal-stranger@example.com");
  workspaceId = await newWorkspace(owner);
  for (const [email, role] of [
    ["goal-admin@example.com", "admin"],
    ["goal-editor@example.com", "editor"],
    ["goal-viewer@example.com", "viewer"],
  ] as const) {
    const added = await addMemberViaInvitation(
      app,
      db,
      owner,
      workspaceId,
      email,
      role,
    );
    expect(added.statusCode).toBe(200);
  }
  strangerWorkspaceId = await newWorkspace(stranger);
  connectionId = await newConnection(workspaceId);
  strangerConnectionId = await newConnection(strangerWorkspaceId);
  await admin`
    insert into connection_resources
      (connection_id, workspace_id, resource_id, name, kind)
    values (${connectionId}, ${workspaceId}, 'wurfel', 'Wurfel', 'app')`;

  // October so far: 5,000 + 6,000 + 1,480 = 12,480 Wurfel signups; another
  // app and September do not count.
  await observe(connectionId, "demo.signups", "2026-09-30", 9_000, {
    resource: "wurfel",
  });
  await observe(connectionId, "demo.signups", "2026-10-01", 5_000, {
    resource: "wurfel",
  });
  await observe(connectionId, "demo.signups", "2026-10-05", 6_000, {
    resource: "wurfel",
  });
  await observe(connectionId, "demo.signups", "2026-10-10", 1_480, {
    resource: "wurfel",
  });
  await observe(connectionId, "demo.signups", "2026-10-10", 700, {
    resource: "other",
  });

  // Metrics the demo does not have: a lower-is-better position and an
  // amount per currency (ADR 0014).
  await admin`
    insert into connectors (id, version, manifest)
    values ('test-goals', '1.0.0', '{"id":"test-goals"}'::jsonb)`;
  await admin`
    insert into metric_definitions (connector_id, key, name, description,
      kind, unit, granularity, dimensions, aggregations, better)
    values
      ('test-goals', 'goal.position', 'Average position', 'Rank',
       'gauge', 'position', 'day', '[]', '["last","min","max"]', 'lower'),
      ('test-goals', 'goal.proceeds', 'Proceeds', 'Proceeds per day',
       'delta', 'currency_minor', 'day', '["currency"]', '["sum"]', 'higher')`;
  testConnectionId = await newConnection(workspaceId, "test-goals");
  await observe(
    testConnectionId,
    "goal.proceeds",
    "2026-10-02",
    12_345,
    { currency: "EUR" },
    workspaceId,
    "test-goals",
  );
  await observe(
    testConnectionId,
    "goal.proceeds",
    "2026-10-02",
    500,
    { currency: "USD" },
    workspaceId,
    "test-goals",
  );
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("goals API", () => {
  it("lets an editor create a goal and everyone see its progress", async () => {
    const created = await createGoal(wurfelGoal());
    expect(created).toMatchObject({
      name: "Monthly downloads · Wurfel",
      connectionId,
      metricKey: "demo.signups",
      // Filled in from the metric, like a widget's.
      aggregation: "sum",
      period: "this_month",
      dimensions: { resource: "wurfel" },
      displayCurrency: null,
      target: 15_000,
      version: 1,
      resourceName: "Wurfel",
      allResourcesName: null,
      current: {
        value: 12_480,
        target: 15_000,
        reachedAt: null,
        periodEnd: "2026-11-01T00:00:00+01:00",
        currency: null,
        approximate: false,
      },
      // Gauges arrive with #339.
      dashboards: [],
    });
    expect(created.current?.progress).toBeCloseTo(0.832, 6);

    const listed = await call("GET", goals(), viewer);
    expect(listed.statusCode).toBe(200);
    const { goals: list } = goalListResponseSchema.parse(listed.json());
    expect(list.find((goal) => goal.id === created.id)).toEqual(created);

    const read = await call("GET", `${goals()}/${created.id}`, viewer);
    expect(goalResponseSchema.parse(read.json()).goal).toEqual(created);
  });

  it("names when the running sum reached the target", async () => {
    const reached = await createGoal(
      wurfelGoal({ name: "Ten thousand", target: 10_000 }),
    );
    expect(reached.current?.progress).toBeCloseTo(1.248, 6);
    // 5,000 on 1 October and 6,000 on 5 October: reached on the 5th.
    expect(reached.current?.reachedAt).toMatch(/^2026-10-05T00:00:00/);
  });

  it("lets viewers read only, and only owners and admins delete", async () => {
    const goal = await createGoal(wurfelGoal({ name: "Permissions" }));
    const update = {
      ...wurfelGoal({ name: "Permissions" }),
      version: 1,
      target: 20_000,
    };
    expectError(
      await call("POST", goals(), viewer, wurfelGoal()),
      403,
      "forbidden",
    );
    expectError(
      await call("PUT", `${goals()}/${goal.id}`, viewer, update),
      403,
      "forbidden",
    );
    expectError(
      await call("DELETE", `${goals()}/${goal.id}`, viewer),
      403,
      "forbidden",
    );
    expectError(
      await call("DELETE", `${goals()}/${goal.id}`, editor),
      403,
      "forbidden",
    );

    const updated = await call("PUT", `${goals()}/${goal.id}`, editor, update);
    expect(updated.statusCode).toBe(200);
    expect(goalResponseSchema.parse(updated.json()).goal).toMatchObject({
      version: 2,
      target: 20_000,
    });

    const removed = await call(
      "DELETE",
      `${goals()}/${goal.id}`,
      workspaceAdmin,
    );
    expect(removed.statusCode).toBe(200);
    expect(deleteGoalResponseSchema.parse(removed.json())).toEqual({
      dashboards: [],
    });
    expectError(
      await call("GET", `${goals()}/${goal.id}`, viewer),
      404,
      "goal_not_found",
    );

    const audit = await admin`
      select action from audit_events
      where workspace_id = ${workspaceId} and target = ${goal.id}
      order by created_at, id`;
    expect(audit.map((row) => row.action)).toEqual([
      "goal.created",
      "goal.updated",
      "goal.deleted",
    ]);
    const ownerDelete = await createGoal(wurfelGoal({ name: "Owner" }));
    expect(
      (await call("DELETE", `${goals()}/${ownerDelete.id}`, owner)).statusCode,
    ).toBe(200);
  });

  it("refuses a stale version and a taken name", async () => {
    const goal = await createGoal(wurfelGoal({ name: "Versioned" }));
    const body = { ...wurfelGoal({ name: "Versioned" }), version: 1 };
    expect(
      (await call("PUT", `${goals()}/${goal.id}`, editor, body)).statusCode,
    ).toBe(200);
    expectError(
      await call("PUT", `${goals()}/${goal.id}`, editor, body),
      409,
      "version_conflict",
    );
    expectError(
      await call("POST", goals(), editor, wurfelGoal({ name: "VERSIONED" })),
      409,
      "goal_name_taken",
    );
  });

  it("refuses goals that cannot be one, with their codes", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      // An average has no "to go".
      [
        {
          metricKey: "demo.visitors",
          aggregation: "avg",
          dimensions: {},
        },
        "aggregation_not_supported",
      ],
      // A rolling window has no end to reach a goal by.
      [{ period: "last_30_days" }, "period_not_supported"],
      [
        {
          connectionId: testConnectionId,
          metricKey: "goal.position",
          dimensions: {},
        },
        "goal_direction_unsupported",
      ],
      // Mixed currencies: neither one currency nor a fixed conversion.
      [
        {
          connectionId: testConnectionId,
          metricKey: "goal.proceeds",
          dimensions: {},
        },
        "currency_required",
      ],
      // The binding as a widget's.
      [{ metricKey: "demo.unknown" }, "tile_metric_not_found"],
      [{ dimensions: { resource: "nope" } }, "unknown_resource"],
      [{ dimensions: { country: "DE" } }, "unknown_dimension"],
    ];
    for (const [overrides, error] of cases) {
      expectError(
        await call("POST", goals(), editor, wurfelGoal(overrides)),
        400,
        error,
      );
    }
    // Rolling periods, zero and huge targets, long names: shape errors.
    for (const overrides of [
      { target: 0 },
      { target: 2e15 },
      { name: "x".repeat(61) },
      { name: "  " },
    ]) {
      expectError(
        await call("POST", goals(), editor, wurfelGoal(overrides)),
        400,
        "invalid_request",
      );
    }
    // An update is checked the same way and leaves the goal as it was.
    const goal = await createGoal(wurfelGoal({ name: "Unchanged" }));
    expectError(
      await call("PUT", `${goals()}/${goal.id}`, editor, {
        ...wurfelGoal({ name: "Unchanged" }),
        period: "last_7_days",
        version: 1,
      }),
      400,
      "period_not_supported",
    );
    const read = await call("GET", `${goals()}/${goal.id}`, viewer);
    expect(goalResponseSchema.parse(read.json()).goal.version).toBe(1);
  });

  it("accepts an amount in one currency, in its minor units", async () => {
    const goal = await createGoal({
      name: "Proceeds in euros",
      connectionId: testConnectionId,
      metricKey: "goal.proceeds",
      period: "this_quarter",
      dimensions: { currency: "EUR" },
      target: 100_000,
    });
    expect(goal.current).toMatchObject({
      value: 12_345,
      currency: "EUR",
      approximate: false,
      periodEnd: "2027-01-01T00:00:00+01:00",
    });
  });

  it("never lists or reaches another workspace's goals", async () => {
    const ours = await createGoal(wurfelGoal({ name: "Ours" }));
    const response = await call("POST", goals(strangerWorkspaceId), stranger, {
      ...wurfelGoal({ name: "Theirs", dimensions: {} }),
      connectionId: strangerConnectionId,
    });
    expect(response.statusCode).toBe(200);
    const theirs = goalResponseSchema.parse(response.json()).goal;

    const ourList = goalListResponseSchema.parse(
      (await call("GET", goals(), owner)).json(),
    ).goals;
    expect(ourList.map((goal) => goal.id)).not.toContain(theirs.id);
    const theirList = goalListResponseSchema.parse(
      (await call("GET", goals(strangerWorkspaceId), stranger)).json(),
    ).goals;
    expect(theirList.map((goal) => goal.id)).toEqual([theirs.id]);

    // Their goal through our workspace: not found, unchanged.
    const theirUrl = `${goals()}/${theirs.id}`;
    expectError(await call("GET", theirUrl, owner), 404, "goal_not_found");
    expectError(
      await call("PUT", theirUrl, owner, {
        ...wurfelGoal({ name: "Hijacked" }),
        version: 1,
      }),
      404,
      "goal_not_found",
    );
    expectError(await call("DELETE", theirUrl, owner), 404, "goal_not_found");
    // Our workspace for a non-member: not found.
    expectError(
      await call("GET", goals(), stranger),
      404,
      "workspace_not_found",
    );
    expectError(
      await call("GET", `${goals()}/${ours.id}`, stranger),
      404,
      "workspace_not_found",
    );
    // A connection of another workspace is no binding for ours.
    expectError(
      await call(
        "POST",
        goals(),
        owner,
        wurfelGoal({ name: "Foreign", connectionId: strangerConnectionId }),
      ),
      400,
      "tile_metric_not_found",
    );
    const [stored] = await admin`
      select name, version from goals where id = ${theirs.id}`;
    expect(stored).toEqual({ name: "Theirs", version: 1 });
  });

  it("answers 404 for malformed ids and needs a session", async () => {
    expectError(
      await call("GET", `${goals()}/not-a-uuid`, viewer),
      404,
      "goal_not_found",
    );
    expect((await call("GET", goals(), null)).statusCode).toBe(401);
  });
});
