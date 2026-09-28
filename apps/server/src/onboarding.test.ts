import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
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
import { createWorker } from "./worker.js";

let testDb: TestDatabase;
let config: Config;
let db: Database;
let schedulerDb: Database;
let admin: Sql;
let app: FastifyInstance;
let cookie: string;

async function buildWith(registry?: ConnectorRegistry) {
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  return buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    ...(registry ? { registry } : {}),
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
  it("reaches a populated dashboard without manual steps", async () => {
    const created = await createWorkspace(app, cookie, {
      withDemo: true,
      timeZone: "Europe/Berlin",
    });
    expect(created.statusCode).toBe(200);
    const { workspace, demoDashboardId } = createWorkspaceResponseSchema.parse(
      created.json(),
    );
    expect(demoDashboardId).not.toBeNull();

    const read = await app.inject({
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
      const response = await app.inject({
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
    }

    const actions = await admin`
      select action from audit_events
      where workspace_id = ${workspace.id} order by created_at`;
    expect(actions.map((row) => row.action)).toEqual([
      "workspace.created",
      "connection.created",
      "dashboard.created",
    ]);
  }, 60_000);

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
