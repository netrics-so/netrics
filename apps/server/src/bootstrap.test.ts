import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapResponseSchema,
  errorResponseSchema,
  meResponseSchema,
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
import { createTestDatabase } from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

interface World {
  app: FastifyInstance;
  admin: Sql;
  db: Database;
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
    checkDb: async () => true,
  });
  const admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  return {
    app,
    admin,
    db,
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

function bootstrap(
  app: FastifyInstance,
  cookie: string,
  workspaceName: string,
) {
  return app.inject({
    method: "POST",
    url: "/v1/bootstrap",
    headers: { cookie },
    payload: { workspaceName },
  });
}

describe("POST /v1/bootstrap", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld();
  }, 30_000);

  afterAll(async () => {
    await world.close();
  });

  it("requires a session", async () => {
    const response = await world.app.inject({
      method: "POST",
      url: "/v1/bootstrap",
      payload: { workspaceName: "Acme" },
    });
    expect(response.statusCode).toBe(401);
    expect(errorResponseSchema.parse(response.json())).toEqual({
      error: "unauthorized",
    });
  });

  it("creates the first workspace with the caller as owner", async () => {
    const cookie = await signUpUser(world.app, "owner@example.com", "Owner");
    const response = await bootstrap(world.app, cookie, "Acme");
    expect(response.statusCode).toBe(200);
    const { workspace } = bootstrapResponseSchema.parse(response.json());
    expect(workspace.name).toBe("Acme");

    const me = await world.app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie },
    });
    expect(me.statusCode).toBe(200);
    const payload = meResponseSchema.parse(me.json());
    expect(payload.memberships).toEqual([
      { workspaceId: workspace.id, workspaceName: "Acme", role: "owner" },
    ]);

    const audit = await world.admin`
      select workspace_id, actor_user_id, action from audit_events
      where action = 'workspace.bootstrap'
    `;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.workspace_id).toBe(workspace.id);
    expect(audit[0]!.actor_user_id).toBe(payload.user.id);
  });

  it("rejects a second bootstrap, even from a different user", async () => {
    const cookie = await signUpUser(world.app, "late@example.com", "Late");
    const response = await bootstrap(world.app, cookie, "Too Late");
    expect(response.statusCode).toBe(409);
    expect(errorResponseSchema.parse(response.json())).toEqual({
      error: "workspace_already_exists",
    });
  });
});

describe("concurrent bootstrap", () => {
  it("lets exactly one of two racing users win", async () => {
    const world = await createWorld();
    try {
      const cookieA = await signUpUser(world.app, "race-a@example.com", "A");
      const cookieB = await signUpUser(world.app, "race-b@example.com", "B");

      const [a, b] = await Promise.all([
        bootstrap(world.app, cookieA, "Workspace A"),
        bootstrap(world.app, cookieB, "Workspace B"),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      const workspaces = await world.admin`select id from workspaces`;
      expect(workspaces).toHaveLength(1);
    } finally {
      await world.close();
    }
  }, 30_000);
});
