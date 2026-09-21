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
    });
    expect(parsed.status).toBe("ok");
  });

  it("accepts a valid readiness payload", () => {
    const parsed = healthReadyResponseSchema.parse({
      status: "ready",
      role: "api",
      database: "up",
      checkedAt: new Date().toISOString(),
    });
    expect(parsed.database).toBe("up");
  });

  it("rejects an unknown role", () => {
    expect(
      healthLiveResponseSchema.safeParse({
        status: "ok",
        role: "wizard",
        uptimeSeconds: 1,
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
      }).success,
    ).toBe(false);
  });
});
