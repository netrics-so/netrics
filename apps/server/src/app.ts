import cors from "@fastify/cors";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";

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
import type { ConnectorRegistry } from "@netrics/connector-runtime";

import { createAuthService, type AuthService } from "./auth/index.js";
import { registerClientAddress } from "./client-address.js";
import { logSerializers } from "./log-serializers.js";
import { createDefaultRegistry } from "./connectors.js";
import { createOnboarding } from "./onboarding.js";
import { createCredentialKeyring } from "./credentials.js";
import type { Config } from "./env.js";
import {
  registerHttpHardening,
  requestIdFromHeader,
} from "./http-hardening.js";
import { createMailer, type Mailer } from "./mail/mailer.js";
import { providerHttp, type OAuthHttpFactory } from "./oauth/client.js";
import { createOAuthProviders, type OAuthProviders } from "./oauth/config.js";
import type { SignedKeyProviders } from "./signed-keys/registry.js";
import {
  createOAuthTokenService,
  type OAuthTokenService,
} from "./oauth/tokens.js";
import { createOAuthFlow } from "./oauth/flow.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerConnectionRoutes } from "./routes/connections.js";
import { registerDashboardRoutes } from "./routes/dashboards.js";
import { registerDeviceRoutes } from "./routes/devices.js";
import { registerImageRoutes } from "./routes/images.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerInvitationRoutes } from "./routes/invitations.js";
import { registerMetricRoutes } from "./routes/metrics.js";
import { registerOAuthRoutes } from "./routes/oauth.js";
import { registerOpenApi, routeSchema } from "./routes/openapi.js";
import { registerSessionRoutes } from "./routes/session.js";
import { registerThemeRoutes } from "./routes/themes.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";

export interface AppDeps {
  checkDb?: () => Promise<boolean>;
  db?: Database;
  authService?: AuthService;
  mailer?: Mailer;
  registry?: ConnectorRegistry;
  /** Clock for metric queries ("today" etc.); tests pin it. */
  now?: () => Date;
  /** Default: the providers configured in the environment (ADR 0012). */
  oauthProviders?: OAuthProviders;
  /** Default: a token service over the app's db and providers. */
  oauthTokens?: OAuthTokenService;
  /** Default: guarded fetch to each provider's server domains. */
  oauthHttp?: OAuthHttpFactory;
  /** Default: the signed-key providers of this server (ADR 0014). */
  signedKeys?: SignedKeyProviders;
  /** Tests: capture the app's logs. */
  logger?: FastifyBaseLogger;
  /** Reuse of computed device payloads (default 30 s); tests pass 0. */
  devicePayloadCacheMs?: number;
}

export async function buildApp(
  config: Config,
  deps: AppDeps = {},
): Promise<FastifyInstance> {
  const checkDb =
    deps.checkDb ?? (() => checkDatabaseConnection(config.databaseUrl));

  const app = Fastify({
    ...(deps.logger
      ? {
          loggerInstance: deps.logger.child(
            {},
            { serializers: logSerializers },
          ),
        }
      : {
          logger: {
            serializers: logSerializers,
            level: config.logLevel,
            base: { service: "netrics-server", role: config.role },
          },
        }),
    genReqId: requestIdFromHeader,
    // Which X-Forwarded-For hops request.ip may believe; see
    // NETRICS_TRUSTED_PROXIES in env.ts and auth/rate-limit.ts.
    trustProxy:
      config.trustedProxies.length > 0 ? config.trustedProxies : false,
  });
  // First: every later hook and route reads request.clientIp and sees the
  // cookie rule already applied.
  registerClientAddress(app, config.proxySecrets);
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

  const registry = deps.registry ?? createDefaultRegistry();
  const credentialKeyring = createCredentialKeyring(
    config.appEncryptionKey,
    config.appEncryptionKeysPrevious,
  );
  const oauthProviders = deps.oauthProviders ?? createOAuthProviders(config);

  registerSessionRoutes(app, { authService, db });
  registerWorkspaceRoutes(app, {
    authService,
    db,
    exchangeRates: config.exchangeRates,
    addDemoContent: createOnboarding({
      db,
      registry,
      credentialKeyring,
      oauthProviders,
      logger: app.log,
    }),
  });
  registerAdminRoutes(app, { authService, db });
  registerInvitationRoutes(app, {
    authService,
    db,
    mailer,
    webOrigin: config.webOrigin,
  });
  registerMetricRoutes(app, {
    authService,
    db,
    exchangeRates: config.exchangeRates,
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerDashboardRoutes(app, { authService, db });
  registerThemeRoutes(app, { authService, db });
  registerImageRoutes(app, { authService, db, quota: config.imageQuota });
  registerDeviceRoutes(app, {
    authService,
    db,
    pairingUrl: config.pairingUrl,
    version: config.version,
    exchangeRates: config.exchangeRates,
    ...(deps.devicePayloadCacheMs !== undefined
      ? { payloadCacheMs: deps.devicePayloadCacheMs }
      : {}),
  });
  const oauthTokens =
    deps.oauthTokens ??
    createOAuthTokenService({
      db,
      credentialKeyring,
      providers: oauthProviders,
      ...(deps.oauthHttp ? { http: deps.oauthHttp } : {}),
    });
  registerConnectionRoutes(app, {
    authService,
    db,
    registry,
    credentialKeyring,
    oauthProviders,
    oauthTokens,
    ...(deps.signedKeys ? { signedKeys: deps.signedKeys } : {}),
  });
  registerTemplateRoutes(app, {
    authService,
    db,
    registry,
    credentialKeyring,
    oauthProviders,
    oauthTokens,
    quota: config.imageQuota,
    ...(deps.signedKeys ? { signedKeys: deps.signedKeys } : {}),
  });
  registerOAuthRoutes(app, {
    authService,
    db,
    flow: createOAuthFlow({
      db,
      registry,
      credentialKeyring,
      oauthProviders,
      oauthHttp: deps.oauthHttp ?? providerHttp,
      oauthTokens,
      logger: app.log,
    }),
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
