import { z } from "zod";
import {
  DATA_TYPES,
  DASHBOARD_MEASURE_VIEWS,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type MeasureWidgetBinding,
} from "@netrics/domain";
import {
  dataExpressionSchema,
  modelQueryResponseSchema,
} from "./data-processing.js";
const id = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,99}$/);
const scalar = z.union([
  z.string().max(65536),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const dashboardFilterValueSchema: z.ZodType<
  DashboardFilterValue,
  DashboardFilterValue
> = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("values"),
      values: z.array(scalar).max(100),
    }),
    z.strictObject({ kind: z.literal("range"), from: scalar, to: scalar }),
  ])
  .nullable();
export const dashboardDataFilterSchema: z.ZodType<
  DashboardDataFilter,
  DashboardDataFilter
> = z.strictObject({
  id,
  name: z.string().trim().min(1).max(100),
  type: z.enum(DATA_TYPES).exclude(["json"]),
  mode: z.enum(["values", "range"]),
  mappings: z
    .array(z.strictObject({ modelId: z.uuid(), dimensionId: id }))
    .max(100),
  defaultValue: dashboardFilterValueSchema,
  fixedValue: dashboardFilterValueSchema.optional(),
});
export const dashboardDataFiltersSchema = z
  .array(dashboardDataFilterSchema)
  .max(30);
export const dashboardFilterExclusionSchema = z.strictObject({
  filterId: id,
  reason: z.string().trim().min(1).max(200),
});
export const measureWidgetBindingSchema: z.ZodType<MeasureWidgetBinding> =
  z.strictObject({
    modelId: z.uuid(),
    measureIds: z.array(id).min(1).max(10),
    groupBy: z.array(id).max(3),
    filter: dataExpressionSchema.optional(),
    exclusions: z.array(dashboardFilterExclusionSchema).max(30).default([]),
  });
export const measureWidgetOptionsSchema = z.object({
  view: z.enum(DASHBOARD_MEASURE_VIEWS).default("value"),
  limit: z.number().int().min(1).max(1000).default(20),
});
export const dashboardFilterValuesSchema = z.record(
  id,
  dashboardFilterValueSchema,
);
export const dashboardDataQuerySchema = z.strictObject({
  values: dashboardFilterValuesSchema.default({}),
});
export const dashboardMeasureMetadataSchema = z.object({
  modelId: z.uuid(),
  modelName: z.string(),
  measures: z.array(
    z.object({
      id,
      name: z.string(),
      requiredDimensions: z.array(id).optional(),
      /** The value is a change ratio, (current − previous) / |previous|;
       * clients show it as a percentage. */
      percentChange: z.literal(true).optional(),
    }),
  ),
  dimensions: z.array(
    z.object({ id, name: z.string(), type: z.enum(DATA_TYPES) }),
  ),
});
export const dashboardWidgetDataSchema = z.object({
  sourceHealth: z
    .array(
      z.object({
        connectionId: z.uuid(),
        name: z.string(),
        status: z.enum([
          "ok",
          "pending",
          "auth_failed",
          "needs_reauthorization",
          "outage",
          "paused",
        ]),
        lastSuccessAt: z.iso.datetime().nullable(),
      }),
    )
    .optional(),
  scope: z.array(z.string()).optional(),
  status: z.enum(["ok", "no_data", "stale", "outage"]).optional(),
  widgetId: z.uuid(),
  metadata: dashboardMeasureMetadataSchema.nullable(),
  result: modelQueryResponseSchema.nullable(),
  error: z.string().nullable(),
  exclusions: z.array(dashboardFilterExclusionSchema),
});
export const dashboardDataResponseSchema = z.object({
  widgets: z.array(dashboardWidgetDataSchema),
  values: dashboardFilterValuesSchema,
});
export const publishedModelCatalogSchema = z.object({
  models: z.array(dashboardMeasureMetadataSchema),
});
export const dashboardMeasurePreviewSchema = z.strictObject({
  filters: dashboardDataFiltersSchema,
  values: dashboardFilterValuesSchema.default({}),
  widgets: z
    .array(
      z.strictObject({
        id: z.uuid(),
        binding: measureWidgetBindingSchema,
        options: measureWidgetOptionsSchema,
      }),
    )
    .max(48),
});
export type DashboardWidgetData = z.infer<typeof dashboardWidgetDataSchema>;
export type DashboardDataResponse = z.infer<typeof dashboardDataResponseSchema>;
export type PublishedModelCatalog = z.infer<typeof publishedModelCatalogSchema>;
export const dashboardDimensionValuesInputSchema = z.strictObject({
  search: z.string().max(200).default(""),
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),
  limit: z.number().int().min(1).max(1000).default(100),
});
export const dashboardDimensionValuesResponseSchema = z.object({
  values: z.array(scalar).max(1000),
  labels: z.array(z.string()).max(1000).optional(),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});
