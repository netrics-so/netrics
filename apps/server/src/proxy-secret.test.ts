import { Writable } from "node:stream";
import { inspect } from "node:util";

import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  createServiceToken,
  type Database,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import {
  FORWARDED_CLIENT_IP_HEADER,
  PROXY_SECRET_HEADER,
} from "./client-address.js";
import { ConfigError, loadConfig } from "./env.js";
import type { Mailer } from "./mail/mailer.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";
import { generatePrincipalToken, hashToken } from "./tokens.js";

// ADR 0013 (#156): NETRICS_PROXY_SECRET marks requests from the web frontend,
// whose forwarded client address the API then believes for rate limits.

const SECRET = "proxy-secret-current-0123456789abcdef";
const PREVIOUS = "proxy-secret-previous-0123456789abcdef";
const WRONG = "proxy-secret-wrong-000000000000000000000";

// Sign-in allows 10 requests per client IP per minute (auth/rate-limit.ts);
// pairing 10 per 10 minutes (devices/service.ts).
const SIGN_IN_MAX = 10;
const PAIRING_MAX = 10;

// The hosted shape: the API sees every frontend request from the platform
// edge (a trusted private hop) with one shared Vercel egress address in
// X-Forwarded-For. Without the secret all users share that address.
const EDGE = "10.0.0.5";

const silentMailer: Mailer = {
  delivers: true,
  async sendVerificationEmail() {},
  async sendPasswordResetEmail() {},
  async sendInvitationEmail() {},
};

let testDb: TestDatabase;
let db: Database;
let ownerDb: Database;
let withSecret: FastifyInstance;
let withoutSecret: FastifyInstance;
let logged = "";
let egressCounter = 0;

/** A fresh shared egress address per test, so the limits stay apart. */
function egress(): string {
  egressCounter += 1;
  return `203.0.113.${egressCounter}`;
}

async function buildInstance(
  proxySecret: string | undefined,
  logger?: pino.Logger,
): Promise<FastifyInstance> {
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
    NETRICS_SIGNUP: "open",
    NETRICS_AUTH_RATE_LIMIT: "on",
    NETRICS_PROXY_SECRET: proxySecret,
  });
  const log = logger ?? pino({ level: "silent" });
  const authService = createAuthService(config, db, {
    logger: log,
    mailer: silentMailer,
  });
  return buildApp(config, {
    db,
    authService,
    checkDb: async () => true,
    ...(logger ? { logger } : {}),
  });
}

function signIn(
  app: FastifyInstance,
  sharedIp: string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    remoteAddress: EDGE,
    headers: { "x-forwarded-for": sharedIp, ...headers },
    payload: { email: "nobody@example.com", password: "wrong-password-1" },
  });
}

function frontend(clientIp: string, secret = SECRET): Record<string, string> {
  return {
    [PROXY_SECRET_HEADER]: secret,
    [FORWARDED_CLIENT_IP_HEADER]: clientIp,
  };
}

/** Exhausts sign-in for one key, then checks the next attempt is limited. */
async function exhaustSignIn(
  app: FastifyInstance,
  sharedIp: string,
  headersFor: (attempt: number) => Record<string, string>,
) {
  for (let attempt = 0; attempt < SIGN_IN_MAX; attempt++) {
    expect((await signIn(app, sharedIp, headersFor(attempt))).statusCode).toBe(
      401,
    );
  }
  expect(
    (await signIn(app, sharedIp, headersFor(SIGN_IN_MAX))).statusCode,
  ).toBe(429);
}

