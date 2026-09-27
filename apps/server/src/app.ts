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
import { createMailer, type Mailer } from "./mail/mailer.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerOpenApi, routeSchema } from "./routes/openapi.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";

export interface AppDeps {
  checkDb?: () => Promise<boolean>;
  db?: Database;
  authService?: AuthService;
  mailer?: Mailer;
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
  await registerOpenApi(app, config.version);

  const db = deps.db ?? createDatabase(config.databaseUrl);
  const mailer = deps.mailer ?? createMailer(config, app.log);
  const authService =
    deps.authService ??
    createAuthService(config, db, { logger: app.log, mailer });

  await app.register(cors, { origin: config.webOrigin, credentials: true });

  // better-auth owns everything under /api/auth/* (sign-up, sign-in, session
  // management); the auth module bridges Fastify to its fetch-style handler.
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    // better-auth documents its own endpoints; not part of this API's spec.
    schema: { hide: true },
    handler: (request, reply) => authService.handle(request, reply),
  });

  // Public (no session): lets the web app route first visitors to /setup
  // and hide sign-up when it is closed. Reveals no account data.
  app.get(
    "/v1/setup-status",
    {
      schema: routeSchema({
        summary: "Whether first-run setup is pending and sign-up is open",
        tags: ["session"],
        response: setupStatusResponseSchema,
        public: true,
      }),
    },
    async () =>
      setupStatusResponseSchema.parse({
        setupRequired:
          config.signup === "closed" && (await countUsers(db)) === 0,
        signup: config.signup,
      }),
  );

  registerSessionRoutes(app, { authService, db });
  registerWorkspaceRoutes(app, { authService, db });
  registerInvitationRoutes(app, {
    authService,
    db,
    mailer,
    webOrigin: config.webOrigin,
  });
  registerConnectionRoutes(app, {
    authService,
    db,
    registry: deps.registry ?? createDefaultRegistry(),
    credentialKeyring: createCredentialKeyring(
      config.appEncryptionKey,
      config.appEncryptionKeysPrevious,
    ),
  });

  app.get(
    "/health/live",
    {
      schema: routeSchema({
        summary: "Liveness (process up; no dependencies)",
        tags: ["health"],
        response: healthLiveResponseSchema,
        public: true,
      }),
    },
    async () =>
      healthLiveResponseSchema.parse({
        status: "ok",
        role: config.role,
        uptimeSeconds: process.uptime(),
        version: config.version,
        commit: config.commit,
      }),
  );

  app.get(
    "/health/ready",
    {
      schema: {
        ...routeSchema({
          summary: "Readiness (database reachable)",
          tags: ["health"],
          response: healthReadyResponseSchema,
          public: true,
        }),
        // 503 carries the same body with status "not_ready".
        response: {
          200: healthReadyResponseSchema,
          503: healthReadyResponseSchema,
        },
      },
    },
    async (_request, reply) => {
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
    },
  );

  // The generated OpenAPI document (also committed as openapi.json and
  // checked for drift in CI).
  app.get("/v1/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );

  return app;
}
