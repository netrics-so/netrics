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
import { createDataService, DataServiceError } from "../data/service.js";
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
      if (error instanceof DataServiceError)
        return sendError(reply, error.status, error.code);
      if (error instanceof DataProcessingError)
        return sendError(reply, 400, error.code);
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
  const doc = (summary: string, response: z.ZodType, body?: z.ZodType) =>
    routeSchema({
      summary,
      tags: ["data"],
      response,
      ...(body ? { body } : {}),
      errors: [400, 403, 404, 409, 413, 503],
    });
  void app.register(
    (scope, _options, done) => {
      scope.addHook("onRequest", createRequireSession(deps.authService));
      scope.get(
        "/workspaces/:workspaceId/data/sources",
        {
          schema: doc(
            "List typed source and prepared datasets",
            contracts.dataSourcesResponseSchema,
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:preview", (a) =>
            service.listSources(a),
          ),
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
            return service.preview(a, body.sourceId, body.limit);
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
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", (a) =>
            service.listPreparations(a),
          ),
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
            return service.previewPreparation(a, body.graph);
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
          ),
        },
        (request, reply) =>
          execute(request, reply, "data:edit", (a) => service.listModels(a)),
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
            return service.previewModel(a, body.definition, body.query);
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
      done();
    },
    { prefix: "/v1" },
  );
}
