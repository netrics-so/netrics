import { readFileSync } from "node:fs";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";

import { workspaceResponseSchema } from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { loadConfig } from "../env.js";
import { addMemberViaInvitation } from "../test-helpers.js";
import { createTestDatabase } from "../test-db.js";

// Test-only: the definition fixtures of the connector SDK (C-G1), read as
// raw JSON documents the way a client would send them.

const FIXTURES = new URL(
  "../../../../packages/connector-sdk/src/custom-api/fixtures/",
  import.meta.url,
);

export function customApiFixture(
  name: "v1-shop" | "v1-all-auth" | "v1-images",
): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`${name}.json`, FIXTURES), "utf8"),
  ) as Record<string, unknown>;
}

/** A JSON call against an app as a signed-in user (cookie). */
export type CustomApiCall = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  cookie: string | null,
  payload?: unknown,
) => Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>;

/**
 * Test-only: an API on a fresh test database with a raw admin client,
 * sign-up and workspace helpers. Options become the API environment.
 */
export interface CustomApiTestApp {
  app: FastifyInstance;
  db: Database;
  admin: Sql;
  call: CustomApiCall;
  signUp(email: string): Promise<string>;
  newWorkspace(cookie: string, name?: string): Promise<string>;
  addMember(
    ownerCookie: string,
    workspaceId: string,
    email: string,
    role: "editor" | "viewer",
  ): Promise<void>;
  close(): Promise<void>;
}

export async function startCustomApiTestApp(
  options: {
    env?: Record<string, string>;
    deps?: Partial<Parameters<typeof buildApp>[1]>;
  } = {},
): Promise<CustomApiTestApp> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
    ...options.env,
  });
  const db = createDatabase(testDb.appUrl);
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  const app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    ...options.deps,
  });
  const admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  const call: CustomApiCall = (method, url, cookie, payload) => {
    const request: InjectOptions = {
      method,
      url,
      headers: cookie ? { cookie } : {},
      ...(payload !== undefined
        ? { payload: payload as Record<string, unknown> }
        : {}),
    };
    return app.inject(request);
  };
  async function signUp(email: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: email, email, password: "password-12345" },
    });
    if (response.statusCode !== 200) throw new Error(response.body);
    const header = response.headers["set-cookie"];
    const cookies = Array.isArray(header) ? header : [header];
    return cookies
      .find((c) => c?.startsWith("better-auth.session_token="))!
      .split(";")[0]!;
  }
  async function newWorkspace(cookie: string, name = "Custom APIs") {
    const response = await call("POST", "/v1/workspaces", cookie, { name });
    return workspaceResponseSchema.parse(response.json()).workspace.id;
  }
  async function addMember(
    ownerCookie: string,
    workspaceId: string,
    email: string,
    role: "editor" | "viewer",
  ) {
    const added = await addMemberViaInvitation(
      app,
      db,
      ownerCookie,
      workspaceId,
      email,
      role,
    );
    if (added.statusCode !== 200) throw new Error(added.body);
  }
  return {
    app,
    db,
    admin,
    call,
    signUp,
    newWorkspace,
    addMember,
    async close() {
      await app.close();
      await db.$client.end({ timeout: 5 }).catch(() => undefined);
      await admin.end({ timeout: 5 }).catch(() => undefined);
    },
  };
}
