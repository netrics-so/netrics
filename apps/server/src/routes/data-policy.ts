import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  dataPolicyOverrideSchema,
  dataPolicyResponseSchema,
} from "@netrics/contracts";
import { type DataPolicy } from "@netrics/domain";
import {
  adminSetDataPolicy,
  resolveDataPolicy,
  findWorkspace,
  withWorkspace,
  insertAuditEvent,
  type Database,
} from "@netrics/database";
import type { AuthService } from "../auth/index.js";
import { createRequireInstallationAdmin } from "./principal.js";
import { parseBody, sendError } from "./access.js";
import { routeSchema } from "./openapi.js";

/** Installation/tier controls never inherit workspace editing permissions. */
export function registerDataPolicyRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authService: AuthService;
    policy: DataPolicy;
  },
) {
  for (const method of ["GET", "PUT"] as const)
    app.route({
      method,
      url: "/v1/admin/workspaces/:workspaceId/data-policy",
      onRequest: createRequireInstallationAdmin({
        ...deps,
        scope:
          method === "GET"
            ? "installation:data-policy:read"
            : "installation:data-policy:write",
      }),
      schema: routeSchema({
        summary:
          method === "GET"
            ? "Read effective workspace data policy"
            : "Replace workspace data policy overrides",
        tags: ["admin"],
        admin: true,
        response: dataPolicyResponseSchema,
        ...(method === "PUT" ? { body: dataPolicyOverrideSchema } : {}),
        errors: [400, 403, 404, 503],
      }),
      handler: async (request, reply) => {
        const parsed = z
          .object({ workspaceId: z.uuid() })
          .safeParse(request.params);
        if (!parsed.success)
          return sendError(reply, 404, "workspace_not_found");
        const { workspaceId } = parsed.data;
        const overrides =
          method === "PUT"
            ? parseBody(dataPolicyOverrideSchema, request, reply)
            : null;
        if (method === "PUT" && !overrides) return;
        try {
          const result = await withWorkspace(
            deps.db,
            { workspaceId },
            async (tx) => {
              const workspace = await findWorkspace(tx, workspaceId);
              if (!workspace) return null;
              if (overrides) {
                if (!(await adminSetDataPolicy(tx, workspaceId, overrides)))
                  return null;
                await insertAuditEvent(tx, {
                  workspaceId,
                  action: "data.policy_updated",
                  target: workspaceId,
                  actorUserId:
                    request.principal?.kind === "user"
                      ? request.principal.identity.domainUserId
                      : null,
                  metadata: { keys: Object.keys(overrides) },
                });
              }
              return resolveDataPolicy(tx, workspaceId, deps.policy);
            },
          );
          return result ?? sendError(reply, 404, "workspace_not_found");
        } catch {
          return sendError(reply, 503, "data_policy_failed");
        }
      },
    });
}
