import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addDemoContentResponseSchema,
  createWorkspaceResponseSchema,
  dashboardResponseSchema,
  metricQueryResponseSchema,
} from "@netrics/contracts";
import {
  ConnectorRegistry,
  type RegisteredConnector,
} from "@netrics/connector-runtime";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createDefaultRegistry } from "./connectors.js";
import { createCredentialKeyring } from "./credentials.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig, type Config } from "./env.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createWorker } from "./worker.js";

let testDb: TestDatabase;
let config: Config;
let db: Database;
let schedulerDb: Database;
let admin: Sql;
let app: FastifyInstance;
let cookie: string;

async function buildWith(registry?: ConnectorRegistry, now?: () => Date) {
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  return buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    ...(registry ? { registry } : {}),
    ...(now ? { now } : {}),
  });
}

async function signUp(target: FastifyInstance, email: string) {
  const response = await target.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email, email, password: "password-12345" },
  });
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

function createWorkspace(
  target: FastifyInstance,
  session: string,
  body: Record<string, unknown>,
) {
  return target.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: session },
    payload: { name: "New team", ...body },
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  const scheduler = new URL(testDb.adminUrl);
  scheduler.username = "netrics_scheduler";
  scheduler.password = "netrics_scheduler";
  schedulerDb = createDatabase(scheduler.toString());
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  app = await buildWith();
  cookie = await signUp(app, "onboarding@example.com");
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await schedulerDb.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("workspace onboarding", () => {
  // Fixed clocks (#144), so the result does not depend on the time of day.
  // The demo connector reports up to the latest date anywhere (UTC+14), so
  // every tile has data around local and UTC midnight and the 1st (#148).
  it.each([
    ["at midday", "2025-07-15T12:00:00Z", "Europe/Berlin"],
    ["just after UTC midnight", "2025-07-15T00:30:00Z", "Europe/Berlin"],
    // Already the next day in Berlin, not yet in UTC.
    ["between local and UTC midnight", "2025-07-15T22:30:00Z", "Europe/Berlin"],
    [
      "on the 1st, before UTC midnight",
      "2025-07-31T22:30:00Z",
      "Europe/Berlin",
    ],
    ["just after local midnight", "2025-07-15T10:30:00Z", "Pacific/Kiritimati"],
    [
      "just after local midnight",
      "2025-07-15T07:30:00Z",
      "America/Los_Angeles",
    ],
  ])(
    "reaches a populated dashboard without manual steps %s (%s, %s)",
    async (_label, at, timeZone) => {
      const now = () => new Date(at);
      const pinned = await buildWith(undefined, now);
      try {
        await reachPopulatedDashboard(pinned, now, timeZone);
      } finally {
        await pinned.close();
      }
    },
    60_000,
  );

  async function reachPopulatedDashboard(
    target: FastifyInstance,
    now: () => Date,
    timeZone: string,
  ) {
    const created = await createWorkspace(target, cookie, {
      withDemo: true,
      timeZone,
    });
    expect(created.statusCode).toBe(200);
    const { workspace, demoDashboardId } = createWorkspaceResponseSchema.parse(
      created.json(),
    );
    expect(demoDashboardId).not.toBeNull();

    const read = await target.inject({
      method: "GET",
      url: `/v1/workspaces/${workspace.id}/dashboards/${demoDashboardId}`,
      headers: { cookie },
    });
    const { dashboard } = dashboardResponseSchema.parse(read.json());
    expect(dashboard.name).toBe("Demo dashboard");
    expect(dashboard.tiles).toHaveLength(6);

    // The demo connection's backfill was queued with it; one worker pass
    // fills the dashboard.
    // The worker as production runs it (startWorker).
    const worker = createWorker({
      schedulerDb,
      appDb: db,
      handlers: createJobHandlers({
        registry: createDefaultRegistry(),
        credentialKeyring: createCredentialKeyring(
          config.appEncryptionKey,
          config.appEncryptionKeysPrevious,
        ),
        now,
      }),
      pollMs: 25,
      heartbeatMs: 50,
    });
    await worker.start();
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [job] = await admin`
        select status, last_error from jobs
        where workspace_id = ${workspace.id} and kind = 'connection.backfill'`;
      if (job?.status === "dead") {
        throw new Error(`backfill failed: ${job.last_error}`);
      }
      if (job?.status === "succeeded" || Date.now() > deadline) {
        expect(job?.status).toBe("succeeded");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await worker.stop();

    for (const tile of dashboard.tiles) {
      const response = await target.inject({
        method: "POST",
        url: `/v1/workspaces/${workspace.id}/metrics/query`,
        headers: { cookie },
        payload: {
          connectionId: tile.connectionId,
          metricKey: tile.metricKey,
          period: tile.period,
          aggregation: tile.aggregation,
        },
      });
      expect(response.statusCode).toBe(200);
      const result = metricQueryResponseSchema.parse(response.json());
      expect(result.value, tile.title ?? tile.metricKey).not.toBeNull();
      // The comparison period (yesterday, the previous month's first days,
      // the 7 or 30 days before) is populated too.
      expect(result.previousValue, tile.title ?? tile.metricKey).not.toBeNull();
    }

    const actions = await admin`
      select action from audit_events
      where workspace_id = ${workspace.id} order by created_at`;
    expect(actions.map((row) => row.action)).toEqual([
      "workspace.created",
      "connection.created",
      "dashboard.created",
    ]);
  }

  it("adds nothing without the option", async () => {
    const created = await createWorkspace(app, cookie, {});
    const { workspace, demoDashboardId } = createWorkspaceResponseSchema.parse(
      created.json(),
    );
    expect(demoDashboardId).toBeNull();
    const [counts] = await admin`
      select (select count(*)::int from connections where workspace_id = ${workspace.id}) as connections,
             (select count(*)::int from dashboards where workspace_id = ${workspace.id}) as dashboards`;
    expect(counts).toEqual({ connections: 0, dashboards: 0 });
  });

  describe("adding the demo to an existing workspace (#308)", () => {
    function addDemo(target: FastifyInstance, session: string, id: string) {
      return target.inject({
        method: "POST",
        url: `/v1/workspaces/${id}/demo`,
        headers: { cookie: session },
      });
    }

    async function counts(workspaceId: string) {
      const [row] = await admin`
        select (select count(*)::int from connections where workspace_id = ${workspaceId}) as connections,
               (select count(*)::int from dashboards where workspace_id = ${workspaceId}) as dashboards`;
      return row;
    }

    it("adds the demo connection and dashboard for an admin", async () => {
      const created = await createWorkspace(app, cookie, {});
      const { workspace } = createWorkspaceResponseSchema.parse(created.json());
      const response = await addDemo(app, cookie, workspace.id);
      expect(response.statusCode).toBe(200);
      const { demoDashboardId } = addDemoContentResponseSchema.parse(
        response.json(),
      );
      expect(demoDashboardId).not.toBeNull();
      const read = await app.inject({
        method: "GET",
        url: `/v1/workspaces/${workspace.id}/dashboards/${demoDashboardId}`,
        headers: { cookie },
      });
      expect(dashboardResponseSchema.parse(read.json()).dashboard.name).toBe(
        "Demo dashboard",
      );
      expect(await counts(workspace.id)).toEqual({
        connections: 1,
        dashboards: 1,
      });
    });

    it("refuses another workspace's members and viewers", async () => {
      const created = await createWorkspace(app, cookie, {});
      const { workspace } = createWorkspaceResponseSchema.parse(created.json());
      // A member of another workspace: 404, so the workspace is not leaked.
      const stranger = await signUp(app, "onboarding-stranger@example.com");
      await createWorkspace(app, stranger, {});
      expect((await addDemo(app, stranger, workspace.id)).statusCode).toBe(404);
      // A viewer may not create connections or dashboards.
      const viewer = await signUp(app, "onboarding-viewer@example.com");
      const added = await addMemberViaInvitation(
        app,
        db,
        cookie,
        workspace.id,
        "onboarding-viewer@example.com",
        "viewer",
      );
      expect(added.statusCode).toBe(200);
      expect((await addDemo(app, viewer, workspace.id)).statusCode).toBe(403);
      expect(await counts(workspace.id)).toEqual({
        connections: 0,
        dashboards: 0,
      });
    });
  });

  it("still creates the workspace when the demo cannot be added", async () => {
    const withoutDemo = await buildWith(new ConnectorRegistry());
    const failing = {
      get(): RegisteredConnector | undefined {
        throw new Error("registry unavailable");
      },
      list: () => [],
      register: () => undefined,
    } as unknown as ConnectorRegistry;
    const broken = await buildWith(failing);
    try {
      for (const target of [withoutDemo, broken]) {
        const created = await createWorkspace(target, cookie, {
          withDemo: true,
        });
        expect(created.statusCode).toBe(200);
        expect(
          createWorkspaceResponseSchema.parse(created.json()).demoDashboardId,
        ).toBeNull();
      }
    } finally {
      await withoutDemo.close();
      await broken.close();
    }
  });
});
