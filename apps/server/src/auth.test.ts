import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { errorResponseSchema, meResponseSchema } from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import type { Mailer } from "./mail/mailer.js";
import { loadConfig, type Config } from "./env.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

interface CapturedEmail {
  kind: "verification" | "password-reset";
  to: string;
  url: string;
}

const sentEmails: CapturedEmail[] = [];

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

const capturingMailer: Mailer = {
  delivers: true,
  async sendVerificationEmail({ to, url }) {
    sentEmails.push({ kind: "verification", to, url });
  },
  async sendPasswordResetEmail({ to, url }) {
    sentEmails.push({ kind: "password-reset", to, url });
  },
  async sendInvitationEmail() {},
};

let testDb: TestDatabase;
let config: Config;
let db: Database;
let app: FastifyInstance;
let admin: Sql;

/** Sign-up auto-signs in; returns the session cookie (or null). */
async function signUp(
  email: string,
  password: string,
  name: string,
): Promise<string | null> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

async function signIn(
  email: string,
  password: string,
): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password },
  });
}

function sessionCookie(response: InjectResponse): string | null {
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  const session = cookies.find((c) =>
    c?.startsWith("better-auth.session_token="),
  );
  return session?.split(";")[0] ?? null;
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
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
    mailer: capturingMailer,
  });
  app = await buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
}, 30_000);

afterAll(async () => {
  await app.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin.end({ timeout: 5 }).catch(() => undefined);
});

