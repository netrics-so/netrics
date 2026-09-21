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
  });

  it("coerces PORT from a string", () => {
    const config = loadConfig({ ...validEnv, PORT: "4010" });
    expect(config.port).toBe(4010);
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
