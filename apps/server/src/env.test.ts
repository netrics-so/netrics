import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig, loadMigrationConfig } from "./env.js";

const validEnv = {
  DATABASE_URL: "postgres://netrics:netrics@localhost:5432/netrics",
};

const productionUrls = {
  BETTER_AUTH_URL: "https://app.example.com",
  WEB_ORIGIN: "https://app.example.com",
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
      ...productionUrls,
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
      ...productionUrls,
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

describe("privileged database escape hatch", () => {
  it("is off by default and can be enabled outside production", () => {
    expect(loadConfig({}).allowPrivilegedDb).toBe(false);
    expect(
      loadConfig({ NETRICS_ALLOW_PRIVILEGED_DB: "true" }).allowPrivilegedDb,
    ).toBe(true);
  });

  it("is refused in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        NETRICS_ALLOW_PRIVILEGED_DB: "true",
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      }),
    ).toThrow(/NETRICS_ALLOW_PRIVILEGED_DB/);
  });
});

describe("loadMigrationConfig", () => {
  it("provisions development role passwords outside production", () => {
    const config = loadMigrationConfig({});
    expect(config.databaseMigrationUrl).toContain("netrics:netrics@");
    expect(config.rolePasswords).toEqual({
      netrics_app: "netrics_app",
      netrics_scheduler: "netrics_scheduler",
    });
  });

  it("needs no runtime secrets in production and leaves roles unprovisioned without passwords", () => {
    const config = loadMigrationConfig({
      NODE_ENV: "production",
      DATABASE_MIGRATION_URL: "postgres://owner:secret@db.example.com/netrics",
    });
    expect(config.rolePasswords).toEqual({
      netrics_app: undefined,
      netrics_scheduler: undefined,
    });
  });

  it("uses provided role passwords and rejects short ones in production", () => {
    const strong = randomBytes(24).toString("base64");
    expect(
      loadMigrationConfig({
        NODE_ENV: "production",
        NETRICS_APP_DB_PASSWORD: strong,
        NETRICS_SCHEDULER_DB_PASSWORD: strong,
      }).rolePasswords,
    ).toEqual({ netrics_app: strong, netrics_scheduler: strong });
    expect(() =>
      loadMigrationConfig({
        NODE_ENV: "production",
        NETRICS_APP_DB_PASSWORD: "short",
      }),
    ).toThrow(ConfigError);
  });
});

describe("production hardening", () => {
  const prod = {
    ...validEnv,
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    APP_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };

  it("requires https BETTER_AUTH_URL and WEB_ORIGIN for the api", () => {
    expect(() => loadConfig(prod)).toThrowError(/BETTER_AUTH_URL/);
    expect(() =>
      loadConfig({
        ...prod,
        BETTER_AUTH_URL: "http://app.example.com",
        WEB_ORIGIN: "https://app.example.com",
      }),
    ).toThrowError(/BETTER_AUTH_URL must be set to an https/);
    const config = loadConfig({ ...prod, ...productionUrls });
    expect(config.betterAuthUrl).toBe("https://app.example.com");
    // Background roles serve no browser traffic.
    expect(() =>
      loadConfig({
        ...prod,
        NETRICS_ROLE: "scheduler",
        DATABASE_SCHEDULER_URL: "postgres://s:s@db.example.com/netrics",
      }),
    ).not.toThrow();
  });

  it("rejects the public development secrets", () => {
    const dev = loadConfig({});
    expect(() =>
      loadConfig({
        ...prod,
        ...productionUrls,
        BETTER_AUTH_SECRET: dev.betterAuthSecret,
      }),
    ).toThrowError(/BETTER_AUTH_SECRET is the public development value/);
    expect(() =>
      loadConfig({
        ...prod,
        ...productionUrls,
        APP_ENCRYPTION_KEY: dev.appEncryptionKey,
      }),
    ).toThrowError(/APP_ENCRYPTION_KEY is the public development value/);
  });

  it("configures SMTP only together with MAIL_FROM", () => {
    expect(loadConfig({}).smtp).toBeNull();
    expect(() =>
      loadConfig({ SMTP_URL: "smtps://u:p@smtp.example.com:465" }),
    ).toThrowError(/MAIL_FROM/);
    expect(() =>
      loadConfig({ SMTP_URL: "https://smtp.example.com", MAIL_FROM: "a@b.c" }),
    ).toThrowError(/SMTP_URL/);
    expect(
      loadConfig({
        SMTP_URL: "smtps://u:p@smtp.example.com:465",
        MAIL_FROM: "netrics <no-reply@example.com>",
      }).smtp,
    ).toEqual({
      url: "smtps://u:p@smtp.example.com:465",
      from: "netrics <no-reply@example.com>",
    });
  });
});

describe("empty values", () => {
  it("treat empty optional settings as unset (Compose ${VAR:-})", () => {
    const config = loadConfig({
      SMTP_URL: "",
      MAIL_FROM: "",
      NETRICS_SETUP_TOKEN: "",
      APP_ENCRYPTION_KEYS_PREVIOUS: "",
    });
    expect(config.smtp).toBeNull();
    expect(config.setupToken).toBeNull();
    expect(config.appEncryptionKeysPrevious).toEqual([]);
    expect(
      loadMigrationConfig({ NETRICS_APP_DB_PASSWORD: "" }).rolePasswords
        .netrics_app,
    ).toBe("netrics_app");
  });
});
