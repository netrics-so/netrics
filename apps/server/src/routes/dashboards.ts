import { withWorkspace, findDashboard } from "@netrics/database";
import { DEFAULT_DATA_POLICY, type DataPolicy } from "@netrics/domain";
import {
  dashboardDimensionValuesInputSchema,
  dashboardDimensionValuesResponseSchema,
  dashboardDataQuerySchema,
  dashboardDataResponseSchema,
  dashboardMeasurePreviewSchema,
  compareMeasureQuerySchema,
  compareMeasureReadingsResponseSchema,
  publishedModelCatalogSchema,
} from "@netrics/contracts";
import {
  loadCompareSources,
  readCompareMeasure,
} from "../dashboards/compare-measure.js";
import {
  dashboardDimensionValues,
  queryDashboardData,
  queryDashboardMeasure,
  publishedModels,
  safeDataError,
} from "../dashboards/data.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createDashboardRequestSchema,
  dashboardListResponseSchema,
  dashboardResponseSchema,
  duplicateDashboardRequestSchema,
  replaceDashboardRequestSchema,
} from "@netrics/contracts";
import type { Database } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { createDashboardService, type Result } from "../dashboards/service.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer for dashboards (#49); the work happens in ../dashboards.

export interface DashboardRouteDeps {
  authService: AuthService;
  db: Database;
  policy?: DataPolicy;
  now?: () => Date;
}

const dashboardParamsSchema = z.object({ dashboardId: z.uuid() });

function unwrap<T>(result: Result<T>, reply: FastifyReply): T | null {
  if (!result.ok) {
    sendError(reply, result.status, result.error);
    return null;
  }
  return result.value;
}

