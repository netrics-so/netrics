import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./env.js";

const validEnv = {
  DATABASE_URL: "postgres://netrics:netrics@localhost:5432/netrics",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3001);
    expect(config.host).toBe("0.0.0.0");
    expect(config.logLevel).toBe("info");
    expect(config.role).toBe("api");
    expect(config.databaseUrl).toContain("localhost:5433");
    expect(config.databaseUrl).toContain("netrics_app");
    expect(config.databaseMigrationUrl).toBe(config.databaseUrl);
    expect(config.betterAuthUrl).toBe("http://localhost:3001");
    expect(config.webOrigin).toBe("http://localhost:3000");
    expect(config.betterAuthSecret.length).toBeGreaterThanOrEqual(32);
    expect(config.version).toBe("0.0.0-dev");
    expect(config.commit).toBe("dev");
  });

  it("reads version and commit from the environment", () => {
    const config = loadConfig({
      ...validEnv,
      APP_VERSION: "0.1.0",
      GIT_SHA: "abc1234",
    });
    expect(config.version).toBe("0.1.0");
    expect(config.commit).toBe("abc1234");
  });

  it("coerces PORT from a string", () => {
    const config = loadConfig({ ...validEnv, PORT: "4010" });
    expect(config.port).toBe(4010);
  });

  it("uses DATABASE_MIGRATION_URL when provided", () => {
    const config = loadConfig({
      ...validEnv,
      DATABASE_MIGRATION_URL:
        "postgres://netrics:netrics@localhost:5433/netrics",
    });
    expect(config.databaseMigrationUrl).toBe(
      "postgres://netrics:netrics@localhost:5433/netrics",
    );
    expect(config.databaseMigrationUrl).not.toBe(config.databaseUrl);
  });

  it("fails with a readable error when DATABASE_URL is invalid", () => {
    expect(() => loadConfig({ DATABASE_URL: "not-a-url" })).toThrowError(
      ConfigError,
    );
    try {
      loadConfig({ DATABASE_URL: "not-a-url" });
    } catch (error) {
      expect((error as Error).message).toContain("DATABASE_URL");
    }
  });

  it("rejects an invalid role", () => {
    expect(() =>
      loadConfig({ ...validEnv, NETRICS_ROLE: "wizard" }),
    ).toThrowError(/NETRICS_ROLE/);
  });

  it("requires BETTER_AUTH_SECRET in production", () => {
    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: "production" }),
    ).toThrowError(/BETTER_AUTH_SECRET/);
  });

  it("accepts a production BETTER_AUTH_SECRET of at least 32 chars", () => {
    const config = loadConfig({
      ...validEnv,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "a".repeat(32),
      APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });
    expect(config.betterAuthSecret).toBe("a".repeat(32));
  });

  it("requires APP_ENCRYPTION_KEY in production", () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        NODE_ENV: "production",
        BETTER_AUTH_SECRET: "a".repeat(32),
      }),
    ).toThrowError(/APP_ENCRYPTION_KEY/);
  });

  it("requires APP_ENCRYPTION_KEY to be base64 of exactly 32 bytes", () => {
    const config = loadConfig({
      APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });
    expect(Buffer.from(config.appEncryptionKey, "base64")).toHaveLength(32);

    expect(() =>
      loadConfig({ APP_ENCRYPTION_KEY: randomBytes(16).toString("base64") }),
    ).toThrowError(/APP_ENCRYPTION_KEY/);
    expect(() =>
      loadConfig({ APP_ENCRYPTION_KEY: "not base64!!!" }),
    ).toThrowError(/APP_ENCRYPTION_KEY/);
  });

  it("falls back to a documented insecure dev key outside production", () => {
    const config = loadConfig({});
    expect(Buffer.from(config.appEncryptionKey, "base64")).toHaveLength(32);
  });

  it("rejects a BETTER_AUTH_SECRET shorter than 32 chars", () => {
    expect(() =>
      loadConfig({ ...validEnv, BETTER_AUTH_SECRET: "too-short" }),
    ).toThrowError(/BETTER_AUTH_SECRET/);
  });

  it("reads BETTER_AUTH_URL and WEB_ORIGIN from the environment", () => {
    const config = loadConfig({
      ...validEnv,
      BETTER_AUTH_URL: "https://api.example.com",
      WEB_ORIGIN: "https://app.example.com",
    });
    expect(config.betterAuthUrl).toBe("https://api.example.com");
    expect(config.webOrigin).toBe("https://app.example.com");
  });

  it("applies worker/scheduler defaults", () => {
    const config = loadConfig({});
    expect(config.databaseSchedulerUrl).toContain("netrics_scheduler");
    expect(config.databaseSchedulerUrl).toContain("localhost:5433");
    expect(config.schedulerPollMs).toBe(5000);
    expect(config.workerPollMs).toBe(1000);
    expect(config.workerConcurrency).toBe(4);
  });

  it("requires DATABASE_SCHEDULER_URL in production for worker/scheduler roles", () => {
    const prod = {
      ...validEnv,
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "a".repeat(32),
      APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    };
    expect(() => loadConfig({ ...prod, NETRICS_ROLE: "worker" })).toThrowError(
      /DATABASE_SCHEDULER_URL/,
    );
    expect(() =>
      loadConfig({ ...prod, NETRICS_ROLE: "scheduler" }),
    ).toThrowError(/DATABASE_SCHEDULER_URL/);
    // The api role never opens a scheduler connection.
    expect(() => loadConfig({ ...prod, NETRICS_ROLE: "api" })).not.toThrow();
    const config = loadConfig({
      ...prod,
      NETRICS_ROLE: "worker",
      DATABASE_SCHEDULER_URL:
        "postgres://scheduler:secret@db.example.com/netrics",
    });
    expect(config.databaseSchedulerUrl).toContain("db.example.com");
  });
});