async function signUp(
  app: FastifyInstance,
  email: string,
  headers: Record<string, string>,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    remoteAddress: EDGE,
    headers: { "x-forwarded-for": egress(), ...headers },
    payload: { name: "Ada", email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  return (Array.isArray(header) ? header : [header])
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

const captureLogs = new Writable({
  write(chunk, _encoding, done) {
    logged += String(chunk);
    done();
  },
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = createDatabase(testDb.appUrl);
  ownerDb = createDatabase(testDb.adminUrl, { max: 1 });
  withSecret = await buildInstance(
    `${SECRET}, ${PREVIOUS}`,
    pino({ level: "trace" }, captureLogs),
  );
  withoutSecret = await buildInstance(undefined);
}, 30_000);

afterAll(async () => {
  await withSecret.close();
  await withoutSecret.close();
  await db.$client.end({ timeout: 5 }).catch(() => undefined);
  await ownerDb.$client.end({ timeout: 5 }).catch(() => undefined);
});

describe("client address for rate limits", () => {
  it("keys the limits on the forwarded address with a valid secret", async () => {
    const shared = egress();
    await exhaustSignIn(withSecret, shared, () => frontend("198.51.100.1"));
    // Another visitor behind the same egress address is not affected.
    expect(
      (await signIn(withSecret, shared, frontend("198.51.100.2"))).statusCode,
    ).toBe(401);
    // The same visitor on another egress address stays limited.
    expect(
      (await signIn(withSecret, egress(), frontend("198.51.100.1"))).statusCode,
    ).toBe(429);
  });

  it("accepts the previous secret during a rotation", async () => {
    const shared = egress();
    await exhaustSignIn(withSecret, shared, () =>
      frontend("198.51.100.10", PREVIOUS),
    );
    expect(
      (await signIn(withSecret, shared, frontend("198.51.100.11", PREVIOUS)))
        .statusCode,
    ).toBe(401);
  });

  it("accepts an IPv6 client address", async () => {
    // better-auth limits IPv6 clients per /64 network.
    const shared = egress();
    await exhaustSignIn(withSecret, shared, () => frontend("2001:db8:1::1"));
    expect(
      (await signIn(withSecret, shared, frontend("2001:db8:2::1"))).statusCode,
    ).toBe(401);
  });

  it.each([
    ["no secret", (i: number) => ({ [FORWARDED_CLIENT_IP_HEADER]: ip(i) })],
    ["a wrong secret", (i: number) => frontend(ip(i), WRONG)],
    ["an empty secret", (i: number) => frontend(ip(i), "")],
    ["a secret with a suffix", (i: number) => frontend(ip(i), `${SECRET}x`)],
    [
      "both secrets as one value",
      (i: number) => frontend(ip(i), `${SECRET},${PREVIOUS}`),
    ],
  ])(
    "ignores forged forwarded addresses with %s",
    async (_case, headersFor) => {
      // A fresh forged address on every attempt, in every header a client
      // could try; all of them count against the one shared address. (The
      // pairing limit: without a valid secret /api/auth does not answer.)
      const shared = egress();
      const pair = (i: number) =>
        withSecret.inject({
          method: "POST",
          url: "/v1/device/pairings",
          remoteAddress: EDGE,
          headers: {
            "x-forwarded-for": shared,
            ...headersFor(i),
            "x-real-ip": ip(i),
          },
        });
      for (let i = 0; i < PAIRING_MAX; i++) {
        expect((await pair(i)).statusCode).toBe(200);
      }
      expect((await pair(PAIRING_MAX)).statusCode).toBe(429);
    },
  );

  it.each([
    "198.51.100.1, 198.51.100.2",
    "198.51.100.1:443",
    "not-an-address",
    "",
    "fe80::1%eth0",
  ])("falls back to request.ip for a malformed address %j", async (value) => {
    // The secret is valid, the address is not: every attempt counts
    // against the shared address, whatever the header says.
    await exhaustSignIn(withSecret, egress(), () => frontend(value));
  });

  it("without NETRICS_PROXY_SECRET, ignores both headers as before", async () => {
    const shared = egress();
    await exhaustSignIn(withoutSecret, shared, (i) => frontend(ip(i)));
    // Today's trusted-proxy logic still separates clients by X-Forwarded-For.
    expect((await signIn(withoutSecret, egress())).statusCode).toBe(401);
  });

  it("keys the pairing limit on the forwarded address", async () => {
    const shared = egress();
    const pair = (clientIp: string, secret = SECRET) =>
      withSecret.inject({
        method: "POST",
        url: "/v1/device/pairings",
        remoteAddress: EDGE,
        headers: { "x-forwarded-for": shared, ...frontend(clientIp, secret) },
      });
    for (let i = 0; i < PAIRING_MAX; i++) {
      expect((await pair("198.51.100.50")).statusCode).toBe(200);
    }
    expect((await pair("198.51.100.50")).statusCode).toBe(429);
    expect((await pair("198.51.100.51")).statusCode).toBe(200);
    // Without a valid secret the forwarded address is ignored: every
    // pairing counts against the shared address, which had none so far.
    for (let i = 0; i < PAIRING_MAX; i++) {
      expect((await pair(`198.51.100.${60 + i}`, WRONG)).statusCode).toBe(200);
    }
    expect((await pair("198.51.100.99", WRONG)).statusCode).toBe(429);
  });
});

function ip(index: number): string {
  return `192.0.2.${index + 1}`;
}

describe("session cookies with NETRICS_PROXY_SECRET", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await signUp(
      withSecret,
      "cookie@example.com",
      frontend("198.51.100.200"),
    );
  });

  function me(app: FastifyInstance, headers: Record<string, string>) {
    return app.inject({ url: "/v1/me", headers });
  }

  it("accepts the cookie on requests from the frontend", async () => {
    expect(
      (await me(withSecret, { cookie, ...frontend("198.51.100.200") }))
        .statusCode,
    ).toBe(200);
    // Server-component calls carry the secret without a client address.
    expect(
      (await me(withSecret, { cookie, [PROXY_SECRET_HEADER]: PREVIOUS }))
        .statusCode,
    ).toBe(200);
  });

  it("refuses the cookie without the secret or with a wrong one", async () => {
    expect((await me(withSecret, { cookie })).statusCode).toBe(401);
    expect(
      (await me(withSecret, { cookie, [PROXY_SECRET_HEADER]: WRONG }))
        .statusCode,
    ).toBe(401);
    // The browser auth flow itself is not served without the secret.
    const session = await withSecret.inject({
      url: "/api/auth/get-session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(404);
  });

  it("accepts the cookie on every request when the secret is unset", async () => {
    const plainCookie = await signUp(withoutSecret, "plain@example.com", {});
    expect((await me(withoutSecret, { cookie: plainCookie })).statusCode).toBe(
      200,
    );
  });

  it("serves bearer tokens without the secret", async () => {
    const token = generatePrincipalToken();
    await createServiceToken(ownerDb, {
      name: "integration",
      tokenHash: hashToken(token),
      scopes: ["installation:workspaces:read"],
      expiresAt: null,
    });
    const response = await withSecret.inject({
      url: "/v1/admin/workspaces",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
  });
});

// ADR 0013 (#158): browsers reach /api/auth only through the web origin, so
// with the secret set the flow does not exist on a separate API host.
describe("the browser auth flow with NETRICS_PROXY_SECRET", () => {
  let cookie: string;

  beforeAll(async () => {
    cookie = await signUp(
      withSecret,
      "auth-flow@example.com",
      frontend("198.51.100.210"),
    );
  });

  it.each([
    ["no secret", {}],
    ["a wrong secret", { [PROXY_SECRET_HEADER]: WRONG }],
    ["an empty secret", { [PROXY_SECRET_HEADER]: "" }],
  ])("answers 404 like an unknown route with %s", async (_case, headers) => {
    const responses = await Promise.all([
      withSecret.inject({
        url: "/api/auth/get-session",
        headers: { cookie, ...headers },
      }),
      withSecret.inject({ url: "/api/auth/ok", headers }),
      withSecret.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        remoteAddress: EDGE,
        headers: { "x-forwarded-for": egress(), ...headers },
        payload: { email: "auth-flow@example.com", password: "password-12345" },
      }),
      withSecret.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers,
        payload: {
          name: "Eve",
          email: "eve@example.com",
          password: "password-12345",
        },
      }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "not_found" });
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("serves the flow to the web frontend", async () => {
    const session = await withSecret.inject({
      url: "/api/auth/get-session",
      headers: { cookie, [PROXY_SECRET_HEADER]: SECRET },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      user: { email: "auth-flow@example.com" },
    });
    const signIn = await withSecret.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: EDGE,
      headers: { "x-forwarded-for": egress(), ...frontend("198.51.100.211") },
      payload: { email: "auth-flow@example.com", password: "password-12345" },
    });
    expect(signIn.statusCode).toBe(200);
  });

  it("serves the flow to every request when the secret is unset", async () => {
    const plainCookie = await signUp(withoutSecret, "flow@example.com", {});
    const session = await withoutSecret.inject({
      url: "/api/auth/get-session",
      headers: { cookie: plainCookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      user: { email: "flow@example.com" },
    });
  });
});

describe("the secret stays secret", () => {
  it("never appears in logs or responses", async () => {
    const responses = await Promise.all([
      withSecret.inject({
        url: "/v1/me",
        headers: frontend("198.51.100.30"),
      }),
      withSecret.inject({
        url: "/v1/does-not-exist",
        headers: frontend("198.51.100.30", PREVIOUS),
      }),
      withSecret.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers: {
          ...frontend("198.51.100.30"),
          "content-type": "application/json",
        },
        payload: "{not json",
      }),
      withSecret.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: frontend("198.51.100.30"),
        payload: { email: "nobody@example.com", password: "wrong-password-1" },
      }),
    ]);
    expect(logged.length).toBeGreaterThan(0);
    for (const response of responses) {
      const text = JSON.stringify(response.headers) + response.body;
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PREVIOUS);
    }
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(PREVIOUS);
  });

  it("is redacted in the loaded configuration", () => {
    const config = loadConfig({
      NETRICS_PROXY_SECRET: `${SECRET},${PREVIOUS}`,
    });
    expect(config.proxySecrets.map((secret) => secret.reveal())).toEqual([
      SECRET,
      PREVIOUS,
    ]);
    const printed = JSON.stringify(config) + inspect(config, { depth: 5 });
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(PREVIOUS);
  });
});

describe("NETRICS_PROXY_SECRET configuration", () => {
  it("is unset by default", () => {
    expect(loadConfig({}).proxySecrets).toEqual([]);
    expect(loadConfig({ NETRICS_PROXY_SECRET: "" }).proxySecrets).toEqual([]);
  });

  it("refuses short values without echoing them", () => {
    const short = "too-short-secret";
    expect(() => loadConfig({ NETRICS_PROXY_SECRET: short })).toThrow(
      ConfigError,
    );
    let message = "";
    try {
      loadConfig({ NETRICS_PROXY_SECRET: `${SECRET},${short}` });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("at least 32 characters");
    expect(message).not.toContain(short);
    expect(message).not.toContain(SECRET);
  });

  it("takes at most two values", () => {
    expect(() =>
      loadConfig({ NETRICS_PROXY_SECRET: `${SECRET},${PREVIOUS},${WRONG}` }),
    ).toThrow(/at most two/);
  });
});
