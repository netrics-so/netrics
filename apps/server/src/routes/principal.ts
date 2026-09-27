import type { FastifyReply, FastifyRequest } from "fastify";

import {
  isInstanceAdmin,
  resolvePrincipalToken,
  type Database,
  type TokenPrincipal,
} from "@netrics/database";
import type { InstallationScope } from "@netrics/domain";

import type { AuthService, SessionIdentity } from "../auth/index.js";
import { hashToken } from "../tokens.js";
import { sendError } from "./access.js";

/** Who is calling (ADR 0009). */
export type Principal =
  | { kind: "user"; identity: SessionIdentity }
  | { kind: "service"; token: TokenPrincipal }
  | { kind: "device"; token: TokenPrincipal };

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const BEARER = /^Bearer (nt_[A-Za-z0-9_-]{16,128})$/;

/**
 * Resolves the caller: a bearer token when an Authorization header is
 * present (an invalid token is a hard 401, never a fallback to the cookie),
 * otherwise the session cookie. Leaves request.principal unset when there is
 * neither.
 */
async function resolvePrincipal(
  request: FastifyRequest,
  authService: AuthService,
  db: Database,
): Promise<Principal | "invalid" | null> {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const match = BEARER.exec(header);
    if (!match) {
      return "invalid";
    }
    const token = await resolvePrincipalToken(db, hashToken(match[1]!));
    if (!token) {
      return "invalid";
    }
    return token.kind === "service"
      ? { kind: "service", token }
      : { kind: "device", token };
  }
  const identity = await authService.getSessionIdentity(request.headers);
  return identity ? { kind: "user", identity } : null;
}

export interface AdminAccessOptions {
  authService: AuthService;
  db: Database;
  /** Scope a service token needs; instance-admin users always qualify. */
  scope: InstallationScope;
}

/**
 * onRequest guard for the installation admin API: an instance-admin user
 * session, or a service token holding `scope`. Devices never qualify.
 */
export function createRequireInstallationAdmin(options: AdminAccessOptions) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolvePrincipal(
      request,
      options.authService,
      options.db,
    );
    if (principal === null || principal === "invalid") {
      return sendError(reply, 401, "unauthorized");
    }
    const allowed =
      principal.kind === "user"
        ? await isInstanceAdmin(options.db, principal.identity.domainUserId)
        : principal.kind === "service" &&
          principal.token.scopes.includes(options.scope);
    if (!allowed) {
      return sendError(reply, 403, "forbidden");
    }
    request.principal = principal;
  };
}
