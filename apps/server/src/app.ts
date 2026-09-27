import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import {
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  setupStatusResponseSchema,
} from "@netrics/contracts";
import {
  checkDatabaseConnection,
  countUsers,
  createDatabase,
  type Database,
} from "@netrics/database";
import {
  createDefaultRegistry,
  type ConnectorRegistry,
} from "@netrics/connector-runtime";

import { createAuthService, type AuthService } from "./auth/index.js";
import { createCredentialKeyring } from "./credentials.js";
import type { Config } from "./env.js";
import {
  registerHttpHardening,
  requestIdFromHeader,
} from "./http-hardening.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";

export interface AppDeps {
  checkDb?: () => Promise<boolean>;
  db?: Database;
  authService?: AuthService;
  registry?: ConnectorRegistry;
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
    genReqId: requestIdFromHeader,
  });
  registerHttpHardening(app, config);

  const db = deps.db ?? createDatabase(config.databaseUrl);
  const authService =
    deps.authService ?? createAuthService(config, db, { logger: app.log });

  await app.register(cors, { origin: config.webOrigin, credentials: true });

  // better-auth owns everything under /api/auth/* (sign-up, sign-in, session
  // management); the auth module bridges Fastify to its fetch-style handler.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    handler: (request, reply) => authService.handle(request, reply),
  });

  // Public (no session): lets the web app route first visitors to /setup
  // and hide sign-up when it is closed. Reveals no account data.
  app.get("/v1/setup-status", async () =>
    setupStatusResponseSchema.parse({
      setupRequired: config.signup === "closed" && (await countUsers(db)) === 0,
      signup: config.signup,
    }),
  );

  registerSessionRoutes(app, { authService, db });
  registerWorkspaceRoutes(app, { authService, db });
  registerConnectionRoutes(app, {
    authService,
    db,
    registry: deps.registry ?? createDefaultRegistry(),
    credentialKeyring: createCredentialKeyring(
      config.appEncryptionKey,
      config.appEncryptionKeysPrevious,
    ),
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
