import { z } from "zod";

import { customApiDefinitionSchema } from "@netrics/connector-sdk/custom-api";

import { projectFilterQuerySchema } from "./project-filter.js";

// Custom API definitions (milestone 13). The document schema lives in the
// connector SDK's internal subpath, the one package both contracts and
// connectors may import; the API contract re-exports it.
export {
  CUSTOM_API_ISSUE_CODES,
  CUSTOM_API_LIMITS,
  CUSTOM_API_SCHEMA_VERSION,
  CustomApiDefinitionError,
  customApiAuthSchema,
  customApiDefinitionSchema,
  customApiEnvironmentSchema,
  customApiFieldSchema,
  customApiIssues,
  customApiPaginationSchema,
  customApiStreamSchema,
  customApiVariableSchema,
  customApiWindowSchema,
  upgradeCustomApiDefinition,
} from "@netrics/connector-sdk/custom-api";
export type {
  CustomApiAuth,
  CustomApiDefinition,
  CustomApiDefinitionErrorCode,
  CustomApiEnvironment,
  CustomApiField,
  CustomApiImages,
  CustomApiIssue,
  CustomApiIssueCode,
  CustomApiPagination,
  CustomApiStream,
  CustomApiVariable,
  CustomApiWindow,
} from "@netrics/connector-sdk/custom-api";

// Definitions API (#803): workspace-scoped, versioned definitions. Requests
// carry the document as unknown JSON; the server validates it with
// upgradeCustomApiDefinition and answers the issues it finds.

export const customApiDefinitionSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  projectId: z.uuid().nullable(),
  currentVersion: z.number().int().positive(),
  archivedAt: z.iso.datetime().nullable(),
  connectionCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CustomApiDefinitionSummary = z.infer<
  typeof customApiDefinitionSummarySchema
>;

export const customApiDefinitionListResponseSchema = z.object({
  definitions: z.array(customApiDefinitionSummarySchema),
});
export type CustomApiDefinitionListResponse = z.infer<
  typeof customApiDefinitionListResponseSchema
>;

export const customApiDefinitionResponseSchema = z.object({
  definition: customApiDefinitionSummarySchema.extend({
    // One OpenAPI component instead of a copy per route.
    document: customApiDefinitionSchema.meta({ id: "CustomApiDefinition" }),
    datasetVersions: z.record(z.string(), z.number().int().positive()),
  }),
});
export type CustomApiDefinitionResponse = z.infer<
  typeof customApiDefinitionResponseSchema
>;

export const createCustomApiDefinitionRequestSchema = z.object({
  projectId: z.uuid().optional(),
  document: z
    .unknown()
    .describe(
      "A custom API definition document (customApiDefinitionSchema); older schema versions are upgraded",
    ),
});
export type CreateCustomApiDefinitionRequest = z.infer<
  typeof createCustomApiDefinitionRequestSchema
>;

export const createCustomApiDefinitionVersionRequestSchema = z.object({
  baseVersion: z.number().int().positive(),
  document: z
    .unknown()
    .describe(
      "A custom API definition document (customApiDefinitionSchema); older schema versions are upgraded",
    ),
});
export type CreateCustomApiDefinitionVersionRequest = z.infer<
  typeof createCustomApiDefinitionVersionRequestSchema
>;

export const updateCustomApiDefinitionRequestSchema = z.object({
  projectId: z.uuid().nullable(),
});
export type UpdateCustomApiDefinitionRequest = z.infer<
  typeof updateCustomApiDefinitionRequestSchema
>;

export const customApiDefinitionListQuerySchema =
  projectFilterQuerySchema.extend({
    includeArchived: z.enum(["true", "false"]).optional(),
  });
export type CustomApiDefinitionListQuery = z.infer<
  typeof customApiDefinitionListQuerySchema
>;

export const customApiErrorResponseSchema = z.object({
  error: z.string(),
  issues: z
    .array(
      z.object({ path: z.string(), code: z.string(), message: z.string() }),
    )
    .max(20)
    .optional(),
});
export type CustomApiErrorResponse = z.infer<
  typeof customApiErrorResponseSchema
>;