describe("sign-up", () => {
  it("creates an auth session and provisions the domain user", async () => {
    const cookie = await signUp("alice@example.com", "password-12345", "Alice");
    expect(cookie).toBeTruthy();

    const rows = await admin`
      select auth_user_id, email, display_name from users
      where email = 'alice@example.com'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.auth_user_id).toBeTruthy();
    expect(rows[0]!.display_name).toBe("Alice");
  });

  it("defaults the display name to the email local part", async () => {
    await signUp("local-part@example.com", "password-12345", "   ");
    const rows = await admin`
      select display_name from users where email = 'local-part@example.com'
    `;
    // better-auth falls back to the local part when the name is blank; the
    // domain provisioning does the same if it ever receives one.
    expect(rows[0]!.display_name).toBe("local-part");
  });
});

describe("sign-in", () => {
  it("rejects a wrong password and accepts the right one", async () => {
    await signUp("bob@example.com", "password-12345", "Bob");

    const wrong = await signIn("bob@example.com", "wrong-password-1");
    expect(wrong.statusCode).toBe(401);

    const right = await signIn("bob@example.com", "password-12345");
    expect(right.statusCode).toBe(200);
    expect(sessionCookie(right)).toBeTruthy();
  });
});

describe("GET /v1/me", () => {
  it("returns 401 without a session cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/me" });
    expect(response.statusCode).toBe(401);
    expect(errorResponseSchema.parse(response.json())).toEqual({
      error: "unauthorized",
    });
  });

  it("returns the identity with empty memberships before bootstrap", async () => {
    const cookie = await signUp("carol@example.com", "password-12345", "Carol");
    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookie! },
    });
    expect(response.statusCode).toBe(200);
    const me = meResponseSchema.parse(response.json());
    expect(me.user.email).toBe("carol@example.com");
    expect(me.user.displayName).toBe("Carol");
    expect(me.memberships).toEqual([]);
  });
});

describe("session revocation", () => {
  it("sign-out invalidates the session immediately", async () => {
    const cookie = await signUp("dave@example.com", "password-12345", "Dave");

    const before = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookie! },
    });
    expect(before.statusCode).toBe(200);

    const signOut = await app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      // A browser sends its origin; better-auth checks it on cookie requests.
      headers: { cookie: cookie!, origin: "http://localhost:3000" },
    });
    expect(signOut.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookie! },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("auth emails (dev mailer)", () => {
  it("logs the verification URL via the injected mailer", async () => {
    await signUp("erin@example.com", "password-12345", "Erin");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/send-verification-email",
      payload: { email: "erin@example.com" },
    });
    expect(response.statusCode).toBe(200);
    const mail = sentEmails.find(
      (m) => m.kind === "verification" && m.to === "erin@example.com",
    );
    expect(mail?.url).toContain("http://localhost:3001");
  });

  it("logs the password-reset URL via the injected mailer", async () => {
    await signUp("frank@example.com", "password-12345", "Frank");
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      payload: { email: "frank@example.com" },
    });
    expect(response.statusCode).toBe(200);
    const mail = sentEmails.find(
      (m) => m.kind === "password-reset" && m.to === "frank@example.com",
    );
    expect(mail?.url).toContain("http://localhost:3001");
  });
});

describe("password reset", () => {
  const webOrigin = "http://localhost:3000";

  function requestReset(
    email: string,
    redirectTo = `${webOrigin}/reset-password`,
  ) {
    return app.inject({
      method: "POST",
      url: "/api/auth/request-password-reset",
      headers: { origin: webOrigin },
      payload: { email, redirectTo },
    });
  }

  function resetPassword(token: string, newPassword: string) {
    return app.inject({
      method: "POST",
      url: "/api/auth/reset-password",
      headers: { origin: webOrigin },
      payload: { token, newPassword },
    });
  }

  it("resets the password through the emailed link", async () => {
    const cookie = await signUp("grace@example.com", "old-password-1", "Grace");

    const requested = await requestReset("grace@example.com");
    expect(requested.statusCode).toBe(200);
    const mail = sentEmails.findLast(
      (m) => m.kind === "password-reset" && m.to === "grace@example.com",
    );
    expect(mail).toBeDefined();

    // The link points at BETTER_AUTH_URL and carries the web page as callback.
    const link = new URL(mail!.url);
    expect(link.origin).toBe("http://localhost:3001");
    expect(link.pathname).toMatch(/^\/api\/auth\/reset-password\/[^/]+$/);
    expect(link.searchParams.get("callbackURL")).toBe(
      `${webOrigin}/reset-password`,
    );

    // Opening it redirects to the web page with the token in the query.
    const opened = await app.inject({
      method: "GET",
      url: `${link.pathname}${link.search}`,
    });
    expect(opened.statusCode).toBe(302);
    const target = new URL(String(opened.headers.location));
    expect(`${target.origin}${target.pathname}`).toBe(
      `${webOrigin}/reset-password`,
    );
    const token = target.searchParams.get("token");
    expect(token).toBe(link.pathname.split("/").pop());

    const reset = await resetPassword(token!, "new-password-2");
    expect(reset.statusCode).toBe(200);

    expect(
      (await signIn("grace@example.com", "old-password-1")).statusCode,
    ).toBe(401);
    expect(
      (await signIn("grace@example.com", "new-password-2")).statusCode,
    ).toBe(200);

    // Existing sessions end with the reset.
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: cookie! },
    });
    expect(me.statusCode).toBe(401);

    // The token works once.
    const again = await resetPassword(token!, "third-password-3");
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("sends the invalid-token marker to the page for an unknown link", async () => {
    const callbackURL = encodeURIComponent(`${webOrigin}/reset-password`);
    const opened = await app.inject({
      method: "GET",
      url: `/api/auth/reset-password/not-a-token?callbackURL=${callbackURL}`,
    });
    expect(opened.statusCode).toBe(302);
    const target = new URL(String(opened.headers.location));
    expect(target.pathname).toBe("/reset-password");
    expect(target.searchParams.get("error")).toBe("INVALID_TOKEN");
    expect(target.searchParams.get("token")).toBeNull();
  });

  it("answers the same for an unknown address and sends nothing", async () => {
    const before = sentEmails.length;
    const response = await requestReset("nobody@example.com");
    expect(response.statusCode).toBe(200);
    expect(sentEmails.length).toBe(before);
  });

  it("refuses a callback outside the trusted origins", async () => {
    await signUp("heidi@example.com", "password-12345", "Heidi");
    const before = sentEmails.length;
    const response = await requestReset(
      "heidi@example.com",
      "https://evil.example.com/reset-password",
    );
    expect(response.statusCode).toBe(403);
    expect(sentEmails.length).toBe(before);
  });

  it("rejects a new password shorter than 8 characters", async () => {
    await signUp("ivan@example.com", "password-12345", "Ivan");
    await requestReset("ivan@example.com");
    const mail = sentEmails.findLast(
      (m) => m.kind === "password-reset" && m.to === "ivan@example.com",
    );
    const token = new URL(mail!.url).pathname.split("/").pop()!;
    const reset = await resetPassword(token, "short");
    expect(reset.statusCode).toBe(400);
    expect(reset.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    expect(
      (await signIn("ivan@example.com", "password-12345")).statusCode,
    ).toBe(200);
  });
});
