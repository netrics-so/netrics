import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import type { AuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";

// No database: a stub auth service and a lazy (never used) connection.
const noSession: AuthService = {
  handle: async (_request, reply) => {
    await reply.code(404).send();
  },
  getSessionIdentity: async () => null,
};

let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  app = await buildApp(config, {
    authService: noSession,
    checkDb: async () => true,
  });
  app.get("/test/boom", async () => {
    throw new Error(
      'duplicate key value violates unique constraint "memberships_pkey" (workspace 5f1c)',
    );
  });
  app.get("/test/request-id", async (request) => ({ id: request.id }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("error responses", () => {
  it("never expose internal error messages", async () => {
    const response = await app.inject({ url: "/test/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error" });
    expect(response.body).not.toContain("memberships_pkey");
  });

  it("map client errors to stable codes", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "invalid_request" });

    const missing = await app.inject({ url: "/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
  });
});

describe("security headers", () => {
  it("are set on every response", async () => {
    const response = await app.inject({ url: "/health/live" });
    expect(response.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });
    // Plain-http development URL: no HSTS.
    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("cross-origin mutations", () => {
  it("rejects a foreign Origin or cross-site fetch before any handler", async () => {
    for (const headers of [
      { origin: "https://evil.example.com" },
      { "sec-fetch-site": "cross-site" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers,
        payload: { name: "x" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "forbidden_origin" });
    }
  });

  it("lets the web origin and non-browser clients through to auth", async () => {
    for (const headers of [
      { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" },
      {},
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/workspaces",
        headers,
        payload: { name: "x" },
      });
      expect(response.statusCode).toBe(401);
    }
  });

  it("does not affect safe methods", async () => {
    const response = await app.inject({
      url: "/v1/setup-status",
      headers: { origin: "https://evil.example.com" },
    });
    expect(response.statusCode).not.toBe(403);
  });
});

describe("request ids", () => {
  it("keep log-safe client ids and replace anything else", async () => {
    const kept = await app.inject({
      url: "/test/request-id",
      headers: { "x-request-id": "trace-abc_123.4" },
    });
    expect(kept.json()).toEqual({ id: "trace-abc_123.4" });

    for (const bad of ['evil"}\n{"level":60', "x".repeat(500)]) {
      const replaced = await app.inject({
        url: "/test/request-id",
        headers: { "x-request-id": bad },
      });
      expect(replaced.json<{ id: string }>().id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
