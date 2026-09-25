import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  bootstrapRequestSchema,
  bootstrapResponseSchema,
  errorResponseSchema,
  meResponseSchema,
} from "@netrics/contracts";
import {
  BOOTSTRAP_CONFLICT_SQLSTATE,
  bootstrapWorkspace,
  findUserById,
  hasSqlstate,
  listMembershipsForUser,
  type Database,
} from "@netrics/database";

import type { AuthService, SessionIdentity } from "../auth/index.js";

declare module "fastify" {
  interface FastifyRequest {
    sessionIdentity?: SessionIdentity;
  }
}

export interface SessionRouteDeps {
  authService: AuthService;
  db: Database;
}

export function unauthorized(reply: FastifyReply) {
  return reply
    .code(401)
    .send(errorResponseSchema.parse({ error: "unauthorized" }));
}

/**
 * preHandler that resolves the better-auth session into
 * request.sessionIdentity (401 otherwise). Shared by every /v1 route plugin.
 */
export function createRequireSession(authService: AuthService) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = await authService.getSessionIdentity(request.headers);
    if (!identity) {
      return unauthorized(reply);
    }
    request.sessionIdentity = identity;
  };
}

/**
 * Session-protected routes under /v1. The plugin scope encapsulates the
 * requireSession preHandler so public routes (health, /api/auth/*) are
 * unaffected.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("preHandler", requireSession);

      scope.get("/me", async (request, reply) => {
        const identity = request.sessionIdentity!;
        const user = await findUserById(deps.db, identity.domainUserId);
        if (!user) {
          return unauthorized(reply);
        }
        const memberships = await listMembershipsForUser(deps.db, user.id);
        return meResponseSchema.parse({
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
          },
          memberships,
        });
      });

      scope.post("/bootstrap", async (request, reply) => {
        const identity = request.sessionIdentity!;
        const parsed = bootstrapRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send(errorResponseSchema.parse({ error: "invalid_request" }));
        }
        try {
          const workspaceId = await bootstrapWorkspace(deps.db, {
            name: parsed.data.workspaceName,
            ownerUserId: identity.domainUserId,
          });
          return bootstrapResponseSchema.parse({
            workspace: { id: workspaceId, name: parsed.data.workspaceName },
          });
        } catch (error) {
          if (hasSqlstate(error, BOOTSTRAP_CONFLICT_SQLSTATE)) {
            return reply.code(409).send(
              errorResponseSchema.parse({
                error: "workspace_already_exists",
              }),
            );
          }
          throw error;
        }
      });

      done();
    },
    { prefix: "/v1" },
  );
}
