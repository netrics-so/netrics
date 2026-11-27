import { rethrowWorkspaceGone, type Database } from "@netrics/database";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, DataProcessingError } from "@netrics/domain";
import {
  storeTemplateApplyErrorSchema,
  storeTemplateApplyRequestSchema,
  storeTemplateCopyRequestSchema,
  storeTemplateDashboardErrorSchema,
  storeTemplateInstallListSchema,
  storeTemplatePlanSchema,
  storeTemplateUpdateSchema,
} from "@netrics/contracts";
import {
  createStoreTemplateUpdateService,
  StoreUpdateDecisionMissing,
  StoreUpdateReviewChanged,
  StoreUpdateScopeNotApplicable,
  StoreUpdateUnmergeable,
} from "../dashboards/store-template-updates.js";
import { DataServiceError } from "../data/service.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { routeSchema } from "./openapi.js";

const installParamsSchema = z.object({ requestId: z.uuid() });
const updateParamsSchema = z.object({
  requestId: z.uuid(),
  updateId: z.uuid(),
});
const updateDashboardParamsSchema = z.object({
  updateId: z.uuid(),
  key: z.string().regex(/^dashboard:[a-z0-9:_-]{1,100}$/),
});

/**
 * A plan or an apply reads the install's items under the workspace's data
 * policy: past its row limit it is refused, never reported as up to date
 * (#913). A template names its own further 413s (`limits`).
 */
const ROW_LIMIT =
  "data_source_row_limit: the install's items are past the workspace's row limit";

/**
 * The template-update routes under `path` (11E): the installs and whether
 * an update is offered, its plan and apply (registerTemplateDashboardRoutes
 * has the rest). The App Portfolio and the Developer Portfolio (#876) each
 * register them with their own update service, which only finds its own
 * template's installs.
 */