export function registerDashboardRoutes(
  app: FastifyInstance,
  deps: DashboardRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const dashboards = createDashboardService(deps);

  /** Workspace access plus the permission; replies and returns null otherwise. */
  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    action: WorkspaceAction,
  ): Promise<WorkspaceAccess | null> {
    const access = await resolveAccess(deps.db, request, reply);
    if (!access) {
      return null;
    }
    if (!can(access.role, action)) {
      sendError(reply, 403, "forbidden");
      return null;
    }
    return access;
  }

  function dashboardId(request: FastifyRequest, reply: FastifyReply) {
    const params = dashboardParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "dashboard_not_found");
      return null;
    }
    return params.data.dashboardId;
  }

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.post(
        "/workspaces/:workspaceId/dashboards/models/:modelId/dimensions/:dimensionId/values",
        {
          schema: routeSchema({
            summary: "Search published dimension values",
            tags: ["dashboards"],
            body: dashboardDimensionValuesInputSchema,
            response: dashboardDimensionValuesResponseSchema,
            errors: [400, 403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "data:query");
          if (!access) return;
          const params = z
            .object({
              modelId: z.uuid(),
              dimensionId: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/),
            })
            .safeParse(request.params);
          if (!params.success)
            return sendError(reply, 404, "data_model_not_found");
          const body = parseBody(
            dashboardDimensionValuesInputSchema,
            request,
            reply,
          );
          if (!body) return;
          try {
            return await withWorkspace(
              deps.db,
              { workspaceId: access.workspaceId, userId: access.callerId },
              (tx) =>
                dashboardDimensionValues(
                  tx,
                  access.workspaceId,
                  params.data.modelId,
                  params.data.dimensionId,
                  body,
                  deps.now?.() ?? new Date(),
                  deps.policy,
                ),
              { isolationLevel: "repeatable read" },
            );
          } catch (error) {
            return sendError(reply, 400, safeDataError(error));
          }
        },
      );
      scope.get(
        "/workspaces/:workspaceId/dashboards/published-models",
        {
          schema: routeSchema({
            summary: "List published models for dashboard bindings",
            tags: ["dashboards"],
            response: publishedModelCatalogSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "data:query");
          if (!access) return;
          return withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) => publishedModels(tx, access.workspaceId),
          );
        },
      );
      scope.post(
        "/workspaces/:workspaceId/dashboards/data/preview",
        {
          schema: routeSchema({
            summary: "Query unsaved widgets against published models",
            tags: ["dashboards"],
            body: dashboardMeasurePreviewSchema,
            response: dashboardDataResponseSchema,
            errors: [400, 403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "data:query");
          if (!access) return;
          const body = parseBody(dashboardMeasurePreviewSchema, request, reply);
          if (!body) return;
          return withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => ({
              widgets: await (async () => {
                const results = [];
                const now = deps.now?.() ?? new Date();
                for (const widget of body.widgets)
                  results.push(
                    await queryDashboardMeasure(
                      tx,
                      access.workspaceId,
                      widget,
                      body.filters,
                      body.values,
                      now,
                      deps.policy ?? DEFAULT_DATA_POLICY,
                      access.locale,
                    ),
                  );
                return results;
              })(),
              values: body.values,
            }),
            { isolationLevel: "repeatable read" },
          );
        },
      );
      scope.post(
        "/workspaces/:workspaceId/dashboards/data/compare",
        {
          schema: routeSchema({
            summary:
              "Read compare widgets bound to published measures, saved or not",
            tags: ["dashboards"],
            body: compareMeasureQuerySchema,
            response: compareMeasureReadingsResponseSchema,
            errors: [400, 403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "data:query");
          if (!access) return;
          const body = parseBody(compareMeasureQuerySchema, request, reply);
          if (!body) return;
          reply.header("cache-control", "no-store");
          return withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const now = deps.now?.() ?? new Date();
              const sources = await loadCompareSources(tx, access.workspaceId);
              const widgets = [];
              for (const widget of body.widgets)
                widgets.push(
                  await readCompareMeasure(
                    tx,
                    access.workspaceId,
                    widget,
                    now,
                    {
                      policy: deps.policy ?? DEFAULT_DATA_POLICY,
                      locale: access.locale,
                      sources,
                    },
                  ),
                );
              return { widgets };
            },
            { isolationLevel: "repeatable read" },
          );
        },
      );
      scope.post(
        "/workspaces/:workspaceId/dashboards/:dashboardId/data",
        {
          schema: routeSchema({
            summary: "Query a dashboard with shared filters",
            tags: ["dashboards"],
            body: dashboardDataQuerySchema,
            response: dashboardDataResponseSchema,
            errors: [400, 403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "data:query");
          const id = access && dashboardId(request, reply);
          if (!access || !id) return;
          const body = parseBody(dashboardDataQuerySchema, request, reply);
          if (!body) return;
          try {
            return await withWorkspace(
              deps.db,
              { workspaceId: access.workspaceId, userId: access.callerId },
              async (tx) => {
                const dashboard = await findDashboard(
                  tx,
                  access.workspaceId,
                  id,
                );
                if (!dashboard) {
                  sendError(reply, 404, "dashboard_not_found");
                  return;
                }
                return queryDashboardData(
                  tx,
                  access.workspaceId,
                  dashboard.slides.flatMap((slide) => slide.widgets),
                  dashboard.dataFilters,
                  body.values,
                  deps.now?.() ?? new Date(),
                  deps.policy,
                  access.locale,
                );
              },
              { isolationLevel: "repeatable read" },
            );
          } catch (error) {
            sendError(reply, 400, safeDataError(error));
          }
        },
      );

      scope.get(
        "/workspaces/:workspaceId/dashboards",
        {
          schema: routeSchema({
            summary: "List dashboards",
            tags: ["dashboards"],
            response: dashboardListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          if (!access) {
            return;
          }
          return dashboardListResponseSchema.parse({
            dashboards: await dashboards.list(access),
          });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/dashboards",
        {
          schema: routeSchema({
            summary: "Create a dashboard",
            tags: ["dashboards"],
            body: createDashboardRequestSchema,
            response: dashboardResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:create");
          if (!access) {
            return;
          }
          const body = parseBody(createDashboardRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const dashboard = unwrap(
            await dashboards.create(access, body),
            reply,
          );
          if (!dashboard) {
            return;
          }
          return dashboardResponseSchema.parse({ dashboard });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/dashboards/:dashboardId",
        {
          schema: routeSchema({
            summary: "Get a dashboard with its tiles",
            tags: ["dashboards"],
            response: dashboardResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          const id = access && dashboardId(request, reply);
          if (!access || !id) {
            return;
          }
          const dashboard = unwrap(await dashboards.get(access, id), reply);
          if (!dashboard) {
            return;
          }
          return dashboardResponseSchema.parse({ dashboard });
        },
      );

      scope.put(
        "/workspaces/:workspaceId/dashboards/:dashboardId",
        {
          schema: routeSchema({
            summary:
              "Replace a dashboard's name and tiles (409 when the version is stale)",
            tags: ["dashboards"],
            body: replaceDashboardRequestSchema,
            response: dashboardResponseSchema,
            errors: [403, 404, 409],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          const id = access && dashboardId(request, reply);
          if (!access || !id) {
            return;
          }
          const body = parseBody(replaceDashboardRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const dashboard = unwrap(
            await dashboards.replace(access, id, body),
            reply,
          );
          if (!dashboard) {
            return;
          }
          return dashboardResponseSchema.parse({ dashboard });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/dashboards/:dashboardId/duplicate",
        {
          schema: routeSchema({
            summary: "Duplicate a dashboard",
            tags: ["dashboards"],
            body: duplicateDashboardRequestSchema,
            response: dashboardResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:create");
          const id = access && dashboardId(request, reply);
          if (!access || !id) {
            return;
          }
          const body = parseBody(
            duplicateDashboardRequestSchema,
            request,
            reply,
          );
          if (!body) {
            return;
          }
          const dashboard = unwrap(
            await dashboards.duplicate(access, id, body),
            reply,
          );
          if (!dashboard) {
            return;
          }
          return dashboardResponseSchema.parse({ dashboard });
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/dashboards/:dashboardId",
        {
          schema: routeSchema({
            summary: "Delete a dashboard",
            tags: ["dashboards"],
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:delete");
          const id = access && dashboardId(request, reply);
          if (!access || !id) {
            return;
          }
          const result = await dashboards.remove(access, id);
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return reply.code(204).send();
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
