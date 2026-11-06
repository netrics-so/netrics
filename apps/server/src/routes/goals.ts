import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  createGoalRequestSchema,
  deleteGoalResponseSchema,
  errorResponseSchema,
  goalListResponseSchema,
  goalResponseSchema,
  updateGoalRequestSchema,
} from "@netrics/contracts";
import type { Database } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { createGoalService, type GoalResult } from "../goals/service.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

// HTTP layer for goals (ADR 0019 section 4, #335); the work happens in
// ../goals. Permissions reuse the dashboard actions, as themes do: viewers
// read, editors create and update, owners and admins delete.

export interface GoalRouteDeps {
  authService: AuthService;
  db: Database;
  exchangeRates?: boolean;
  /** The clock; tests pin it. */
  now?: () => Date;
}

const goalParamsSchema = z.object({ goalId: z.uuid() });

function unwrap<T>(result: GoalResult<T>, reply: FastifyReply): T | null {
  if (result.ok) {
    return result.value;
  }
  void reply
    .code(result.status)
    .send(errorResponseSchema.parse({ error: result.error }));
  return null;
}

export function registerGoalRoutes(
  app: FastifyInstance,
  deps: GoalRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const goals = createGoalService({
    db: deps.db,
    exchangeRates: deps.exchangeRates ?? false,
    ...(deps.now ? { now: deps.now } : {}),
  });

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

  function goalId(request: FastifyRequest, reply: FastifyReply) {
    const params = goalParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "goal_not_found");
      return null;
    }
    return params.data.goalId;
  }

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);

      scope.get(
        "/workspaces/:workspaceId/goals",
        {
          schema: routeSchema({
            summary: "List the workspace's goals with their current progress",
            tags: ["goals"],
            response: goalListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          if (!access) {
            return;
          }
          return goalListResponseSchema.parse({
            goals: await goals.list(access),
          });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/goals",
        {
          schema: routeSchema({
            summary:
              "Create a goal (400 aggregation_not_supported, period_not_supported, goal_direction_unsupported or currency_required when the metric binding cannot be one)",
            tags: ["goals"],
            body: createGoalRequestSchema,
            response: goalResponseSchema,
            errors: [403, 404, 409],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:create");
          if (!access) {
            return;
          }
          const body = parseBody(createGoalRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const goal = unwrap(await goals.create(access, body), reply);
          if (!goal) {
            return;
          }
          return goalResponseSchema.parse({ goal });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/goals/:goalId",
        {
          schema: routeSchema({
            summary: "Get a goal with its current progress",
            tags: ["goals"],
            response: goalResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          const id = access && goalId(request, reply);
          if (!access || !id) {
            return;
          }
          const goal = unwrap(await goals.get(access, id), reply);
          if (!goal) {
            return;
          }
          return goalResponseSchema.parse({ goal });
        },
      );

      scope.put(
        "/workspaces/:workspaceId/goals/:goalId",
        {
          schema: routeSchema({
            summary:
              "Replace a goal (409 version_conflict when the version is stale)",
            tags: ["goals"],
            body: updateGoalRequestSchema,
            response: goalResponseSchema,
            errors: [403, 404, 409],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          const id = access && goalId(request, reply);
          if (!access || !id) {
            return;
          }
          const body = parseBody(updateGoalRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const goal = unwrap(await goals.update(access, id, body), reply);
          if (!goal) {
            return;
          }
          return goalResponseSchema.parse({ goal });
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/goals/:goalId",
        {
          schema: routeSchema({
            summary:
              "Delete a goal, also when gauges use it; answers the dashboards that did",
            tags: ["goals"],
            response: deleteGoalResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:delete");
          const id = access && goalId(request, reply);
          if (!access || !id) {
            return;
          }
          const removed = unwrap(await goals.remove(access, id), reply);
          if (!removed) {
            return;
          }
          return deleteGoalResponseSchema.parse(removed);
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