export function registerTemplateUpdateRoutes(
  scope: FastifyInstance,
  deps: { db: Database },
  path: string,
  updates: ReturnType<typeof createStoreTemplateUpdateService>,
  /** How summaries name the template ("store-template"). */
  label: string,
  /** How summaries name its newest version ("store template"). */
  noun: string,
  /** The template's own 413s of a plan or an apply, after the row limit. */
  limits?: string,
) {
  const tooLarge = limits ? `${ROW_LIMIT}; ${limits}` : ROW_LIMIT;
  const failed = (error: unknown) =>
    error instanceof DataServiceError
      ? ([error.status, error.code] as const)
      : ([503, "data_operation_failed"] as const);
  /** Errors of applying an update or a scope change. */
  const applyError = (
    reply: Parameters<typeof sendError>[0],
    error: unknown,
  ) => {
    if (error instanceof StoreUpdateDecisionMissing)
      return reply.code(400).send(
        storeTemplateApplyErrorSchema.parse({
          error: error.code,
          refs: error.refs,
        }),
      );
    if (error instanceof StoreUpdateUnmergeable)
      return reply.code(409).send(
        storeTemplateApplyErrorSchema.parse({
          error: error.code,
          key: error.key,
          refs: error.refs,
          ...(error.paths.length ? { paths: error.paths } : {}),
        }),
      );
    if (error instanceof DataProcessingError)
      return sendError(reply, 400, error.code);
    return sendError(reply, ...failed(error));
  };
  scope.get(
    `${path}/installs`,
    {
      schema: routeSchema({
        summary: `List ${label} installs and whether a newer template version is available`,
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
        return storeTemplateInstallListSchema.parse(await updates.list(access));
      } catch (error) {
        rethrowWorkspaceGone(error);
        return sendError(reply, ...failed(error));
      }
    },
  );
  scope.get(
    `${path}/installs/:requestId/update`,
    {
      schema: routeSchema({
        summary: `Compare an install's records with the newest ${noun}, item by item`,
        tags: ["dashboards"],
        response: storeTemplatePlanSchema,
        errors: [403, 404, 409, 413, 503],
        errorDescriptions: { 413: tooLarge },
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
        rethrowWorkspaceGone(error);
        return sendError(reply, ...failed(error));
      }
    },
  );
  scope.post(
    `${path}/installs/:requestId/update`,
    {
      schema: routeSchema({
        summary: `Apply a ${label} update as data drafts, with a choice per conflicting item`,
        tags: ["dashboards"],
        body: storeTemplateApplyRequestSchema,
        response: storeTemplateUpdateSchema,
        errors: [400, 403, 404, 409, 413, 503],
        errorDescriptions: { 413: tooLarge },
        errorSchemas: {
          400: storeTemplateApplyErrorSchema,
          409: storeTemplateApplyErrorSchema,
        },
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
      const input = parseBody(storeTemplateApplyRequestSchema, request, reply);
      if (!input) return;
      try {
        reply.header("cache-control", "no-store");
        return storeTemplateUpdateSchema.parse(
          await updates.apply(access, params.data.requestId, input),
        );
      } catch (error) {
        rethrowWorkspaceGone(error);
        return applyError(reply, error);
      }
    },
  );
}

/**
 * The routes of an applied update under `path`: closing it, and its
 * updated dashboard's copy, swap and swap back.
 */
export function registerTemplateDashboardRoutes(
  scope: FastifyInstance,
  deps: { db: Database },
  path: string,
  updates: ReturnType<typeof createStoreTemplateUpdateService>,
  /** How summaries name the template ("store-template"). */
  label: string,
) {
  const failed = (error: unknown) =>
    error instanceof DataServiceError
      ? ([error.status, error.code] as const)
      : ([503, "data_operation_failed"] as const);
  scope.post(
    `${path}/installs/:requestId/updates/:updateId/close`,
    {
      schema: routeSchema({
        summary: `Close an applied ${label} update; its drafts stay as ordinary drafts`,
        tags: ["dashboards"],
        errors: [403, 404, 503],
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
      const params = updateParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendError(reply, 404, "store_template_update_not_found");
      try {
        await updates.closeUpdate(
          access,
          params.data.requestId,
          params.data.updateId,
        );
        return reply.code(204).send();
      } catch (error) {
        rethrowWorkspaceGone(error);
        return sendError(reply, ...failed(error));
      }
    },
  );
  /** Errors of the updated dashboard's copy, swap and swap back. */
  const dashboardError = (
    reply: Parameters<typeof sendError>[0],
    error: unknown,
  ) => {
    if (error instanceof StoreUpdateReviewChanged)
      return reply.code(409).send(
        storeTemplateDashboardErrorSchema.parse({
          error: error.code,
          records: error.records,
          ...(error.refs.length ? { refs: error.refs } : {}),
        }),
      );
    if (error instanceof StoreUpdateUnmergeable)
      return reply.code(409).send(
        storeTemplateDashboardErrorSchema.parse({
          error: error.code,
          key: error.key,
          refs: error.refs,
          ...(error.paths.length ? { paths: error.paths } : {}),
        }),
      );
    if (error instanceof StoreUpdateScopeNotApplicable)
      return reply.code(409).send(
        storeTemplateDashboardErrorSchema.parse({
          error: error.code,
          devices: error.devices,
        }),
      );
    return sendError(reply, ...failed(error));
  };
  for (const [action, summary] of [
    [
      "swap",
      `Put the updated copy of a ${label} dashboard on every screen of the original in one step, archiving the original`,
    ],
    [
      "swap-back",
      `Put the archived original of a swapped ${label} dashboard back on its screens, archiving the copy`,
    ],
  ] as const)
    scope.post(
      `${path}/updates/:updateId/dashboards/:key/${action}`,
      {
        schema: routeSchema({
          summary,
          tags: ["dashboards"],
          response: storeTemplateUpdateSchema,
          errors: [403, 404, 409, 503],
          errorSchemas: { 409: storeTemplateDashboardErrorSchema },
        }),
      },
      async (request, reply) => {
        const access = await resolveAccess(deps.db, request, reply);
        if (!access) return;
        if (
          !can(access.role, "dashboards:update") ||
          !can(access.role, "devices:manage")
        )
          return sendError(reply, 403, "forbidden");
        const params = updateDashboardParamsSchema.safeParse(request.params);
        if (!params.success)
          return sendError(reply, 404, "store_template_update_not_found");
        try {
          reply.header("cache-control", "no-store");
          const { updateId, key } = params.data;
          return storeTemplateUpdateSchema.parse(
            action === "swap"
              ? await updates.swap(access, updateId, key)
              : await updates.swapBack(access, updateId, key),
          );
        } catch (error) {
          rethrowWorkspaceGone(error);
          return dashboardError(reply, error);
        }
      },
    );
  scope.post(
    `${path}/updates/:updateId/dashboards/:key/copy`,
    {
      schema: routeSchema({
        summary: `Create the updated copy of a ${label} dashboard, unassigned from screens, once the update's data is published`,
        tags: ["dashboards"],
        body: storeTemplateCopyRequestSchema.nullish(),
        response: storeTemplateUpdateSchema,
        errors: [400, 403, 404, 409, 503],
        errorSchemas: { 409: storeTemplateDashboardErrorSchema },
      }),
    },
    async (request, reply) => {
      const access = await resolveAccess(deps.db, request, reply);
      if (!access) return;
      if (!can(access.role, "dashboards:create"))
        return sendError(reply, 403, "forbidden");
      const params = updateDashboardParamsSchema.safeParse(request.params);
      if (!params.success)
        return sendError(reply, 404, "store_template_update_not_found");
      const body = storeTemplateCopyRequestSchema
        .nullish()
        .safeParse(request.body);
      if (!body.success) return sendError(reply, 400, "invalid_request");
      try {
        reply.header("cache-control", "no-store");
        return storeTemplateUpdateSchema.parse(
          await updates.createCopy(
            access,
            params.data.updateId,
            params.data.key,
            {
              replace: body.data?.replace === true,
              discardCopyEdits: body.data?.discardCopyEdits === true,
            },
          ),
        );
      } catch (error) {
        rethrowWorkspaceGone(error);
        return dashboardError(reply, error);
      }
    },
  );
}
