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
