import { describe, expect, it } from "vitest";

import {
  healthLiveResponseSchema,
  healthReadyResponseSchema,
} from "./index.js";

describe("health contracts", () => {
  it("accepts a valid liveness payload", () => {
    const parsed = healthLiveResponseSchema.parse({
      status: "ok",
      role: "api",
      uptimeSeconds: 1.5,
      version: "0.1.0",
      commit: "abc1234",
    });
    expect(parsed.status).toBe("ok");
    expect(parsed.version).toBe("0.1.0");
  });

  it("accepts a valid readiness payload", () => {
    const parsed = healthReadyResponseSchema.parse({
      status: "ready",
      role: "api",
      database: "up",
      checkedAt: new Date().toISOString(),
      version: "0.1.0",
      commit: "abc1234",
    });
    expect(parsed.database).toBe("up");
    expect(parsed.commit).toBe("abc1234");
  });

  it("rejects a payload without version and commit", () => {
    expect(
      healthLiveResponseSchema.safeParse({
        status: "ok",
        role: "api",
        uptimeSeconds: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an empty version string", () => {
    expect(
      healthLiveResponseSchema.safeParse({
        status: "ok",
        role: "api",
        uptimeSeconds: 1,
        version: "",
        commit: "abc1234",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown role", () => {
    expect(
      healthLiveResponseSchema.safeParse({
        status: "ok",
        role: "wizard",
        uptimeSeconds: 1,
        version: "0.1.0",
        commit: "abc1234",
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid database status", () => {
    expect(
      healthReadyResponseSchema.safeParse({
        status: "ready",
        role: "api",
        database: "sideways",
        checkedAt: new Date().toISOString(),
        version: "0.1.0",
        commit: "abc1234",
      }).success,
    ).toBe(false);
  });
});
