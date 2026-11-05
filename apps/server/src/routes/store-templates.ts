import type { FastifyInstance } from "fastify";
import { can, DataProcessingError, type DataPolicy } from "@netrics/domain";
import type { Database } from "@netrics/database";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  storeTemplateOptionsSchema,
  storeTemplateRequestSchema,
  storeTemplateResultSchema,
} from "@netrics/contracts";
import type { AuthService } from "../auth/index.js";
import { createStoreTemplateService } from "../dashboards/store-template-service.js";
import { DataServiceError } from "../data/service.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { createRequireSession } from "./session.js";
import { routeSchema } from "./openapi.js";

export function registerStoreTemplateRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    registry: ConnectorRegistry;
    authService: AuthService;
    now?: () => Date;
    policy?: DataPolicy;
  },
) {
  const service = createStoreTemplateService(deps);
  void app.register(
    (scope, _options, done) => {
      scope.addHook("onRequest", createRequireSession(deps.authService));
      const path = "/workspaces/:workspaceId/dashboard-templates/stores";
      scope.get(
        path,
        {
          schema: routeSchema({
            summary: "Choose store connections and confirmed app identities",
            tags: ["dashboards"],
            response: storeTemplateOptionsSchema,
            errors: [403, 404, 413, 503],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) return;
          if (
            !can(access.role, "dashboards:create") ||
            !can(access.role, "data:edit")
          )
            return sendError(reply, 403, "forbidden");
          try {
            reply.header("cache-control", "no-store");
            return storeTemplateOptionsSchema.parse(
              await service.options(access),
            );
          } catch (error) {
            return sendError(
              reply,
              error instanceof DataServiceError ? error.status : 503,
              error instanceof DataServiceError
                ? error.code
                : "data_operation_failed",
            );
          }
        },
      );
      scope.post(
        path,
        {
          schema: routeSchema({
            summary:
              "Install editable store preparations, measures and a dashboard atomically",
            tags: ["dashboards"],
            body: storeTemplateRequestSchema,
            response: storeTemplateResultSchema,
            errors: [400, 403, 404, 409, 413, 503],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) return;
          if (
            !can(access.role, "dashboards:create") ||
            !can(access.role, "data:edit") ||
            !can(access.role, "data:publish")
          )
            return sendError(reply, 403, "forbidden");
          const input = parseBody(storeTemplateRequestSchema, request, reply);
          if (!input) return;
          try {
            reply.header("cache-control", "no-store");
            return storeTemplateResultSchema.parse(
              await service.install(access, input),
            );
          } catch (error) {
            return sendError(
              reply,
              error instanceof DataServiceError
                ? error.status
                : error instanceof DataProcessingError
                  ? 400
                  : 503,
              error instanceof DataServiceError ||
                error instanceof DataProcessingError
                ? error.code
                : "data_operation_failed",
            );
          }
        },
      );
      done();
    },
    { prefix: "/v1" },
  );
}
