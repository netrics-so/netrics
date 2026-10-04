import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { workspaceListResponseSchema } from "@netrics/contracts";

import { buildApp } from "../app.js";
import { createAuthService } from "../auth/index.js";
import { loadConfig } from "../env.js";
import { createTestDatabase } from "../test-db.js";
import type { InvitationEmail, LinkEmail, Mailer } from "./mailer.js";

// #255 (ADR 0016 sections 3 and 5): the server picks each email's language
// from the recipient's account, the inviter and the instance default.

interface Sent {
  kind: "verification" | "password-reset" | "invitation";
  email: LinkEmail | InvitationEmail;
}

interface World {
  app: FastifyInstance;
  db: Database;
  admin: Sql;
  sent: Sent[];
}

const worlds: World[] = [];

async function createWorld(env: Record<string, string> = {}): Promise<World> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    NETRICS_SIGNUP: "open",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    ...env,
  });
  const db = createDatabase(testDb.appUrl);
  const sent: Sent[] = [];
  const mailer: Mailer = {
    delivers: true,
    sendVerificationEmail: async (email) => {
      sent.push({ kind: "verification", email });
    },
    sendPasswordResetEmail: async (email) => {
      sent.push({ kind: "password-reset", email });
    },
    sendInvitationEmail: async (email) => {
      sent.push({ kind: "invitation", email });
    },
  };
  const app = await buildApp(config, {
    db,
    mailer,
    checkDb: async () => true,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
      mailer,
    }),
  });
  const world = {
    app,
    db,
    admin: createRawSqlClient(testDb.adminUrl, { max: 1 }),
    sent,
  };
  worlds.push(world);
  return world;
}

afterAll(async () => {
  for (const { app, db, admin } of worlds) {
    await app.close();
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
    await admin.end({ timeout: 5 }).catch(() => undefined);
  }
});

async function signUp(world: World, email: string): Promise<string> {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name: email.split("@")[0], email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

async function setLocale(world: World, email: string, locale: string | null) {
  await world.admin`update users set locale = ${locale} where email = ${email}`;
}

function lastSent(world: World, kind: Sent["kind"], to: string) {
  const found = world.sent.findLast(
    (s) => s.kind === kind && s.email.to === to,
  );
  expect(found).toBeDefined();
  return found!.email;
}

async function requestReset(world: World, email: string) {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/auth/request-password-reset",
    headers: { origin: "http://localhost:3000" },
    payload: { email, redirectTo: "http://localhost:3000/reset-password" },
  });
  expect(response.statusCode).toBe(200);
  return lastSent(world, "password-reset", email);
}

async function requestVerification(world: World, email: string) {
  const response = await world.app.inject({
    method: "POST",
    url: "/api/auth/send-verification-email",
    payload: { email },
  });
  expect(response.statusCode).toBe(200);
  return lastSent(world, "verification", email);
}

describe("verification and password reset emails", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld();
    await signUp(world, "de-user@example.com");
    await signUp(world, "en-user@example.com");
    await signUp(world, "unset-user@example.com");
    await setLocale(world, "de-user@example.com", "de");
    await setLocale(world, "en-user@example.com", "en");
    await setLocale(world, "unset-user@example.com", null);
  }, 60_000);

  it("are written in the recipient's language", async () => {
    expect((await requestReset(world, "de-user@example.com")).locale).toBe(
      "de",
    );
    expect(
      (await requestVerification(world, "de-user@example.com")).locale,
    ).toBe("de");
    expect((await requestReset(world, "en-user@example.com")).locale).toBe(
      "en",
    );
  });

  it("fall back to English without a setting or instance default", async () => {
    expect((await requestReset(world, "unset-user@example.com")).locale).toBe(
      "en",
    );
    expect(
      (await requestVerification(world, "unset-user@example.com")).locale,
    ).toBe("en");
  });
});

describe("with NETRICS_DEFAULT_LOCALE=de", () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld({ NETRICS_DEFAULT_LOCALE: "de" });
    await signUp(world, "unset@example.com");
    await signUp(world, "english@example.com");
    await setLocale(world, "unset@example.com", null);
    await setLocale(world, "english@example.com", "en");
  }, 60_000);

  it("a user without a setting gets the instance default", async () => {
    expect((await requestReset(world, "unset@example.com")).locale).toBe("de");
  });

  it("the user's own setting still wins", async () => {
    expect((await requestReset(world, "english@example.com")).locale).toBe(
      "en",
    );
  });
});

describe("invitation emails", () => {
  let world: World;
  let owner: string;
  let workspaceId: string;

  async function invite(email: string, acceptLanguage?: string) {
    const response = await world.app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/invitations`,
      headers: {
        cookie: owner,
        ...(acceptLanguage ? { "accept-language": acceptLanguage } : {}),
      },
      payload: { email, role: "viewer" },
    });
    expect(response.statusCode).toBe(200);
    return lastSent(world, "invitation", email) as InvitationEmail;
  }

  beforeAll(async () => {
    world = await createWorld();
    owner = await signUp(world, "owner@example.com");
    await world.app.inject({
      method: "POST",
      url: "/v1/bootstrap",
      headers: { cookie: owner },
      payload: { workspaceName: "Acme" },
    });
    const list = await world.app.inject({
      method: "GET",
      url: "/v1/workspaces",
      headers: { cookie: owner },
    });
    workspaceId = workspaceListResponseSchema.parse(list.json()).workspaces[0]!
      .id;
    await signUp(world, "has-account-de@example.com");
    await setLocale(world, "has-account-de@example.com", "de");
  }, 60_000);

  it("use an existing account's language over the inviter's", async () => {
    await setLocale(world, "owner@example.com", "en");
    const email = await invite("has-account-de@example.com", "en");
    expect(email).toMatchObject({
      locale: "de",
      workspaceName: "Acme",
      inviterName: "owner",
    });
  });

  it("use the inviter's setting when the address has no account", async () => {
    await setLocale(world, "owner@example.com", "de");
    expect((await invite("new-1@example.com", "en")).locale).toBe("de");
  });

  it("use the inviter's browser language when the inviter has no setting", async () => {
    await setLocale(world, "owner@example.com", null);
    expect((await invite("new-2@example.com", "de-AT, en;q=0.5")).locale).toBe(
      "de",
    );
    expect((await invite("new-3@example.com")).locale).toBe("en");
  });
});
