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
});
