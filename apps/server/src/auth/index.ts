import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";

import {
  authSchema,
  consumeSetupToken,
  countUsers,
  findUserByAuthUserId,
  previewInvitation,
  insertInstallationAuditEvent,
  provisionDomainUser,
  recordSetupOwner,
  type Database,
} from "@netrics/database";
import { localeFromAcceptLanguage, resolveLocale } from "@netrics/domain";

import type { Config } from "../env.js";
import { SETUP_TOKEN_HEADER, hashSetupToken } from "../setup.js";
import { hashToken } from "../tokens.js";
import {
  AUTH_RATE_LIMIT_RULES,
  CLIENT_IP_HEADER,
  DEFAULT_AUTH_RATE_LIMIT,
} from "./rate-limit.js";

/** Header carrying an invitation token on sign-up (see routes/invitations.ts). */
export const INVITATION_TOKEN_HEADER = "x-netrics-invitation-token";
import { PASSWORD_RESET_TTL_SECONDS } from "../link-lifetimes.js";
import { recipientEmailLocale } from "../mail/locale.js";
import { createMailer, type Mailer } from "../mail/mailer.js";

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
  mailer?: Mailer;
}

export function createAuthService(
  config: Config,
  db: Database,
  deps: AuthServiceDeps,
): AuthService {
  const logger = deps.logger.child({ module: "auth" });
  const mailer = deps.mailer ?? createMailer(config, logger);

  // The recipient's language for an auth email (ADR 0016 section 3); the
  // domain user may not exist yet in the middle of sign-up.
  const emailLocaleFor = async (authUserId: string) =>
    recipientEmailLocale({
      recipientLocale: (await findUserByAuthUserId(db, authUserId))?.locale,
      defaultLocale: config.defaultLocale,
    });

  const auth = betterAuth({
    baseURL: config.betterAuthUrl,
    secret: config.betterAuthSecret,
    trustedOrigins: [config.webOrigin],
    logger: { disabled: config.logLevel === "silent" },
    rateLimit: {
      enabled: config.authRateLimit,
      storage: "database",
      ...DEFAULT_AUTH_RATE_LIMIT,
      customRules: AUTH_RATE_LIMIT_RULES,
    },
    advanced: {
      // better-auth skips its origin and callback URL checks when NODE_ENV
      // is "test"; keep them on so the test suite exercises what production
      // runs (a reset link may only lead back to WEB_ORIGIN, for instance).
      disableOriginCheck: false,
      // Only the IP the bridge below resolved (see ./rate-limit.ts); also
      // what session.ipAddress and the auth.login audit event record.
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    database: drizzleAdapter(db, {
      provider: "pg",
      schemaName: "auth",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      // Verification cannot gate sign-in until invitations require verified
      // addresses (#27); verification emails are still sent when SMTP exists.
      requireEmailVerification: false,
      // Stated as "1 hour" in the reset email and on the web pages, and the
      // same minimum the web forms enforce; keep them in step.
      minPasswordLength: 8,
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mailer.sendPasswordResetEmail({
          to: user.email,
          url,
          locale: await emailLocaleFor(user.id),
        });
      },
    },
    emailVerification: {
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.sendVerificationEmail({
          to: user.email,
          url,
          locale: await emailLocaleFor(user.id),
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Every account creation path (email sign-up today, social and
          // SSO later) passes here. With closed sign-up, only the first
          // account may be created, and only with the one-time setup token;
          // consuming it is atomic, so concurrent attempts cannot both win.
          before: async (user, context) => {
            // An open invitation for exactly this address authorizes the
            // account even while sign-up is closed. When the link was
            // emailed, holding it proves the mailbox: the address counts as
            // verified.
            const invitationToken = context?.headers?.get(
              INVITATION_TOKEN_HEADER,
            );
            if (invitationToken) {
              const invitation = await previewInvitation(
                db,
                hashToken(invitationToken),
              );
              if (
                invitation?.status === "pending" &&
                invitation.email === user.email.toLowerCase()
              ) {
                return invitation.delivery === "email"
                  ? { data: { ...user, emailVerified: true } }
                  : undefined;
              }
            }
            if (config.signup === "open") {
              return;
            }
            const token = context?.headers?.get(SETUP_TOKEN_HEADER);
            const allowed =
              typeof token === "string" &&
              token.length > 0 &&
              (await countUsers(db)) === 0 &&
              (await consumeSetupToken(db, hashSetupToken(token)));
            if (!allowed) {
              throw new APIError("FORBIDDEN", {
                message: "Sign-up is disabled on this installation.",
                code: "SIGNUP_DISABLED",
              });
            }
            // The operator who holds the setup token is trusted with the
            // address they chose for the owner account.
            return { data: { ...user, emailVerified: true } };
          },
          // Mirror every auth user into the installation-level domain users
          // table (the row tenants reference via memberships).
          // The account keeps the language its sign-up page was shown in:
          // the instance default, else the browser's (ADR 0016).
          after: async (user, context) => {
            const domainUser = await provisionDomainUser(db, {
              authUserId: user.id,
              email: user.email,
              name: user.name,
              locale: resolveLocale([
                config.defaultLocale,
                localeFromAcceptLanguage(
                  context?.headers?.get("accept-language"),
                ),
              ]),
            });
            if (config.signup === "closed") {
              await recordSetupOwner(db, domainUser.id);
            }
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
      // Never derive the URL from the client-controlled Host header.
      const url = new URL(request.url, config.betterAuthUrl);
      const headers = fromNodeHeaders(request.headers);
      // request.clientIp honours only trusted proxy hops and, with a valid
      // proxy secret, the frontend's forwarded address (client-address.ts);
      // a client-sent value of this header is replaced.
      headers.set(CLIENT_IP_HEADER, request.clientIp);
      const req = new Request(url.toString(), {
        method: request.method,
        headers,
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
