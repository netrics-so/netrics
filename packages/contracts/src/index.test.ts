import { describe, expect, it } from "vitest";

import {
  bootstrapRequestSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  meResponseSchema,
  workspaceRoleSchema,
} from "./index.js";

describe("workspaceRoleSchema", () => {
  it("accepts the four membership roles", () => {
    for (const role of ["owner", "admin", "editor", "viewer"]) {
      expect(workspaceRoleSchema.parse(role)).toBe(role);
    }
  });

  it("rejects unknown roles", () => {
    expect(workspaceRoleSchema.safeParse("superadmin").success).toBe(false);
  });
});

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

describe("session contracts", () => {
  it("accepts a valid bootstrap request", () => {
    expect(
      bootstrapRequestSchema.parse({ workspaceName: "  Acme  " }).workspaceName,
    ).toBe("Acme");
  });

  it("rejects an empty workspace name", () => {
    expect(
      bootstrapRequestSchema.safeParse({ workspaceName: "   " }).success,
    ).toBe(false);
  });

  it("accepts a valid /v1/me payload", () => {
    const parsed = meResponseSchema.parse({
      user: {
        id: "3f6b0746-3d1c-4f6b-9f6d-2f1c0a2b1e02",
        email: "owner@example.com",
        displayName: "Owner",
      },
      memberships: [
        {
          workspaceId: "8a7a4f60-1f6c-4a3b-9d2e-0f0e9c8b7a6f",
          workspaceName: "Acme",
          role: "owner",
        },
      ],
    });
    expect(parsed.memberships).toHaveLength(1);
  });

  it("rejects a membership with an unknown role", () => {
    expect(
      meResponseSchema.safeParse({
        user: {
          id: "3f6b0746-3d1c-4f6b-9f6d-2f1c0a2b1e02",
          email: "owner@example.com",
          displayName: "Owner",
        },
        memberships: [
          {
            workspaceId: "8a7a4f60-1f6c-4a3b-9d2e-0f0e9c8b7a6f",
            workspaceName: "Acme",
            role: "superadmin",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
