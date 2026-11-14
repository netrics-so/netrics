import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, DataProcessingError, type DataPolicy } from "@netrics/domain";
import type { Database } from "@netrics/database";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  storeTemplateApplyErrorSchema,
  storeTemplateApplyRequestSchema,
  storeTemplateInstallListSchema,
  storeTemplatePlanSchema,
  storeTemplateOptionsSchema,
  storeTemplateRequestSchema,
  storeTemplateResultSchema,
  storeTemplateUpdateSchema,
} from "@netrics/contracts";
import type { AuthService } from "../auth/index.js";
import { createStoreTemplateService } from "../dashboards/store-template-service.js";
import {
  createStoreTemplateUpdateService,
  StoreUpdateDecisionMissing,
} from "../dashboards/store-template-updates.js";
import type { StoreTemplateDefinition } from "../dashboards/store-template.js";
import { DataServiceError } from "../data/service.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { createRequireSession } from "./session.js";
import { routeSchema } from "./openapi.js";

const installParamsSchema = z.object({ requestId: z.uuid() });

export function registerStoreTemplateRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    registry: ConnectorRegistry;
    authService: AuthService;
    now?: () => Date;
    policy?: DataPolicy;
    /** The newest store template; tests pass other versions. */
    template?: StoreTemplateDefinition;
  },
) {
  const service = createStoreTemplateService(deps),
    updates = createStoreTemplateUpdateService(deps);
  const failed = (error: unknown) =>
    error instanceof DataServiceError
      ? ([error.status, error.code] as const)
      : ([503, "data_operation_failed"] as const);
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
      scope.get(
        `${path}/installs`,
        {
          schema: routeSchema({
            summary:
              "List store-template installs and whether a newer template version is available",
            tags: ["dashboards"],
            response: storeTemplateInstallListSchema,
            errors: [403, 404, 503],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) return;
          if (!can(access.role, "dashboards:view"))
            return sendError(reply, 403, "forbidden");
          try {
            reply.header("cache-control", "no-store");
            return storeTemplateInstallListSchema.parse(
              await updates.list(access),
            );
          } catch (error) {
            return sendError(reply, ...failed(error));
          }
        },
      );
      scope.get(
        `${path}/installs/:requestId/update`,
        {
          schema: routeSchema({
            summary:
              "Compare an install's records with the newest store template, item by item",
            tags: ["dashboards"],
            response: storeTemplatePlanSchema,
            errors: [403, 404, 409, 503],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) return;
          if (!can(access.role, "data:edit"))
            return sendError(reply, 403, "forbidden");
          const params = installParamsSchema.safeParse(request.params);
          if (!params.success)
            return sendError(reply, 404, "store_template_not_found");
          try {
            reply.header("cache-control", "no-store");
            return storeTemplatePlanSchema.parse(
              await updates.plan(access, params.data.requestId),
            );
          } catch (error) {
            return sendError(reply, ...failed(error));
          }
        },
      );
      scope.post(
        `${path}/installs/:requestId/update`,
        {
          schema: routeSchema({
            summary:
              "Apply a store-template update as data drafts, with a choice per conflicting item",
            tags: ["dashboards"],
            body: storeTemplateApplyRequestSchema,
            response: storeTemplateUpdateSchema,
            errors: [400, 403, 404, 409, 413, 503],
            errorSchemas: { 400: storeTemplateApplyErrorSchema },
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) return;
          if (
            !can(access.role, "data:edit") ||
            !can(access.role, "dashboards:create")
          )
            return sendError(reply, 403, "forbidden");
          const params = installParamsSchema.safeParse(request.params);
          if (!params.success)
            return sendError(reply, 404, "store_template_not_found");
          const input = parseBody(
            storeTemplateApplyRequestSchema,
            request,
            reply,
          );
          if (!input) return;
          try {
            reply.header("cache-control", "no-store");
            return storeTemplateUpdateSchema.parse(
              await updates.apply(access, params.data.requestId, input),
            );
          } catch (error) {
            if (error instanceof StoreUpdateDecisionMissing)
              return reply.code(400).send(
                storeTemplateApplyErrorSchema.parse({
                  error: error.code,
                  refs: error.refs,
                }),
              );
            if (error instanceof DataProcessingError)
              return sendError(reply, 400, error.code);
            return sendError(reply, ...failed(error));
          }
        },
      );
      done();
    },
    { prefix: "/v1" },
  );
}
