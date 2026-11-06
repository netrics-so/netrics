import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  errorResponseSchema,
  meResponseSchema,
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
import { ConfigError, loadConfig } from "./env.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

// #250 (ADR 0016): the user's language, the workspace's screen language and
// the instance default.

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

interface World {
  app: FastifyInstance;
  db: Database;
  admin: Sql;
  close(): Promise<void>;
}

async function createWorld(env: Record<string, string> = {}): Promise<World> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    ...env,
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
    db,
    admin,
    async close() {
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
    throw new Error("expected a session cookie");
  }
  return session.split(";")[0]!;
}

async function signUp(
  world: World,
  email: string,
  acceptLanguage?: string,
): Promise<string> {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: acceptLanguage ? { "accept-language": acceptLanguage } : {},
    payload: { name: email.split("@")[0], email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

async function storedLocale(world: World, email: string) {
  const [row] = await world.admin`
    select locale from users where email = ${email}`;
  return row!.locale as string | null;
}

async function me(world: World, cookie: string) {
  const response = await world.app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return meResponseSchema.parse(response.json());
}

function patchMe(world: World, cookie: string, payload: unknown) {
  return world.app.inject({
    method: "PATCH",
    url: "/v1/me",
    headers: { cookie },
    payload: payload as Record<string, unknown>,
  });
}

function expectError(response: InjectResponse, code: number, error: string) {
  expect(response.statusCode).toBe(code);
  expect(errorResponseSchema.parse(response.json())).toEqual({ error });
}

describe("instance default language", () => {
  it("accepts en and de and refuses anything else", () => {
    const base = { LOG_LEVEL: "silent" };
    expect(loadConfig(base).defaultLocale).toBeNull();
    expect(
      loadConfig({ ...base, NETRICS_DEFAULT_LOCALE: "" }).defaultLocale,
    ).toBeNull();
    expect(
      loadConfig({ ...base, NETRICS_DEFAULT_LOCALE: "de" }).defaultLocale,
    ).toBe("de");
    expect(() => loadConfig({ ...base, NETRICS_DEFAULT_LOCALE: "fr" })).toThrow(
      ConfigError,
    );
  });
});

describe("user language", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld();
  }, 30_000);
  afterAll(async () => world.close());

  it("starts in the browser's language at sign-up, else English", async () => {
    await signUp(world, "anna@example.com", "de-AT,de;q=0.9,en;q=0.5");
    await signUp(world, "fran@example.com", "fr-FR, en;q=0.4");
    await signUp(world, "noone@example.com");
    expect(await storedLocale(world, "anna@example.com")).toBe("de");
    expect(await storedLocale(world, "fran@example.com")).toBe("en");
    expect(await storedLocale(world, "noone@example.com")).toBe("en");
  });

  it("is returned by GET /v1/me and changed by PATCH /v1/me", async () => {
    const cookie = await signUp(world, "lena@example.com", "de");
    const other = await signUp(world, "otto@example.com", "de");
    expect((await me(world, cookie)).user.locale).toBe("de");

    const changed = await patchMe(world, cookie, { locale: "en" });
    expect(changed.statusCode).toBe(200);
    expect(meResponseSchema.parse(changed.json()).user.locale).toBe("en");
    expect((await me(world, cookie)).user.locale).toBe("en");
    // Only the caller's row.
    expect((await me(world, other)).user.locale).toBe("de");

    const cleared = await patchMe(world, cookie, { locale: null });
    expect(meResponseSchema.parse(cleared.json()).user.locale).toBeNull();
    expect(await storedLocale(world, "lena@example.com")).toBeNull();
  });

  it("refuses unsupported languages and anonymous callers", async () => {
    const cookie = await signUp(world, "val@example.com");
    expectError(
      await patchMe(world, cookie, { locale: "fr" }),
      400,
      "invalid_request",
    );
    expectError(await patchMe(world, cookie, {}), 400, "invalid_request");
    expectError(
      await world.app.inject({
        method: "PATCH",
        url: "/v1/me",
        payload: { locale: "de" },
      }),
      401,
      "unauthorized",
    );
  });

  it("reads a language this version does not speak as unset", async () => {
    const cookie = await signUp(world, "old@example.com");
    await world.admin`update users set locale = 'fr' where email = 'old@example.com'`;
    expect((await me(world, cookie)).user.locale).toBeNull();
  });
});

describe("instance default at sign-up", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld({ NETRICS_DEFAULT_LOCALE: "de" });
  }, 30_000);
  afterAll(async () => world.close());

  it("comes before the browser's language", async () => {
    await signUp(world, "eve@example.com", "en-US,en;q=0.9");
    expect(await storedLocale(world, "eve@example.com")).toBe("de");
  });
});

describe("workspace screen language", () => {
  let world: World;
  let ownerCookie: string;
  let memberCookie: string;
  let workspaceId: string;

  beforeAll(async () => {
    world = await createWorld();
    ownerCookie = await signUp(world, "owner@example.com");
    memberCookie = await signUp(world, "member@example.com");
    const created = await world.app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { cookie: ownerCookie },
      payload: { name: "Studio" },
    });
    expect(created.statusCode).toBe(200);
    workspaceId = workspaceResponseSchema.parse(created.json()).workspace.id;
    await addMemberViaInvitation(
      world.app,
      world.db,
      ownerCookie,
      workspaceId,
      "member@example.com",
      "editor",
    );
  }, 30_000);
  afterAll(async () => world.close());

  function patchWorkspace(cookie: string, payload: unknown) {
    return world.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie },
      payload: payload as Record<string, unknown>,
    });
  }

  it("is unset for a new workspace and set by an owner, audited", async () => {
    const before = await world.app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}`,
      headers: { cookie: ownerCookie },
    });
    expect(
      workspaceResponseSchema.parse(before.json()).workspace.screenLocale,
    ).toBeNull();

    const set = await patchWorkspace(ownerCookie, { screenLocale: "de" });
    expect(set.statusCode).toBe(200);
    expect(workspaceResponseSchema.parse(set.json()).workspace).toMatchObject({
      name: "Studio",
      screenLocale: "de",
    });
    // Unchanged value: no second audit event.
    await patchWorkspace(ownerCookie, { screenLocale: "de" });
    const events = await world.admin`
      select metadata from audit_events
      where workspace_id = ${workspaceId}
        and action = 'workspace.screen_locale_changed'`;
    expect(events.map((event) => event.metadata)).toEqual([
      { oldScreenLocale: null, newScreenLocale: "de" },
    ]);

    const cleared = await patchWorkspace(ownerCookie, { screenLocale: null });
    expect(
      workspaceResponseSchema.parse(cleared.json()).workspace.screenLocale,
    ).toBeNull();
  });

  it("refuses unsupported languages and members without the right", async () => {
    expectError(
      await patchWorkspace(ownerCookie, { screenLocale: "fr" }),
      400,
      "invalid_request",
    );
    expectError(
      await patchWorkspace(memberCookie, { screenLocale: "de" }),
      403,
      "forbidden",
    );
  });
});
