import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";

import {
  authSchema,
  findUserByAuthUserId,
  insertInstallationAuditEvent,
  provisionDomainUser,
  type Database,
} from "@netrics/database";

import type { Config } from "../env.js";
import { createLoggingMailer, type AuthMailer } from "./mailer.js";

export type { AuthEmail, AuthMailer } from "./mailer.js";

export interface SessionIdentity {
  authUserId: string;
  email: string;
  domainUserId: string;
}

/**
 * The isolation boundary for the auth subsystem: everything better-auth is
 * encapsulated here, and the rest of the server only ever sees this narrow
 * surface (mounting /api/auth/* and resolving a session identity).
 */
export interface AuthService {
  handle(request: FastifyRequest, reply: FastifyReply): Promise<void>;
  getSessionIdentity(
    headers: FastifyRequest["headers"],
  ): Promise<SessionIdentity | null>;
}

export interface AuthServiceDeps {
  logger: FastifyBaseLogger;
  mailer?: AuthMailer;
}

export function createAuthService(
  config: Config,
  db: Database,
  deps: AuthServiceDeps,
): AuthService {
  const logger = deps.logger.child({ module: "auth" });
  const mailer = deps.mailer ?? createLoggingMailer(logger);

  const auth = betterAuth({
    baseURL: config.betterAuthUrl,
    secret: config.betterAuthSecret,
    trustedOrigins: [config.webOrigin],
    logger: { disabled: config.logLevel === "silent" },
    database: drizzleAdapter(db, {
      provider: "pg",
      schemaName: "auth",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      // No SMTP yet (milestone 13), so verification cannot gate sign-in.
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mailer.sendPasswordResetEmail({ to: user.email, url });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.sendVerificationEmail({ to: user.email, url });
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Mirror every auth user into the installation-level domain users
          // table (the row tenants reference via memberships).
          after: async (user) => {
            await provisionDomainUser(db, {
              authUserId: user.id,
              email: user.email,
              name: user.name,
            });
          },
        },
      },
      session: {
        create: {
          // Records an installation-level auth.login audit event (also fires
          // for the session created on sign-up, which is correct). Failures
          // must not block sign-in, so they are logged and swallowed.
          after: async (session) => {
            try {
              const domainUser = await findUserByAuthUserId(db, session.userId);
              if (!domainUser) {
                logger.warn(
                  { authUserId: session.userId },
                  "skipping auth.login audit: no domain user for auth user",
                );
                return;
              }
              await insertInstallationAuditEvent(db, {
                actorUserId: domainUser.id,
                action: "auth.login",
                target: domainUser.id,
                metadata: {
                  ...(session.ipAddress
                    ? { ipAddress: session.ipAddress }
                    : {}),
                  ...(session.userAgent
                    ? { userAgent: session.userAgent }
                    : {}),
                },
              });
            } catch (error) {
              logger.error(
                { err: error, authUserId: session.userId },
                "failed to write auth.login audit event",
              );
            }
          },
        },
      },
    },
  });

  return {
    // Fetch-style bridge between Fastify and the better-auth handler.
    async handle(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const req = new Request(url.toString(), {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },

    async getSessionIdentity(headers) {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(headers),
      });
      if (!session) {
        return null;
      }
      let domainUser = await findUserByAuthUserId(db, session.user.id);
      if (!domainUser) {
        // Self-heal: the provisioning hook should have created the row, but
        // if it ever failed the session would otherwise be unusable forever.
        logger.warn(
          { authUserId: session.user.id },
          "domain user missing for valid session; provisioning as fallback",
        );
        domainUser = await provisionDomainUser(db, {
          authUserId: session.user.id,
          email: session.user.email,
          name: session.user.name,
        });
      }
      return {
        authUserId: session.user.id,
        email: domainUser.email,
        domainUserId: domainUser.id,
      };
    },
  };
}
