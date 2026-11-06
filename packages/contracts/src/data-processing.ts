import {
  sourceDatasetSchema,
  datasetRecordSchema,
} from "@netrics/connector-sdk";
import { z } from "zod";
import {
  DATA_TYPES,
  DATA_FUNCTIONS,
  type DataExpression,
  type PreparationNode,
  type PreparationGraph,
  type SemanticModelDefinition,
} from "@netrics/domain";
const id = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]{0,99}$/)
  .refine((v) => !["constructor", "prototype", "__proto__"].includes(v));
export const dataSourceIdSchema = z.string().min(1).max(240);
export const dataFieldViewSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  type: z.enum(DATA_TYPES),
  nullable: z.boolean(),
  unit: z.string().min(1).max(100).optional(),
  currencyField: id.optional(),
  scale: z.number().int().min(0).max(18).optional(),
});
const literal = z.strictObject({
  kind: z.literal("literal"),
  type: z.enum(DATA_TYPES),
  value: z.unknown(),
  unit: z.string().min(1).max(100).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
const reference = z.strictObject({ kind: z.literal("field"), fieldId: id });
/** Finite schema expansion bounds nesting before any recursive parse can overflow. */
function expression(level: number): z.ZodType<DataExpression> {
  const result = level
    ? z.discriminatedUnion("kind", [
        reference,
        literal,
        z.strictObject({
          kind: z.literal("call"),
          fn: z.enum(DATA_FUNCTIONS),
          args: z
            .array(expression(level - 1))
            .min(1)
            .max(20),
        }),
      ])
    : z.discriminatedUnion("kind", [reference, literal]);
  return result.meta({ id: "DataExpressionDepth" + level });
}
export const dataExpressionSchema = expression(16);
const aggregate = z.strictObject({
  id,
  name: z.string().min(1).max(100),
  op: z.enum([
    "sum",
    "count",
    "distinct_count",
    "avg",
    "min",
    "max",
    "last",
    "any",
    "all",
  ]),
  fieldId: id.optional(),
  orderBy: id.optional(),
  filter: dataExpressionSchema.optional(),
});
const input = { id, input: id };
export const preparationNodeSchema: z.ZodType<PreparationNode> =
  z.discriminatedUnion("type", [
    z.strictObject({
      id,
      type: z.literal("source"),
      datasetId: dataSourceIdSchema,
    }),
    z.strictObject({
      ...input,
      type: z.literal("select"),
      fields: z.array(id).min(1).max(100),
    }),
    z.strictObject({
      ...input,
      type: z.literal("rename"),
      names: z.record(id, z.string().min(1).max(100)),
    }),
    z.strictObject({
      ...input,
      type: z.literal("filter"),
      expression: dataExpressionSchema,
    }),
    z.strictObject({
      ...input,
      type: z.literal("calculate"),
      fieldId: id,
      name: z.string().min(1).max(100),
      expression: dataExpressionSchema,
    }),
    z.strictObject({
      ...input,
      type: z.literal("cast"),
      fieldId: id,
      to: z.enum(DATA_TYPES),
      onError: z.enum(["reject", "null"]),
    }),
    z.strictObject({
      ...input,
      type: z.literal("replace"),
      fieldId: id,
      from: z.unknown(),
      to: z.unknown(),
    }),
    z.strictObject({
      ...input,
      type: z.literal("deduplicate"),
      keys: z.array(id).min(1).max(10),
      keep: z.enum(["first", "last"]),
    }),
    z.strictObject({
      id,
      type: z.literal("append"),
      inputs: z.array(id).min(2).max(20),
      columnMappings: z.record(id, z.record(id, id)).optional(),
    }),
    z.strictObject({
      id,
      type: z.literal("join"),
      left: id,
      right: id,
      keys: z
        .array(z.strictObject({ left: id, right: id }))
        .min(1)
        .max(10),
      mode: z.enum(["inner", "left"]),
      cardinality: z.enum(["many_to_one", "one_to_one"]),
      rightPrefix: z.string().regex(/^[a-z][a-z0-9_.-]{0,49}$/),
      rightNamePrefix: z.string().max(100).optional(),
    }),
    z.strictObject({
      ...input,
      type: z.literal("group"),
      keys: z.array(id).max(10),
      aggregates: z.array(aggregate).min(1).max(50),
    }),
  ]);
export const preparationGraphSchema: z.ZodType<PreparationGraph> =
  z.strictObject({
    version: z.literal(1),
    nodes: z.array(preparationNodeSchema).min(1).max(100),
    outputs: z.array(id).min(1).max(20),
  });
const binding = z.strictObject({ datasetId: dataSourceIdSchema, fieldId: id });
export const semanticModelDefinitionSchema: z.ZodType<SemanticModelDefinition> =
  z.strictObject({
    version: z.literal(1),
    datasets: z.array(dataSourceIdSchema).min(1).max(100),
    relationships: z
      .array(
        z.strictObject({
          id,
          from: binding,
          to: binding,
          cardinality: z.enum(["many_to_one", "one_to_one"]),
        }),
      )
      .max(100),
    dimensions: z
      .array(
        z.strictObject({
          id,
          name: z.string().min(1).max(100),
          datasetId: dataSourceIdSchema,
          fieldId: id,
          labelFieldId: id.optional(),
          timeAlignment: z.enum(["reporting_date", "instant"]).optional(),
        }),
      )
      .max(100),
    measures: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            id,
            name: z.string().min(1).max(100),
            kind: z.literal("aggregate"),
            requiredDimensions: z.array(id).max(10).optional(),
            datasetId: dataSourceIdSchema,
            aggregate,
          }),
          z.strictObject({
            id,
            name: z.string().min(1).max(100),
            kind: z.literal("formula"),
            requiredDimensions: z.array(id).max(10).optional(),
            expression: dataExpressionSchema,
          }),
        ]),
      )
      .min(1)
      .max(100),
  });
