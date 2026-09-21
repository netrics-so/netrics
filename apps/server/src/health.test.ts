import { describe, expect, it } from "vitest";

import {
  healthLiveResponseSchema,
  healthReadyResponseSchema,
} from "@netrics/contracts";

import { buildApp } from "./app.js";
import { loadConfig } from "./env.js";

const config = loadConfig({
  DATABASE_URL: "postgres://netrics:netrics@localhost:5432/netrics",
  LOG_LEVEL: "silent",
  APP_VERSION: "0.1.0-test",
  GIT_SHA: "test123",
});

describe("health endpoints", () => {
  it("GET /health/live reports the process is up", async () => {
    const app = await buildApp(config, { checkDb: async () => false });
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(healthLiveResponseSchema.parse(response.json())).toMatchObject({
      status: "ok",
      role: "api",
      version: "0.1.0-test",
      commit: "test123",
    });
    await app.close();
  });

  it("GET /health/live falls back to dev defaults without env", async () => {
    const devConfig = loadConfig({ LOG_LEVEL: "silent" });
    const app = await buildApp(devConfig, { checkDb: async () => false });
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: "0.0.0-dev",
      commit: "dev",
    });
    await app.close();
  });

  it("GET /health/ready returns 200 when the database is reachable", async () => {
    const app = await buildApp(config, { checkDb: async () => true });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(healthReadyResponseSchema.parse(response.json())).toMatchObject({
      status: "ready",
      database: "up",
      version: "0.1.0-test",
      commit: "test123",
    });
    await app.close();
  });

  it("GET /health/ready returns 503 when the database is down", async () => {
    const app = await buildApp(config, { checkDb: async () => false });
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(healthReadyResponseSchema.parse(response.json())).toMatchObject({
      status: "not_ready",
      database: "down",
    });
    await app.close();
  });
});
