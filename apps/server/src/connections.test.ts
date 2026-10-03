import { randomUUID } from "node:crypto";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  auditEventListResponseSchema,
  connectionDetailResponseSchema,
  connectionListResponseSchema,
  connectionPreviewResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  enqueueSyncResponseSchema,
  errorResponseSchema,
  observationListResponseSchema,
  projectResponseSchema,
  workspaceListResponseSchema,
  type WorkspaceRole,
} from "@netrics/contracts";
import { createDefaultRegistry } from "./connectors.js";
import {
  createDatabase,
  createRawSqlClient,
  schema,
  withWorkspace,
  type Database,
  type Job,
  type Sql,
} from "@netrics/database";
import { eq } from "drizzle-orm";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { createCredentialKeyring } from "./credentials.js";
import { loadConfig, type Config } from "./env.js";
import { createJobHandlers } from "./jobs/handlers.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const PLAINTEXT_TOKEN = "s5-super-secret-token";
const registry = createDefaultRegistry();

interface World {
  app: FastifyInstance;
  admin: Sql;
  db: Database;
  config: Config;
  close: () => Promise<void>;
}

async function createWorld(): Promise<World> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  const app = await buildApp(config, {
    db,
    authService,
    registry,
    checkDb: async () => true,
  });
  const admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  return {
    app,
    admin,
    db,
    config,
    close: async () => {
      await app.close();
      await db.$client.end({ timeout: 5 }).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}

function sessionCookie(response: InjectResponse): string {
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const session = cookies.find((c) =>
    c?.startsWith("better-auth.session_token="),
  );
  if (!session) {
    throw new Error("expected a session cookie in the response");
  }
  return session.split(";")[0]!;
}

async function signUpUser(
  app: FastifyInstance,
  email: string,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

interface Call {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  cookie?: string;
  payload?: unknown;
}

function call(
  app: FastifyInstance,
  { method, url, cookie, payload }: Call,
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

function expectError(response: InjectResponse, code: number, error: string) {
  expect(response.statusCode).toBe(code);
  expect(errorResponseSchema.parse(response.json())).toEqual({ error });
}

/** Runs one engine pass for the connection, like a claimed worker job. */
async function runEngine(
  world: World,
  kind: "connection.backfill" | "connection.sync",
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  const handlers = createJobHandlers({
    registry,
    credentialKeyring: createCredentialKeyring(world.config.appEncryptionKey),
  });
  const job: Job = {
    id: randomUUID(),
    kind,
    workspaceId,
    connectionId,
    payload: { workspace_id: workspaceId, connection_id: connectionId },
    runAt: new Date(),
    attempts: 0,
    maxAttempts: 8,
    status: "running",
    lockedBy: "test",
    lockedAt: new Date(),
    lastError: null,
    idempotencyKey: null,
    createdAt: new Date(),
  };
  await handlers[kind]!({
    job,
    appDb: world.db,
    schedulerDb: world.db,
    logger: pino({ level: "silent" }),
  });
}

type UserKey = "owner" | "viewer" | "editor";
let world: World;
const cookies = {} as Record<UserKey, string>;
let w1Id: string;
let w2Id: string;
let projectId: string;
let connectionId: string;
let editorConnectionId: string;
let otherConnectionId: string;

async function addMember(
  cookie: string,
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
) {
  return addMemberViaInvitation(
    world.app,
    world.db,
    cookie,
    workspaceId,
    email,
    role,
  );
}

async function createConnection(
  cookie: string,
  workspaceId: string,
  payload: Record<string, unknown>,
) {
  return call(world.app, {
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/connections`,
    cookie,
    payload,
  });
}

beforeAll(async () => {
  world = await createWorld();
  for (const [key, email] of [
    ["owner", "conn-owner@example.com"],
    ["viewer", "conn-viewer@example.com"],
    ["editor", "conn-editor@example.com"],
  ] as const) {
    cookies[key] = await signUpUser(world.app, email, key);
  }
  const bootstrapped = await call(world.app, {
    method: "POST",
    url: "/v1/bootstrap",
    cookie: cookies.owner,
    payload: { workspaceName: "Conn Workspace" },
  });
  expect(bootstrapped.statusCode).toBe(200);
  const workspaces = workspaceListResponseSchema.parse(
    (
      await call(world.app, {
        method: "GET",
        url: "/v1/workspaces",
        cookie: cookies.owner,
      })
    ).json(),
  );
  w1Id = workspaces.workspaces[0]!.id;
  expect(
    (await addMember(cookies.owner, w1Id, "conn-viewer@example.com", "viewer"))
      .statusCode,
  ).toBe(200);
  expect(
    (await addMember(cookies.owner, w1Id, "conn-editor@example.com", "editor"))
      .statusCode,
  ).toBe(200);
  const project = await call(world.app, {
    method: "POST",
    url: `/v1/workspaces/${w1Id}/projects`,
    cookie: cookies.owner,
    payload: { name: "Website" },
  });
  projectId = projectResponseSchema.parse(project.json()).project.id;
}, 60_000);

afterAll(async () => {
  await world.close();
});

describe("GET /v1/connectors", () => {
  it("lists the deployed bundle for any authenticated user", async () => {
    const response = await call(world.app, {
      method: "GET",
      url: "/v1/connectors",
      cookie: cookies.viewer,
    });
    expect(response.statusCode).toBe(200);
    const { connectors } = connectorListResponseSchema.parse(response.json());
    const demo = connectors.find((c) => c.id === "demo");
    expect(demo).toMatchObject({
      name: "Demo Connector",
      metricsCount: 2,
      supportsBackfill: true,
      authStrategies: [{ strategy: "none" }],
    });
    expect(demo!.configSchema).toMatchObject({ type: "object" });
  });

  it("carries the token field's label, help and setup steps", async () => {
    const response = await call(world.app, {
      method: "GET",
      url: "/v1/connectors",
      cookie: cookies.viewer,
    });
    const { connectors } = connectorListResponseSchema.parse(response.json());
    const vercel = connectors.find((c) => c.id === "vercel");
    expect(vercel?.authStrategies).toEqual([
      {
        strategy: "token",
        tokenLabel: "Vercel access token",
        tokenDescription: expect.stringContaining("stored encrypted"),
        setup: {
          steps: expect.arrayContaining([
            expect.stringContaining("Account Settings → Tokens"),
          ]),
          url: "https://vercel.com/account/settings/tokens",
        },
      },
    ]);
    // The credentials schema itself stays server-side.
    expect(JSON.stringify(vercel)).not.toContain("credentialsSchema");
  });

  it("requires a session", async () => {
    expectError(
      await call(world.app, { method: "GET", url: "/v1/connectors" }),
      401,
      "unauthorized",
    );
  });
});

describe("connection lifecycle", () => {
  it("creates a demo connection and enqueues the backfill in the same transaction", async () => {
    const response = await createConnection(cookies.owner, w1Id, {
      connectorId: "demo",
      name: "Demo Metrics",
      config: { seed: 5, resources: 2 },
      credentials: { token: PLAINTEXT_TOKEN },
      projectId,
      resources: ["demo-site-1", "demo-site-2"],
    });
    expect(response.statusCode).toBe(200);
    const { connection } = connectionResponseSchema.parse(response.json());
    connectionId = connection.id;
    expect(connection).toMatchObject({
      name: "Demo Metrics",
      connectorId: "demo",
      connectorName: "Demo Connector",
      projectId,
      hasCredentials: true,
    });
    // Manifest defaults are applied and the reserved resource-selection key
    // is not echoed back as config.
    expect(connection.config).toMatchObject({ seed: 5, resources: 2 });
    expect(connection.config.resourceSelection).toBeUndefined();
    expect(connection.state).toMatchObject({
      health: "pending",
      authState: "ok",
      consecutiveFailures: 0,
      lastSuccessAt: null,
    });
    expect(connection.state.pollIntervalSeconds).toBe(300);
    expect(connection.state.nextDueAt).not.toBeNull();

    const jobs = await world.admin`
      select kind, workspace_id::text as workspace_id, connection_id::text as connection_id, status
      from jobs where connection_id = ${connectionId}::uuid
    `;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: "connection.backfill",
      workspace_id: w1Id,
      connection_id: connectionId,
      status: "pending",
    });
  });

  it("never leaks credentials in any response", async () => {
    const bodies: unknown[] = [];
    const detail = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
      cookie: cookies.owner,
    });
    bodies.push(detail.json());
    const list = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}/connections`,
      cookie: cookies.viewer,
    });
    bodies.push(list.json());
    const patched = await call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
      cookie: cookies.owner,
      payload: { name: "Demo Metrics Renamed" },
    });
    expect(patched.statusCode).toBe(200);
    bodies.push(patched.json());
    for (const body of bodies) {
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(PLAINTEXT_TOKEN);
      expect(serialized).not.toContain("credentialsEncrypted");
      expect(serialized).not.toContain("credentials_encrypted");
      expect(serialized).not.toContain('"credentials"');
    }
  });

  it("appears in the list with connector metadata for all roles", async () => {
    const response = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}/connections`,
      cookie: cookies.viewer,
    });
    expect(response.statusCode).toBe(200);
    const { connections } = connectionListResponseSchema.parse(response.json());
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: connectionId,
      name: "Demo Metrics Renamed",
      connectorName: "Demo Connector",
      connectorVersion: "0.1.0",
    });
  });

  it("rejects bad credentials with the connector's actionable message and persists nothing", async () => {
    const response = await createConnection(cookies.owner, w1Id, {
      connectorId: "demo",
      name: "Broken",
      config: { simulate: "bad-credentials" },
    });
    expect(response.statusCode).toBe(400);
    const { error } = errorResponseSchema.parse(response.json());
    expect(error).toMatch(/credentials/i);

    const list = connectionListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections`,
          cookie: cookies.owner,
        })
      ).json(),
    );
    expect(list.connections).toHaveLength(1);

    const jobs = await world.admin`
      select count(*)::int as count from jobs
      where kind = 'connection.backfill' and workspace_id = ${w1Id}::uuid
    `;
    expect(jobs[0]!.count).toBe(1);
  });

  it("rejects invalid config, unknown connectors, and foreign projects", async () => {
    const badKey = await createConnection(cookies.owner, w1Id, {
      connectorId: "demo",
      name: "x",
      config: { bogus: 1 },
    });
    expect(badKey.statusCode).toBe(400);

    const badType = await createConnection(cookies.owner, w1Id, {
      connectorId: "demo",
      name: "x",
      config: { seed: "five" },
    });
    expect(badType.statusCode).toBe(400);
    expect(errorResponseSchema.parse(badType.json()).error).toMatch(
      /seed must be an integer/,
    );

    expectError(
      await createConnection(cookies.owner, w1Id, {
        connectorId: "nope",
        name: "x",
      }),
      400,
      "invalid_request",
    );

    expectError(
      await createConnection(cookies.owner, w1Id, {
        connectorId: "demo",
        name: "x",
        projectId: randomUUID(),
      }),
      404,
      "project_not_found",
    );
  });

  it("previews check + discover without persisting", async () => {
    const response = await call(world.app, {
      method: "POST",
      url: `/v1/workspaces/${w1Id}/connections/preview`,
      cookie: cookies.editor,
      payload: { connectorId: "demo", config: { resources: 2 } },
    });
    expect(response.statusCode).toBe(200);
    const preview = connectionPreviewResponseSchema.parse(response.json());
    expect(preview.check.ok).toBe(true);
    expect(preview.resources.map((r) => r.id)).toEqual([
      "demo-site-1",
      "demo-site-2",
    ]);

    const failed = await call(world.app, {
      method: "POST",
      url: `/v1/workspaces/${w1Id}/connections/preview`,
      cookie: cookies.editor,
      payload: { connectorId: "demo", config: { simulate: "bad-credentials" } },
    });
    expect(failed.statusCode).toBe(200);
    const failedPreview = connectionPreviewResponseSchema.parse(failed.json());
    expect(failedPreview.check.ok).toBe(false);
    expect(failedPreview.check.message).toMatch(/credentials/i);
    expect(failedPreview.resources).toEqual([]);

    // Nothing was persisted by either preview.
    const list = connectionListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections`,
          cookie: cookies.owner,
        })
      ).json(),
    );
    expect(list.connections).toHaveLength(1);
  });
});

describe("engine run and observations", () => {
  it("serves observations after the backfill ran", async () => {
    await runEngine(world, "connection.backfill", w1Id, connectionId);

    const response = await call(world.app, {
      method: "GET",
      url: `/v1/workspaces/${w1Id}/connections/${connectionId}/observations`,
      cookie: cookies.viewer,
    });
    expect(response.statusCode).toBe(200);
    const { observations } = observationListResponseSchema.parse(
      response.json(),
    );
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.length).toBeLessThanOrEqual(200);
    for (const observation of observations) {
      expect(["demo.visitors", "demo.signups"]).toContain(
        observation.metricKey,
      );
      expect(observation.dimensions.resource).toMatch(/^demo-site-[12]$/);
    }
    const timestamps = observations.map((o) => Date.parse(o.sourceTimestamp));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));

    const filtered = observationListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections/${connectionId}/observations?metricKey=demo.signups&limit=5`,
          cookie: cookies.viewer,
        })
      ).json(),
    );
    expect(filtered.observations).toHaveLength(5);
    expect(
      filtered.observations.every((o) => o.metricKey === "demo.signups"),
    ).toBe(true);

    const ranged = observationListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections/${connectionId}/observations?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`,
          cookie: cookies.viewer,
        })
      ).json(),
    );
    expect(ranged.observations).toHaveLength(0);

    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/connections/${connectionId}/observations?limit=1001`,
        cookie: cookies.viewer,
      }),
      400,
      "invalid_request",
    );

    // Detail now reflects the successful run.
    const detail = connectionDetailResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
          cookie: cookies.viewer,
        })
      ).json(),
    );
    expect(detail.connection.state).toMatchObject({
      health: "ok",
      authState: "ok",
    });
    expect(detail.connection.state.lastSuccessAt).not.toBeNull();
    expect(detail.syncRuns.length).toBeGreaterThan(0);
    expect(detail.syncRuns[0]).toMatchObject({
      mode: "backfill",
      status: "succeeded",
      attempt: 1,
    });
    expect(detail.syncRuns[0]!.observationsWritten).toBeGreaterThan(0);
  });

  it("enqueues a manual sync", async () => {
    const response = await call(world.app, {
      method: "POST",
      url: `/v1/workspaces/${w1Id}/connections/${connectionId}/sync`,
      cookie: cookies.editor,
    });
    expect(response.statusCode).toBe(200);
    const { jobId } = enqueueSyncResponseSchema.parse(response.json());
    const jobs = await world.admin`
      select kind, status from jobs where id = ${jobId}::uuid
    `;
    expect(jobs).toEqual([{ kind: "connection.sync", status: "pending" }]);

    // Asking again while that sync still waits reuses it.
    const again = await call(world.app, {
      method: "POST",
      url: `/v1/workspaces/${w1Id}/connections/${connectionId}/sync`,
      cookie: cookies.editor,
    });
    expect(enqueueSyncResponseSchema.parse(again.json()).jobId).toBe(jobId);
  });
});