export const dataSourceViewSchema = z.object({
  id: dataSourceIdSchema,
  name: z.string(),
  kind: z.enum(["source", "observations", "prepared", "manual", "resources"]),
  fields: z.array(dataFieldViewSchema),
  generationId: z.string().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  schemaVersion: z.number().int().positive(),
  aggregated: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  connectionId: z.uuid().nullable(),
});
export const dataSourcesResponseSchema = z.object({
  sources: z.array(dataSourceViewSchema),
});
export const dataPreviewResponseSchema = z.object({
  fields: z.array(dataFieldViewSchema),
  rows: z.array(z.record(z.string(), z.unknown())).max(100),
  truncated: z.boolean(),
  warnings: z.array(z.string()),
});
export const dataPreviewRequestSchema = z.strictObject({
  sourceId: dataSourceIdSchema,
  limit: z.number().int().min(1).max(100).optional(),
});
export const preparationInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  graph: preparationGraphSchema,
  version: z.number().int().positive().optional(),
});
export const modelInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  definition: semanticModelDefinitionSchema,
  version: z.number().int().positive().optional(),
});
export const dataPublishRequestSchema = z.strictObject({
  version: z.number().int().positive(),
});
export const preparationViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  graph: preparationGraphSchema,
  version: z.number().int().positive(),
  publishedVersion: z.number().int().positive().nullable(),
  updatedAt: z.iso.datetime(),
});
export const preparationResponseSchema = z.object({
  preparation: preparationViewSchema,
});
export const preparationListResponseSchema = z.object({
  preparations: z.array(preparationViewSchema),
});
export const modelViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  definition: semanticModelDefinitionSchema,
  version: z.number().int().positive(),
  publishedVersion: z.number().int().positive().nullable(),
  updatedAt: z.iso.datetime(),
});
export const modelResponseSchema = z.object({ model: modelViewSchema });
export const modelListResponseSchema = z.object({
  models: z.array(modelViewSchema),
});
export const modelQueryInputSchema = z.strictObject({
  measureIds: z.array(id).min(1).max(50),
  groupBy: z.array(id).max(10),
  filter: dataExpressionSchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
export const modelMeasureCellSchema = z.object({
  value: z.unknown(),
  type: z.enum(DATA_TYPES),
  unit: z.string().optional(),
  currency: z.string().optional(),
  status: z.enum(["ok", "missing", "partial"]),
});
export const modelQueryResponseSchema = z.object({
  filterValueLabels: z
    .array(
      z.object({
        dimensionId: z.string(),
        value: z.unknown(),
        label: z.string(),
      }),
    )
    .optional(),
  pendingSources: z.array(dataSourceIdSchema).optional(),
  receivedAt: z.iso.datetime().nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  totalRows: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  releaseId: z.uuid().nullable(),
  rows: z
    .array(
      z.object({
        dimensions: z.record(z.string(), z.unknown()),
        dimensionLabels: z.record(z.string(), z.string()).optional(),
        measures: z.record(z.string(), modelMeasureCellSchema),
      }),
    )
    .max(1000),
  warnings: z.array(z.string()),
  operations: z.number().int().nonnegative(),
  provenance: z.array(
    z.object({ datasetId: z.string(), generationId: z.string() }),
  ),
  appliedFilter: dataExpressionSchema.nullable(),
  groupBy: z.array(id),
  stale: z.boolean(),
  error: z.string().optional(),
});
export const modelDefinitionPreviewRequestSchema = z.strictObject({
  definition: semanticModelDefinitionSchema,
  query: modelQueryInputSchema,
});
export const parseFormulaRequestSchema = z.strictObject({
  formula: z.string().min(1).max(10000),
  references: z
    .array(z.strictObject({ id, name: z.string().min(1).max(100) }))
    .max(200),
});
export const parseFormulaResponseSchema = z.object({
  expression: dataExpressionSchema,
});

export const manualDatasetInputSchema = z.strictObject({
  definition: sourceDatasetSchema.refine((d) => d.mode === "snapshot", {
    message: "Manual tables publish complete snapshots",
  }),
  records: z.array(datasetRecordSchema).max(10000),
  generationId: z.uuid().nullable().optional(),
});
export const manualDatasetResponseSchema = z.object({
  datasetId: z.uuid(),
  generationId: z.uuid(),
});

export const preparationPreviewResponseSchema = z.object({
  outputs: z.record(
    z.string(),
    z.object({
      fields: z.array(dataFieldViewSchema),
      rows: z.array(z.record(z.string(), z.unknown())).max(100),
      truncated: z.boolean(),
    }),
  ),
  warnings: z.array(z.string()),
  rejectedRows: z.number().int().nonnegative(),
});
export const preparationPreviewRequestSchema = z.strictObject({
  graph: preparationGraphSchema,
});

export const manualDatasetPageInputSchema = z.strictObject({
  datasetId: z.uuid().optional(),
  generationId: z.uuid().nullable(),
  definition: sourceDatasetSchema.refine(
    (definition) => definition.mode === "snapshot",
  ),
  refreshId: z.uuid(),
  page: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  complete: z.boolean(),
  records: z.array(datasetRecordSchema).max(1000),
});
export const manualDatasetPageResponseSchema = z.object({
  datasetId: z.uuid(),
  generationId: z.uuid().nullable(),
});
export const manualDatasetReadInputSchema = z.strictObject({
  generationId: z.uuid().optional(),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  limit: z.number().int().min(1).max(1000).default(1000),
});
export const manualDatasetReadResponseSchema = z.object({
  definition: sourceDatasetSchema,
  generationId: z.uuid().nullable(),
  records: z.array(datasetRecordSchema).max(1000),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
