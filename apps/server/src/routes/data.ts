import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import * as contracts from "@netrics/contracts";
import {
  can,
  DataProcessingError,
  parseDataFormula,
  type WorkspaceAction,
  type DataPolicy,
} from "@netrics/domain";
import type { Database } from "@netrics/database";
import type { AuthService } from "../auth/index.js";
import { createCompareMeasureService } from "../data/compare-measure.js";
import {
  createDataService,
  DataInUseError,
  DataServiceError,
} from "../data/service.js";
import {
  parseBody,
  resolveAccess,
  sendError,
  type WorkspaceAccess,
} from "./access.js";
import { createRequireSession } from "./session.js";
import { routeSchema } from "./openapi.js";

export function registerDataRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    authService: AuthService;
    now?: () => Date;
    policy?: DataPolicy;
  },
) {
  const service = createDataService(deps.db, deps.now, deps.policy);
  const compareMeasures = createCompareMeasureService({
    db: deps.db,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.policy ? { policy: deps.policy } : {}),
  });
  const sendDataError = (
    reply: FastifyReply,
    status: number,
    code: string,
    location: {
      fieldId?: string | undefined;
      nodeId?: string | undefined;
      count?: number | undefined;
    },
  ) => {
    const located = contracts.dataErrorResponseSchema.safeParse({
      error: code,
      ...(location.fieldId ? { fieldId: location.fieldId } : {}),
      ...(location.nodeId ? { nodeId: location.nodeId } : {}),
      ...(location.count ? { count: location.count } : {}),
    });
    // A location that does not fit the contract never turns the error into a 500.
    return located.success
      ? reply.code(status).send(located.data)
      : sendError(reply, status, code);
  };
  const execute = async (
    request: FastifyRequest,
    reply: FastifyReply,
    action: WorkspaceAction,
    operation: (access: WorkspaceAccess) => Promise<unknown>,
  ) => {
    const access = await resolveAccess(deps.db, request, reply);
    if (!access) return;
    if (!can(access.role, action)) return sendError(reply, 403, "forbidden");
    try {
      return await operation(access);
    } catch (error) {
      if (error instanceof DataInUseError)
        return reply.code(409).send(
          contracts.dataInUseResponseSchema.parse({
            error: "data_in_use",
            usedBy: error.usedBy,
          }),
        );
      if (error instanceof DataServiceError)
        return sendDataError(reply, error.status, error.code, {
          nodeId: error.nodeId,
        });
      if (error instanceof DataProcessingError)
        return sendDataError(reply, 400, error.code, {
          fieldId: error.fieldId,
          nodeId: error.nodeId,
          count: error.count,
        });
      return sendError(reply, 503, "data_operation_failed");
    }
  };
  const id = (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z.object({ id: z.uuid() }).safeParse(request.params);
    if (!parsed.success) {
      sendError(reply, 404, "data_not_found");
      return null;
    }
    return parsed.data.id;
  };
  const doc = (
    summary: string,
    response: z.ZodType,
    body?: z.ZodType,
    querystring?: z.ZodType,
  ) =>
    routeSchema({
      summary,
      tags: ["data"],
      response,
      ...(body ? { body } : {}),
      ...(querystring ? { querystring } : {}),
      errors: [400, 403, 404, 409, 413, 503],
      errorSchemas: {
        400: contracts.dataErrorResponseSchema,
        404: contracts.dataErrorResponseSchema,
        409: contracts.dataErrorResponseSchema,
      },
    });
  const projectFilter = (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = contracts.projectFilterQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendError(reply, 400, "invalid_request");
      return null;
    }
    return parsed.data;
  };
  void app.register(
    (scope, _options, done) => {
      scope.addHook("onRequest", createRequireSession(deps.authService));
      scope.get(
        "/workspaces/:workspaceId/data/sources",
        {
          schema: doc(
            "List typed source and prepared datasets",
            contracts.dataSourcesResponseSchema,
            undefined,
            contracts.projectFilterQuerySchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:preview", async (a) => {
            const filter = projectFilter(request, reply);
            if (!filter) return;
            return service.listSources(a, filter);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/preview",
        {
          schema: doc(
            "Preview a dataset with its typed fields",
            contracts.dataPreviewResponseSchema,
            contracts.dataPreviewRequestSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:preview", async (a) => {
            const body = parseBody(
              contracts.dataPreviewRequestSchema,
              request,
              reply,
            );
            if (!body) return;
            return service.preview(
              a,
              body.sourceId,
              body.limit,
              body.preparationDraft,
            );
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/manual",
        {
          schema: doc(
            "Publish an entered reference table",
            contracts.manualDatasetResponseSchema,
            contracts.manualDatasetInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const body = parseBody(
              contracts.manualDatasetInputSchema,
              request,
              reply,
            );
            if (!body) return;
            return service.saveManual(a, body);
          }),
      );
      scope.put(
        "/workspaces/:workspaceId/data/manual/:id",
        {
          schema: doc(
            "Replace an entered reference table with optimistic concurrency",
            contracts.manualDatasetResponseSchema,
            contracts.manualDatasetInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const source = id(request, reply),
              body = parseBody(
                contracts.manualDatasetInputSchema,
                request,
                reply,
              );
            if (!source || !body) return;
            return service.saveManual(a, body, source);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/manual/:id/read",
        {
          schema: doc(
            "Read a pinned page of an editable reference table",
            contracts.manualDatasetReadResponseSchema,
            contracts.manualDatasetReadInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (actor) => {
            const source = id(request, reply),
              input = parseBody(
                contracts.manualDatasetReadInputSchema,
                request,
                reply,
              );
            if (!source || !input) return;
            reply.header("cache-control", "no-store");
            return service.readManual(actor, source, input);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/manual/pages",
        {
          schema: doc(
            "Stage a reference-table edit and publish only its complete final page",
            contracts.manualDatasetPageResponseSchema,
            contracts.manualDatasetPageInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (actor) => {
            const input = parseBody(
              contracts.manualDatasetPageInputSchema,
              request,
              reply,
            );
            if (!input) return;
            reply.header("cache-control", "no-store");
            return service.saveManualPage(actor, input);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/formula",
        {
          schema: doc(
            "Parse a bounded formula into stable references",
            contracts.parseFormulaResponseSchema,
            contracts.parseFormulaRequestSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async () => {
            const body = parseBody(
              contracts.parseFormulaRequestSchema,
              request,
              reply,
            );
            if (!body) return;
            return {
              expression: parseDataFormula(body.formula, body.references),
            };
          }),
      );
      scope.get(
        "/workspaces/:workspaceId/data/preparations",
        {
          schema: doc(
            "List preparation drafts and publication versions",
            contracts.preparationListResponseSchema,
            undefined,
            contracts.projectFilterQuerySchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const filter = projectFilter(request, reply);
            if (!filter) return;
            return service.listPreparations(a, filter);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/preparations",
        {
          schema: doc(
            "Create a reusable preparation draft",
            contracts.preparationResponseSchema,
            contracts.preparationInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const body = parseBody(
              contracts.preparationInputSchema,
              request,
              reply,
            );
            if (!body) return;
            return service.savePreparation(a, body);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/preparations/preview",
        {
          schema: doc(
            "Preview preparation steps without changing published data",
            contracts.preparationPreviewResponseSchema,
            contracts.preparationPreviewRequestSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:preview", async (a) => {
            const body = parseBody(
              contracts.preparationPreviewRequestSchema,
              request,
              reply,
            );
            if (!body) return;
            return service.previewPreparation(a, body.graph, body.draft);
          }),
      );
      scope.get(
        "/workspaces/:workspaceId/data/preparations/:id",
        {
          schema: doc(
            "Get a preparation draft",
            contracts.preparationResponseSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const preparation = id(request, reply);
            if (!preparation) return;
            return service.getPreparation(a, preparation);
          }),
      );
      scope.put(
        "/workspaces/:workspaceId/data/preparations/:id",
        {
          schema: doc(
            "Save a preparation draft with optimistic concurrency",
            contracts.preparationResponseSchema,
            contracts.preparationInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const preparation = id(request, reply),
              body = parseBody(
                contracts.preparationInputSchema,
                request,
                reply,
              );
            if (!preparation || !body) return;
            return service.savePreparation(a, body, preparation);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/preparations/:id/publish",
        {
          schema: doc(
            "Validate and publish an immutable preparation version",
            contracts.preparationResponseSchema,
            contracts.dataPublishRequestSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:publish", async (a) => {
            const preparation = id(request, reply),
              body = parseBody(
                contracts.dataPublishRequestSchema,
                request,
                reply,
              );
            if (!preparation || !body) return;
            return service.publishPreparation(a, preparation, body.version);
          }),
      );
      scope.get(
        "/workspaces/:workspaceId/data/models",
        {
          schema: doc(
            "List model drafts and publication versions",
            contracts.modelListResponseSchema,
            undefined,
            contracts.projectFilterQuerySchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const filter = projectFilter(request, reply);
            if (!filter) return;
            return service.listModels(a, filter);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/models/preview",
        {
          schema: doc(
            "Preview an unsaved model without persisting a draft",
            contracts.modelQueryResponseSchema,
            contracts.modelDefinitionPreviewRequestSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:preview", async (a) => {
            const body = parseBody(
              contracts.modelDefinitionPreviewRequestSchema,
              request,
              reply,
            );
            if (!body) return;
            return service.previewModel(
              a,
              body.definition,
              body.query,
              body.draft,
            );
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/models",
        {
          schema: doc(
            "Create a semantic model draft",
            contracts.modelResponseSchema,
            contracts.modelInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const body = parseBody(contracts.modelInputSchema, request, reply);
            if (!body) return;
            return service.saveModel(a, body);
          }),
      );
      scope.get(
        "/workspaces/:workspaceId/data/models/:id",
        { schema: doc("Get a model draft", contracts.modelResponseSchema) },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const model = id(request, reply);
            if (!model) return;
            return service.getModel(a, model);
          }),
      );
      scope.put(
        "/workspaces/:workspaceId/data/models/:id",
        {
          schema: doc(
            "Save a model draft with optimistic concurrency",
            contracts.modelResponseSchema,
            contracts.modelInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", async (a) => {
            const model = id(request, reply),
              body = parseBody(contracts.modelInputSchema, request, reply);
            if (!model || !body) return;
            return service.saveModel(a, body, model);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/models/:id/publish",
        {
          schema: doc(
            "Validate and atomically publish a model release",
            contracts.modelResponseSchema,
            contracts.dataPublishRequestSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:publish", async (a) => {
            const model = id(request, reply),
              body = parseBody(
                contracts.dataPublishRequestSchema,
                request,
                reply,
              );
            if (!model || !body) return;
            return service.publishModel(a, model, body.version);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/compare-measures/preview",
        {
          schema: routeSchema({
            summary:
              "Show what saving a compare widget as a measure would create, without creating it",
            tags: ["data"],
            body: contracts.compareMeasureRequestSchema,
            response: contracts.compareMeasurePreviewResponseSchema,
            errors: [400, 403, 404, 503],
            errorSchemas: {
              400: contracts.compareMeasureErrorResponseSchema,
              404: contracts.compareMeasureErrorResponseSchema,
            },
          }),
        },
        (request, reply) =>
          execute(request, reply, "data:publish", async (a) => {
            const body = parseBody(
              contracts.compareMeasureRequestSchema,
              request,
              reply,
            );
            if (!body) return;
            reply.header("cache-control", "no-store");
            return compareMeasures.preview(a, body);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/compare-measures",
        {
          schema: routeSchema({
            summary:
              "Save a compare widget as a generated preparation and a draft measure model",
            tags: ["data"],
            body: contracts.compareMeasureRequestSchema,
            response: contracts.compareMeasureResponseSchema,
            errors: [400, 403, 404, 409, 413, 503],
            errorSchemas: {
              400: contracts.compareMeasureErrorResponseSchema,
              404: contracts.compareMeasureErrorResponseSchema,
            },
          }),
        },
        (request, reply) =>
          execute(request, reply, "data:publish", async (a) => {
            const body = parseBody(
              contracts.compareMeasureRequestSchema,
              request,
              reply,
            );
            if (!body) return;
            reply.header("cache-control", "no-store");
            return compareMeasures.create(a, body);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/models/:id/query",
        {
          schema: doc(
            "Query published measures under one shared filter context",
            contracts.modelQueryResponseSchema,
            contracts.modelQueryInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:query", async (a) => {
            const model = id(request, reply),
              body = parseBody(contracts.modelQueryInputSchema, request, reply);
            if (!model || !body) return;
            return service.query(a, model, body);
          }),
      );
      scope.post(
        "/workspaces/:workspaceId/data/models/:id/preview",
        {
          schema: doc(
            "Preview draft measures without changing the published release",
            contracts.modelQueryResponseSchema,
            contracts.modelQueryInputSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:preview", async (a) => {
            const model = id(request, reply),
              body = parseBody(contracts.modelQueryInputSchema, request, reply);
            if (!model || !body) return;
            return service.query(a, model, body, true);
          }),
      );
      for (const kind of ["preparations", "models"] as const) {
        scope.get(
          `/workspaces/:workspaceId/data/${kind}/:id/impact`,
          {
            schema: doc(
              "List what depends on a preparation, model or measure before publishing",
              contracts.dataImpactResponseSchema,
              undefined,
              kind === "models" ? contracts.dataImpactQuerySchema : undefined,
            ),
          },
          (request, reply) =>
            execute(request, reply, "data:edit", async (actor) => {
              const resourceId = id(request, reply);
              if (!resourceId) return;
              const query = contracts.dataImpactQuerySchema.safeParse(
                kind === "models" ? request.query : {},
              );
              if (!query.success)
                return sendError(reply, 400, "invalid_request");
              reply.header("cache-control", "no-store");
              return service.impact(
                actor,
                kind === "preparations"
                  ? { kind: "preparation", id: resourceId }
                  : query.data.measureId
                    ? {
                        kind: "measure",
                        id: resourceId,
                        measureIds: query.data.measureId,
                      }
                    : { kind: "model", id: resourceId },
              );
            }),
        );
        scope.get(
          `/workspaces/:workspaceId/data/${kind}/:id/inputs`,
          {
            schema: routeSchema({
              summary:
                "Read draft-bound input dataset metadata using restored definition versions",
              tags: ["data"],
              querystring: contracts.dataDraftInputsQuerySchema,
              response: contracts.dataSourcesResponseSchema,
              errors: [400, 403, 404, 409, 413, 503],
            }),
          },
          (request, reply) =>
            execute(request, reply, "data:edit", async (actor) => {
              const resourceId = id(request, reply);
              if (!resourceId) return;
              const input = contracts.dataDraftInputsQuerySchema.parse(
                request.query,
              );
              reply.header("cache-control", "no-store");
              return kind === "preparations"
                ? service.preparationInputs(actor, resourceId, input.version)
                : service.modelInputs(actor, resourceId, input.version);
            }),
        );

        scope.get(
          `/workspaces/:workspaceId/data/${kind}/:id/history`,
          {
            schema: routeSchema({
              summary: "List immutable published definition history",
              tags: ["data"],
              querystring: contracts.dataHistoryQuerySchema,
              response: contracts.dataHistoryResponseSchema,
              errors: [400, 403, 404, 409, 503],
            }),
          },
          (request, reply) =>
            execute(request, reply, "data:edit", async (actor) => {
              const resourceId = id(request, reply);
              if (!resourceId) return;
              const input = contracts.dataHistoryQuerySchema.parse(
                request.query,
              );
              reply.header("cache-control", "no-store");
              return kind === "preparations"
                ? service.preparationHistory(actor, resourceId, input)
                : service.modelHistory(actor, resourceId, input);
            }),
        );
        scope.put(
          `/workspaces/:workspaceId/data/${kind}/:id/project`,
          {
            schema: doc(
              "Move to a project without creating a draft or changing publication",
              kind === "preparations"
                ? contracts.preparationResponseSchema
                : contracts.modelResponseSchema,
              contracts.dataProjectRequestSchema,
            ),
          },
          (request, reply) =>
            execute(request, reply, "data:edit", async (actor) => {
              const resourceId = id(request, reply);
              const input = parseBody(
                contracts.dataProjectRequestSchema,
                request,
                reply,
              );
              if (!resourceId || !input) return;
              return service.setProject(
                actor,
                kind === "preparations" ? "preparation" : "model",
                resourceId,
                input.projectId,
              );
            }),
        );
        scope.delete(
          `/workspaces/:workspaceId/data/${kind}/:id`,
          {
            schema: routeSchema({
              summary:
                "Delete with every version and draft (409 data_in_use names what still uses it)",
              tags: ["data"],
              errors: [403, 404, 409, 503],
              errorSchemas: {
                404: contracts.dataErrorResponseSchema,
                409: contracts.dataErrorResponseSchema.extend({
                  usedBy: contracts.dataUsersSchema.optional(),
                }),
              },
            }),
          },
          (request, reply) =>
            execute(request, reply, "data:delete", async (actor) => {
              const resourceId = id(request, reply);
              if (!resourceId) return;
              await service.remove(
                actor,
                kind === "preparations" ? "preparation" : "model",
                resourceId,
              );
              return reply.code(204).send();
            }),
        );
        scope.post(
          `/workspaces/:workspaceId/data/${kind}/:id/restore`,
          {
            schema: doc(
              "Restore a published definition to a new draft without changing publication",
              kind === "preparations"
                ? contracts.preparationResponseSchema
                : contracts.modelResponseSchema,
              contracts.dataRestoreRequestSchema,
            ),
          },
          (request, reply) =>
            execute(request, reply, "data:edit", async (actor) => {
              const resourceId = id(request, reply);
              const input = parseBody(
                contracts.dataRestoreRequestSchema,
                request,
                reply,
              );
              if (!resourceId || !input) return;
              reply.header("cache-control", "no-store");
              return kind === "preparations"
                ? service.restorePreparation(actor, resourceId, input)
                : service.restoreModel(actor, resourceId, input);
            }),
        );
      }
      done();
    },
    { prefix: "/v1" },
  );
}
