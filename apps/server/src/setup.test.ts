import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createDatabase,
  findInstallationSetup,
  findUserByEmail,
  type Database,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig, type Config } from "./env.js";
import { SETUP_TOKEN_HEADER, prepareInstallationSetup } from "./setup.js";
import { createTestDatabase } from "./test-db.js";

type InjectResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

interface Instance {
  app: FastifyInstance;
  db: Database;
  config: Config;
  logs: string[];
}

const instances: Instance[] = [];

async function createInstance(env: Record<string, string>): Promise<Instance> {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    NETRICS_SIGNUP: "closed",
    ...env,
  });
  const db = createDatabase(testDb.appUrl);
  const logs: string[] = [];
  const logger = pino(
    { level: "info" },
    { write: (line: string) => logs.push(line) },
  );
  const app = await buildApp(config, {
    db,
    checkDb: async () => true,
    authService: createAuthService(config, db, { logger }),
  });
  await prepareInstallationSetup(config, db, logger);
  const instance = { app, db, config, logs };
  instances.push(instance);
  return instance;
}

afterAll(async () => {
  for (const { app, db } of instances) {
    await app.close();
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
  }
});

function signUp(
  app: FastifyInstance,
  email: string,
  token?: string,
): Promise<InjectResponse> {
  return app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: token ? { [SETUP_TOKEN_HEADER]: token } : {},
    payload: { name: email, email, password: "password-12345" },
  });
}

/** Reads the generated token from the logged setup URL. */
function loggedToken(logs: string[]): string {
  const line = logs.find((l) => l.includes("setupUrl"));
  expect(line).toBeDefined();
  const { setupUrl } = JSON.parse(line!) as { setupUrl: string };
  return new URL(setupUrl).searchParams.get("token")!;
}

describe("closed sign-up with a generated setup token", () => {
  let instance: Instance;
  let token: string;

  beforeAll(async () => {
    instance = await createInstance({});
    token = loggedToken(instance.logs);
  }, 60_000);

  it("logs a setup URL with the token on the web origin", () => {
    const line = instance.logs.find((l) => l.includes("setupUrl"))!;
    expect(line).toContain("http://localhost:3000/setup?token=");
    expect(token.length).toBeGreaterThanOrEqual(24);
  });

  it("rejects sign-up without or with a wrong token", async () => {
    for (const attempt of [undefined, "wrong-token-wrong-token-wrong"]) {
      const response = await signUp(
        instance.app,
        "intruder@example.com",
        attempt,
      );
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "SIGNUP_DISABLED" });
    }
    expect(await findUserByEmail(instance.db, "intruder@example.com")).toBe(
      null,
    );
  });

  it("creates exactly one account with the token and records its owner", async () => {
    const response = await signUp(instance.app, "owner@example.com", token);
    expect(response.statusCode).toBe(200);
    const owner = await findUserByEmail(instance.db, "owner@example.com");
    const setup = await findInstallationSetup(instance.db);
    expect(setup?.consumedAt).not.toBeNull();
    expect(setup?.ownerUserId).toBe(owner!.id);

    const reuse = await signUp(instance.app, "second@example.com", token);
    expect(reuse.statusCode).toBe(403);
  });

  it("issues no new token once an account exists", async () => {
    instance.logs.length = 0;
    await prepareInstallationSetup(
      instance.config,
      instance.db,
      pino({ level: "info" }, { write: (l: string) => instance.logs.push(l) }),
    );
    expect(instance.logs.some((l) => l.includes("setupUrl"))).toBe(false);
  });
});

describe("concurrent setup attempts", () => {
  it("lets only one sign-up win the token", async () => {
    const instance = await createInstance({});
    const token = loggedToken(instance.logs);
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((name) =>
        signUp(instance.app, `racer-${name}@example.com`, token),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 403, 403, 403]);
  }, 60_000);
});

describe("fixed NETRICS_SETUP_TOKEN", () => {
  it("accepts the configured token and never logs it", async () => {
    const fixed = "fixed-setup-token-0123456789abcdef";
    const instance = await createInstance({ NETRICS_SETUP_TOKEN: fixed });
    expect(instance.logs.join("\n")).not.toContain(fixed);
    expect(instance.logs.some((l) => l.includes("setupUrl"))).toBe(true);
    expect(
      (await signUp(instance.app, "op@example.com", fixed)).statusCode,
    ).toBe(200);
  }, 60_000);
});

describe("open sign-up", () => {
  it("needs no token and issues none", async () => {
    const instance = await createInstance({ NETRICS_SIGNUP: "open" });
    expect(instance.logs.some((l) => l.includes("setupUrl"))).toBe(false);
    expect((await signUp(instance.app, "anyone@example.com")).statusCode).toBe(
      200,
    );
  }, 60_000);
});

describe("GET /v1/setup-status", () => {
  it("reports pending setup until the first account exists", async () => {
    const instance = await createInstance({});
    const before = await instance.app.inject({ url: "/v1/setup-status" });
    expect(before.json()).toEqual({ setupRequired: true, signup: "closed" });
    await signUp(instance.app, "first@example.com", loggedToken(instance.logs));
    const after = await instance.app.inject({ url: "/v1/setup-status" });
    expect(after.json()).toEqual({ setupRequired: false, signup: "closed" });
  }, 60_000);
});
