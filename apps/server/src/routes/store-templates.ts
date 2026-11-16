import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, DataProcessingError, type DataPolicy } from "@netrics/domain";
import type { Database } from "@netrics/database";
import type { ConnectorRegistry } from "@netrics/connector-runtime";
import {
  storeTemplateApplyErrorSchema,
  storeTemplateApplyRequestSchema,
  storeTemplateCopyRequestSchema,
  storeTemplateDashboardErrorSchema,
  storeTemplateInstallListSchema,
  storeTemplatePlanSchema,
  storeTemplateOptionsSchema,
  storeTemplateProductsRequestSchema,
  storeTemplateProductsSchema,
  storeTemplateRequestSchema,
  storeTemplateResultSchema,
  storeTemplateScopeQuerySchema,
  storeTemplateScopeRequestSchema,
  storeTemplateScopeSchema,
  storeTemplateUpdateSchema,
} from "@netrics/contracts";
import type { AuthService } from "../auth/index.js";
import { createStoreProductService } from "../dashboards/store-template-products.js";
import {
  createStoreTemplateService,
  type StoreIconFetcher,
} from "../dashboards/store-template-service.js";
import {
  createStoreTemplateUpdateService,
  StoreUpdateDecisionMissing,
  StoreUpdateReviewChanged,
  StoreUpdateScopeNotApplicable,
  StoreUpdateUnmergeable,
} from "../dashboards/store-template-updates.js";
import type { StoreTemplateDefinition } from "../dashboards/store-template.js";
import { DataServiceError } from "../data/service.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { createRequireSession } from "./session.js";
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
 * The app scope of a scope-plan query: comma-separated connection ids and
 * `<connectionId>:<appId>`; null when either is malformed.
 */
function scopeChoice(query: unknown) {
  const parsed = storeTemplateScopeQuerySchema.safeParse(query);
  if (!parsed.success) return null;
  const connections = z
    .array(z.uuid())
    .min(1)
    .safeParse(parsed.data.connections.split(",").map((id) => id.trim()));
  if (!connections.success) return null;
  if (parsed.data.appScope === undefined)
    return { connections: connections.data, appScope: null };
  const cut = parsed.data.appScope.indexOf(":");
  const appScope = storeTemplateScopeRequestSchema.shape.appScope.safeParse({
    connectionId: parsed.data.appScope.slice(0, cut),
    appId: parsed.data.appScope.slice(cut + 1),
  });
  if (cut < 0 || !appScope.success || !appScope.data) return null;
  return { connections: connections.data, appScope: appScope.data };
}

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
    /** Fetches the icons app slides lack (#709); none: no fetch. */
    fetchIcons?: StoreIconFetcher;
  },
) {
  const service = createStoreTemplateService(deps),
    updates = createStoreTemplateUpdateService(deps),
    products = createStoreProductService(deps);
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
            return applyError(reply, error);
          }
        },
      );
      scope.get(
        `${path}/installs/:requestId/scope`,
        {
          schema: routeSchema({
            summary:
              "Read the store connections and app scope an install is built from",
            tags: ["dashboards"],
            response: storeTemplateScopeSchema,
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
            return storeTemplateScopeSchema.parse(
              await updates.scope(access, params.data.requestId),
            );
          } catch (error) {
            return sendError(reply, ...failed(error));
          }
        },
      );
      // Product identity (#708): icon, paid or free and linked website.
      scope.get(
        `${path}/installs/:requestId/products`,
        {
          schema: routeSchema({
            summary:
              "Read an install's products with their icon, paid or free and linked website",
            tags: ["dashboards"],
            response: storeTemplateProductsSchema,
            errors: [403, 404, 409, 413, 503],
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
            return storeTemplateProductsSchema.parse(
              await products.read(access, params.data.requestId),
            );
          } catch (error) {
            return sendError(reply, ...failed(error));
          }
        },
      );
      scope.put(
        `${path}/installs/:requestId/products`,
        {
          schema: routeSchema({
            summary:
              "Set the paid or free choice and linked website of an install's products",
            tags: ["dashboards"],
            body: storeTemplateProductsRequestSchema,
            response: storeTemplateProductsSchema,
            errors: [400, 403, 404, 409, 413, 503],
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
          const input = parseBody(
            storeTemplateProductsRequestSchema,
            request,
            reply,
          );
          if (!input) return;
          try {
            reply.header("cache-control", "no-store");
            return storeTemplateProductsSchema.parse(
              await products.update(access, params.data.requestId, input),
            );
          } catch (error) {
            return sendError(reply, ...failed(error));
          }
        },
      );
      scope.get(
        `${path}/installs/:requestId/scope-plan`,
        {
          schema: routeSchema({
            summary:
              "Compare an install's records with the same template built for other connections or another app scope",
            tags: ["dashboards"],
            querystring: storeTemplateScopeQuerySchema,
            response: storeTemplatePlanSchema,
            errors: [403, 404, 409, 413, 503],
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
          const choice = scopeChoice(request.query);
          if (!choice) return sendError(reply, 400, "invalid_request");
          try {
            reply.header("cache-control", "no-store");
            return storeTemplatePlanSchema.parse(
              await updates.scopePlan(access, params.data.requestId, choice),
            );
          } catch (error) {
            return sendError(reply, ...failed(error));
          }
        },
      );
      scope.put(
        `${path}/installs/:requestId/scope`,
        {
          schema: routeSchema({
            summary:
              "Change the connections or app scope of an install as data drafts and an updated dashboard copy",
            tags: ["dashboards"],
            body: storeTemplateScopeRequestSchema,
            response: storeTemplateUpdateSchema,
            errors: [400, 403, 404, 409, 413, 503],
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
          const input = parseBody(
            storeTemplateScopeRequestSchema,
            request,
            reply,
          );
          if (!input) return;
          try {
            reply.header("cache-control", "no-store");
            return storeTemplateUpdateSchema.parse(
              await updates.changeScope(access, params.data.requestId, input),
            );
          } catch (error) {
            return applyError(reply, error);
          }
        },
      );
      scope.post(
        `${path}/installs/:requestId/updates/:updateId/close`,
        {
          schema: routeSchema({
            summary:
              "Close an applied store-template update; its drafts stay as ordinary drafts",
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
          "Put the updated copy of a store-template dashboard on every screen of the original in one step, archiving the original",
        ],
        [
          "swap-back",
          "Put the archived original of a swapped store-template dashboard back on its screens, archiving the copy",
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
            const params = updateDashboardParamsSchema.safeParse(
              request.params,
            );
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
              return dashboardError(reply, error);
            }
          },
        );
      scope.post(
        `${path}/updates/:updateId/dashboards/:key/copy`,
        {
          schema: routeSchema({
            summary:
              "Create the updated copy of a store-template dashboard, unassigned from screens, once the update's data is published",
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
            return dashboardError(reply, error);
          }
        },
      );
      done();
    },
    { prefix: "/v1" },
  );
}
