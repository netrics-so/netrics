import type { FastifyInstance } from "fastify";

import {
  metricQueryRequestSchema,
  metricQueryResponseSchema,
  workspaceMetricListResponseSchema,
} from "@netrics/contracts";
import { withWorkspace, type Database } from "@netrics/database";
import { can } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { listMetrics, queryMetric } from "../metrics/query.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

export interface MetricRouteDeps {
  authService: AuthService;
  db: Database;
}

export function registerMetricRoutes(
  app: FastifyInstance,
  deps: MetricRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.get(
        "/workspaces/:workspaceId/metrics",
        {
          schema: routeSchema({
            summary: "Metrics the workspace's connections provide",
            tags: ["metrics"],
            response: workspaceMetricListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const metrics = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) => listMetrics(tx, access.workspaceId),
          );
          return workspaceMetricListResponseSchema.parse({ metrics });
        },
      );

      // POST because the request carries a structured dimension filter; it
      // reads only.
      scope.post(
        "/workspaces/:workspaceId/metrics/query",
        {
          schema: routeSchema({
            summary: "Value, change and sparkline of a metric for a period",
            tags: ["metrics"],
            body: metricQueryRequestSchema,
            response: metricQueryResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "connections:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(metricQueryRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const result = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) => queryMetric(tx, access.workspaceId, body),
          );
          if (!result.ok) {
            return sendError(reply, result.status, result.error);
          }
          return metricQueryResponseSchema.parse(result.value);
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
