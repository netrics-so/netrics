import { rethrowWorkspaceGone, type Database } from "@netrics/database";
import type { FastifyInstance } from "fastify";
import { can, DataProcessingError, type DataPolicy } from "@netrics/domain";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  developerTemplateOptionsSchema,
  developerTemplateRequestSchema,
  developerTemplateResultSchema,
} from "@netrics/contracts";
import type { AuthService } from "../auth/index.js";
import { createDeveloperTemplateService } from "../dashboards/developer-template-service.js";
import { createDeveloperTemplateUpdateService } from "../dashboards/developer-template-updates.js";
import type { StoreTemplateDefinition } from "../dashboards/store-template.js";
import { DataServiceError } from "../data/service.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { createRequireSession } from "./session.js";
import { routeSchema } from "./openapi.js";
import {
  registerTemplateDashboardRoutes,
  registerTemplateUpdateRoutes,
} from "./template-updates.js";

/**
 * The Developer Portfolio template (#876): what an install can read, the
 * install, and its template updates (the App Portfolio's update routes,
 * for this template's installs only).
 */
export function registerDeveloperTemplateRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    registry: ConnectorRegistry;
    authService: AuthService;
    now?: () => Date;
    policy?: DataPolicy;
    /** The newest Developer Portfolio template; tests pass others. */
    template?: StoreTemplateDefinition;
  },
) {
  const service = createDeveloperTemplateService(deps),
    updates = createDeveloperTemplateUpdateService(deps);
  const failed = (error: unknown) =>
    [
      error instanceof DataServiceError
        ? error.status
        : error instanceof DataProcessingError
          ? 400
          : 503,
      error instanceof DataServiceError || error instanceof DataProcessingError
        ? error.code
        : "data_operation_failed",
    ] as const;
  void app.register(
    (scope, _options, done) => {
      scope.addHook("onRequest", createRequireSession(deps.authService));
      const path = "/workspaces/:workspaceId/dashboard-templates/developer";
      scope.get(
        path,
        {
          schema: routeSchema({
            summary:
              "Choose the connections, resources and projects of a Developer Portfolio",
            tags: ["dashboards"],
            response: developerTemplateOptionsSchema,
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
            return developerTemplateOptionsSchema.parse(
              await service.options(access),
            );
          } catch (error) {
            rethrowWorkspaceGone(error);
            return sendError(reply, ...failed(error));
          }
        },
      );
      scope.post(
        path,
        {
          schema: routeSchema({
            summary:
              "Install the Developer Portfolio's editable preparations, measures and dashboard atomically",
            tags: ["dashboards"],
            body: developerTemplateRequestSchema,
            response: developerTemplateResultSchema,
            errors: [400, 403, 404, 409, 413, 503],
            errorDescriptions: {
              413: "data_source_row_limit: the connections' resources are past the workspace's row limit; developer_default_links_limit: a connection has more selected resources in its project than one default lookup holds (9,999)",
            },
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
          const input = parseBody(
            developerTemplateRequestSchema,
            request,
            reply,
          );
          if (!input) return;
          try {
            reply.header("cache-control", "no-store");
            return developerTemplateResultSchema.parse(
              await service.install(access, input),
            );
          } catch (error) {
            rethrowWorkspaceGone(error);
            return sendError(reply, ...failed(error));
          }
        },
      );
      registerTemplateUpdateRoutes(
        scope,
        deps,
        path,
        updates,
        "Developer Portfolio",
        "Developer Portfolio template",
      );
      registerTemplateDashboardRoutes(
        scope,
        deps,
        path,
        updates,
        "Developer Portfolio",
      );
      done();
    },
    { prefix: "/v1" },
  );
}
