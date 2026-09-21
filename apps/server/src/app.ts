import { randomUUID } from "node:crypto";

import Fastify, { type FastifyInstance } from "fastify";

import {
  healthLiveResponseSchema,
  healthReadyResponseSchema,
} from "@netrics/contracts";
import { checkDatabaseConnection } from "@netrics/database";

import type { Config } from "./env.js";

export interface AppDeps {
  checkDb?: () => Promise<boolean>;
}

export async function buildApp(
  config: Config,
  deps: AppDeps = {},
): Promise<FastifyInstance> {
  const checkDb =
    deps.checkDb ?? (() => checkDatabaseConnection(config.databaseUrl));

  const app = Fastify({
    logger: {
      level: config.logLevel,
      base: { service: "netrics-server", role: config.role },
    },
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      return typeof header === "string" && header.length > 0
        ? header
        : randomUUID();
    },
  });

  app.get("/health/live", async () =>
    healthLiveResponseSchema.parse({
      status: "ok",
      role: config.role,
      uptimeSeconds: process.uptime(),
      version: config.version,
      commit: config.commit,
    }),
  );

  app.get("/health/ready", async (_request, reply) => {
    const databaseUp = await checkDb();
    const payload = healthReadyResponseSchema.parse({
      status: databaseUp ? "ready" : "not_ready",
      role: config.role,
      database: databaseUp ? "up" : "down",
      checkedAt: new Date().toISOString(),
      version: config.version,
      commit: config.commit,
    });
    return reply.code(databaseUp ? 200 : 503).send(payload);
  });

  return app;
}
