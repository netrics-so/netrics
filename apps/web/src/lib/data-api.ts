import { z } from "zod";
import {
  dataSourcesResponseSchema,
  dataPreviewResponseSchema,
  preparationListResponseSchema,
  preparationResponseSchema,
  preparationPreviewResponseSchema,
  modelListResponseSchema,
  modelResponseSchema,
  modelQueryResponseSchema,
  manualDatasetResponseSchema,
  dataSourceViewSchema,
  preparationViewSchema,
  modelViewSchema,
} from "@netrics/contracts";
import type {
  PreparationGraph,
  SemanticModelDefinition,
  ModelQuery,
} from "@netrics/domain";
import { browserSend, ApiError } from "./api";
import { apiFetch } from "./api-fetch";

export type DataSource = z.infer<typeof dataSourceViewSchema>;
export type PreparationDraft = z.infer<typeof preparationViewSchema>;
export type ModelDraft = z.infer<typeof modelViewSchema>;
export type DataPreview = z.infer<typeof dataPreviewResponseSchema>;
export type ModelResult = z.infer<typeof modelQueryResponseSchema>;
export type DataWorkspace = {
  sources: DataSource[];
  preparations: PreparationDraft[];
  models: ModelDraft[];
};
const base = (workspaceId: string) => `/v1/workspaces/${workspaceId}/data`;
async function read<T>(
  schema: z.ZodType<T>,
  path: string,
  cookie?: string,
): Promise<T> {
  if (cookie === undefined) return browserSend(schema, "GET", path);
  const response = await apiFetch(path, { headers: { cookie } });
  if (!response.ok)
    throw new ApiError(response.status, "data_operation_failed");
  return schema.parse(await response.json());
}
export async function getDataWorkspace(
  workspaceId: string,
  cookie?: string,
): Promise<DataWorkspace> {
  const [sources, preparations, models] = await Promise.all([
    read(dataSourcesResponseSchema, base(workspaceId) + "/sources", cookie),
    read(
      preparationListResponseSchema,
      base(workspaceId) + "/preparations",
      cookie,
    ),
    read(modelListResponseSchema, base(workspaceId) + "/models", cookie),
  ]);
  return { ...sources, ...preparations, ...models };
}
export const previewData = (workspaceId: string, sourceId: string) =>
  browserSend(
    dataPreviewResponseSchema,
    "POST",
    base(workspaceId) + "/preview",
    { sourceId },
  );
export const previewPreparation = (
  workspaceId: string,
  graph: PreparationGraph,
) =>
  browserSend(
    preparationPreviewResponseSchema,
    "POST",
    base(workspaceId) + "/preparations/preview",
    { graph },
  );
export const savePreparation = (
  workspaceId: string,
  draft: { name: string; graph: PreparationGraph; version?: number },
  id?: string,
) =>
  browserSend(
    preparationResponseSchema,
    id ? "PUT" : "POST",
    base(workspaceId) + "/preparations" + (id ? "/" + id : ""),
    draft,
  );
export const publishPreparation = (
  workspaceId: string,
  id: string,
  version: number,
) =>
  browserSend(
    preparationResponseSchema,
    "POST",
    base(workspaceId) + `/preparations/${id}/publish`,
    { version },
  );
export const saveModel = (
  workspaceId: string,
  draft: {
    name: string;
    definition: SemanticModelDefinition;
    version?: number;
  },
  id?: string,
) =>
  browserSend(
    modelResponseSchema,
    id ? "PUT" : "POST",
    base(workspaceId) + "/models" + (id ? "/" + id : ""),
    draft,
  );
export const publishModel = (
  workspaceId: string,
  id: string,
  version: number,
) =>
  browserSend(
    modelResponseSchema,
    "POST",
    base(workspaceId) + `/models/${id}/publish`,
    { version },
  );
export const queryModel = (
  workspaceId: string,
  id: string,
  query: Omit<ModelQuery, "now">,
  preview = true,
) =>
  browserSend(
    modelQueryResponseSchema,
    "POST",
    base(workspaceId) + `/models/${id}/${preview ? "preview" : "query"}`,
    query,
  );
export const previewModelDefinition = (
  workspaceId: string,
  definition: SemanticModelDefinition,
  query: Omit<ModelQuery, "now">,
) =>
  browserSend(
    modelQueryResponseSchema,
    "POST",
    base(workspaceId) + "/models/preview",
    { definition, query },
  );
export const saveReference = (
  workspaceId: string,
  input: unknown,
  id?: string,
) =>
  browserSend(
    manualDatasetResponseSchema,
    id ? "PUT" : "POST",
    base(workspaceId) + "/manual" + (id ? "/" + id : ""),
    input,
  );