describe("credential recovery", () => {
  it("shows a token rejected before the first successful sync as auth_failed", async () => {
    await withWorkspace(world.db, { workspaceId: w1Id }, async (tx) => {
      await tx
        .update(schema.connectionState)
        .set({ authState: "auth_failed", lastSuccessAt: null })
        .where(eq(schema.connectionState.connectionId, connectionId));
    });
    const { connection } = connectionDetailResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
          cookie: cookies.owner,
        })
      ).json(),
    );
    expect(connection.state).toMatchObject({
      health: "auth_failed",
      lastSuccessAt: null,
    });
  });

  it("resets auth_failed state when new credentials are saved", async () => {
    // Seed an auth_failed state (as a failed engine run would).
    await withWorkspace(world.db, { workspaceId: w1Id }, async (tx) => {
      await tx
        .update(schema.connectionState)
        .set({ authState: "auth_failed", consecutiveFailures: 3 })
        .where(eq(schema.connectionState.connectionId, connectionId));
    });
    const before = connectionDetailResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
          cookie: cookies.owner,
        })
      ).json(),
    );
    expect(before.connection.state).toMatchObject({
      health: "auth_failed",
      authState: "auth_failed",
      consecutiveFailures: 3,
    });

    const patched = await call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
      cookie: cookies.owner,
      payload: { credentials: { token: "s5-new-token" } },
    });
    expect(patched.statusCode).toBe(200);
    const { connection } = connectionResponseSchema.parse(patched.json());
    expect(connection.state).toMatchObject({
      authState: "ok",
      consecutiveFailures: 0,
    });
    expect(Date.parse(connection.state.nextDueAt!)).toBeLessThanOrEqual(
      Date.now(),
    );

    // Bad replacement credentials are rejected and leave the state untouched.
    const rejected = await call(world.app, {
      method: "PATCH",
      url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
      cookie: cookies.owner,
      payload: {
        credentials: { token: "x" },
        config: { simulate: "bad-credentials" },
      },
    });
    expect(rejected.statusCode).toBe(400);

    const events = auditEventListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/audit-events`,
          cookie: cookies.owner,
        })
      ).json(),
    );
    expect(
      events.events.some(
        (e) =>
          e.action === "connection.credentials_updated" &&
          e.target === connectionId,
      ),
    ).toBe(true);
  });
});

describe("role matrix", () => {
  it("viewers are read-only", async () => {
    expect(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
          cookie: cookies.viewer,
        })
      ).statusCode,
    ).toBe(200);
    expectError(
      await createConnection(cookies.viewer, w1Id, {
        connectorId: "demo",
        name: "x",
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "POST",
        url: `/v1/workspaces/${w1Id}/connections/preview`,
        cookie: cookies.viewer,
        payload: { connectorId: "demo" },
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
        cookie: cookies.viewer,
        payload: { name: "hijack" },
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/connections/${connectionId}`,
        cookie: cookies.viewer,
      }),
      403,
      "forbidden",
    );
    expectError(
      await call(world.app, {
        method: "POST",
        url: `/v1/workspaces/${w1Id}/connections/${connectionId}/sync`,
        cookie: cookies.viewer,
      }),
      403,
      "forbidden",
    );
  });

  it("editors can create and update but not delete", async () => {
    const created = await createConnection(cookies.editor, w1Id, {
      connectorId: "demo",
      name: "Editor Connection",
      config: { seed: 9 },
    });
    expect(created.statusCode).toBe(200);
    editorConnectionId = connectionResponseSchema.parse(created.json())
      .connection.id;

    expect(
      (
        await call(world.app, {
          method: "PATCH",
          url: `/v1/workspaces/${w1Id}/connections/${editorConnectionId}`,
          cookie: cookies.editor,
          payload: { name: "Editor Connection v2" },
        })
      ).statusCode,
    ).toBe(200);
    expectError(
      await call(world.app, {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/connections/${editorConnectionId}`,
        cookie: cookies.editor,
      }),
      403,
      "forbidden",
    );
  });
});

describe("cross-workspace isolation", () => {
  beforeAll(async () => {
    const created = await call(world.app, {
      method: "POST",
      url: "/v1/workspaces",
      cookie: cookies.owner,
      payload: { name: "Other Workspace" },
    });
    expect(created.statusCode).toBe(200);
    w2Id = workspaceListResponseSchema
      .parse(
        (
          await call(world.app, {
            method: "GET",
            url: "/v1/workspaces",
            cookie: cookies.owner,
          })
        ).json(),
      )
      .workspaces.find((w) => w.name === "Other Workspace")!.id;
    const connection = await createConnection(cookies.owner, w2Id, {
      connectorId: "demo",
      name: "Other Connection",
    });
    expect(connection.statusCode).toBe(200);
    otherConnectionId = connectionResponseSchema.parse(connection.json())
      .connection.id;
  });

  it("connection ids from another workspace are 404, even for a shared member", async () => {
    for (const req of [
      {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/connections/${otherConnectionId}`,
      },
      {
        method: "PATCH",
        url: `/v1/workspaces/${w1Id}/connections/${otherConnectionId}`,
        payload: { name: "hijack" },
      },
      {
        method: "DELETE",
        url: `/v1/workspaces/${w1Id}/connections/${otherConnectionId}`,
      },
      {
        method: "POST",
        url: `/v1/workspaces/${w1Id}/connections/${otherConnectionId}/sync`,
      },
      {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/connections/${otherConnectionId}/observations`,
      },
    ] as const) {
      expectError(
        await call(world.app, { ...req, cookie: cookies.owner }),
        404,
        "connection_not_found",
      );
    }
    // Malformed ids are 404, not 400/500.
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/connections/not-a-uuid`,
        cookie: cookies.owner,
      }),
      404,
      "connection_not_found",
    );
  });

  it("non-members get workspace_not_found for connection routes", async () => {
    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w2Id}/connections`,
        cookie: cookies.viewer,
      }),
      404,
      "workspace_not_found",
    );
  });
});

describe("delete", () => {
  it("cascades state, observations, and sync runs", async () => {
    await runEngine(world, "connection.backfill", w1Id, editorConnectionId);
    const counts = await world.admin`
      select
        (select count(*)::int from connection_state where connection_id = ${editorConnectionId}::uuid) as state,
        (select count(*)::int from observations where connection_id = ${editorConnectionId}::uuid) as observations,
        (select count(*)::int from sync_runs where connection_id = ${editorConnectionId}::uuid) as sync_runs
    `;
    expect(counts[0]).toMatchObject({ state: 1 });
    expect(counts[0]!.observations).toBeGreaterThan(0);
    expect(counts[0]!.sync_runs).toBeGreaterThan(0);

    const response = await call(world.app, {
      method: "DELETE",
      url: `/v1/workspaces/${w1Id}/connections/${editorConnectionId}`,
      cookie: cookies.owner,
    });
    expect(response.statusCode).toBe(200);
    // Not an OAuth connection: nothing to revoke.
    expect(response.json()).toEqual({ revocation: null });

    const after = await world.admin`
      select
        (select count(*)::int from connections where id = ${editorConnectionId}::uuid) as connection,
        (select count(*)::int from connection_state where connection_id = ${editorConnectionId}::uuid) as state,
        (select count(*)::int from observations where connection_id = ${editorConnectionId}::uuid) as observations,
        (select count(*)::int from sync_runs where connection_id = ${editorConnectionId}::uuid) as sync_runs,
        (select count(*)::int from jobs where connection_id = ${editorConnectionId}::uuid and status in ('pending', 'running')) as live_jobs,
        (select count(*)::int from jobs where workspace_id = ${w1Id}::uuid and connection_id is null and status = 'failed' and last_error = 'connection deleted') as cancelled_jobs
    `;
    expect(after[0]).toMatchObject({
      connection: 0,
      state: 0,
      observations: 0,
      sync_runs: 0,
      live_jobs: 0,
    });
    expect(after[0]!.cancelled_jobs).toBeGreaterThan(0);

    expectError(
      await call(world.app, {
        method: "GET",
        url: `/v1/workspaces/${w1Id}/connections/${editorConnectionId}`,
        cookie: cookies.owner,
      }),
      404,
      "connection_not_found",
    );

    const events = auditEventListResponseSchema.parse(
      (
        await call(world.app, {
          method: "GET",
          url: `/v1/workspaces/${w1Id}/audit-events`,
          cookie: cookies.owner,
        })
      ).json(),
    );
    expect(
      events.events.some(
        (e) =>
          e.action === "connection.deleted" && e.target === editorConnectionId,
      ),
    ).toBe(true);
  });
});
