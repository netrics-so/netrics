import { z } from "zod";
import {
  DATA_TYPES,
  DASHBOARD_MEASURE_VIEWS,
  PERIODS,
  type DashboardDataFilter,
  type DashboardFilterValue,
  type ItemsWidgetBinding,
  type MeasureWidgetBinding,
} from "@netrics/domain";
import { CUSTOM_API_IMAGE_NEWEST_MAX } from "./images.js";
import {
  dataExpressionSchema,
  modelMeasureCellSchema,
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
    /** Selecting a category, point or row value sets this shared filter.
     * Browser-only; device payloads never include it. */
    interaction: z.strictObject({ filterId: id }).optional(),
  });
export const measureWidgetOptionsSchema = z.object({
  view: z.enum(DASHBOARD_MEASURE_VIEWS).default("value"),
  limit: z.number().int().min(1).max(1000).default(20),
  /**
   * The groups by one of the widget's measures instead of by its
   * dimensions (#768): a table's top `limit`. Groups without a value come
   * last; amounts are ranked within their currency.
   */
  order: z
    .strictObject({ measureId: id, direction: z.enum(["asc", "desc"]) })
    .optional(),
  /**
   * Shorter column heads for a table, by dimension or measure id (#768):
   * "Downloads" where the widget's title already says "Downloads and user
   * installs". Without one, the model's name.
   */
  labels: z.record(id, z.string().trim().min(1).max(60)).optional(),
  /**
   * A period of the workspace's days the widget reads (#784): "last 30
   * days" on the model's reporting-date dimension, as connection widgets
   * read theirs, whatever the dashboard's date filter says (which the
   * widget should then exclude). Absent: the filters' range.
   */
  period: z.enum(PERIODS).optional(),
});
/**
 * A latest-items widget's binding (#810): a published model and its
 * dimensions for the image (a string field with role "image"), the title,
 * an optional subtitle and the time (date or timestamp, newest first).
 */
export const itemsWidgetBindingSchema: z.ZodType<ItemsWidgetBinding> =
  z.strictObject({
    modelId: z.uuid(),
    imageDimensionId: id,
    titleDimensionId: id,
    subtitleDimensionId: id.optional(),
    timeDimensionId: id,
    filter: dataExpressionSchema.optional(),
    exclusions: z.array(dashboardFilterExclusionSchema).max(30).default([]),
  });
export const itemsWidgetOptionsSchema = z.object({
  /** All at once in a grid, or one at a time. */
  layout: z.enum(["grid", "rotate"]).default("grid"),
  /** The newest items shown; a grid shows those that fit. */
  count: z.number().int().min(1).max(CUSTOM_API_IMAGE_NEWEST_MAX).default(6),
  /** Rotate: seconds per item. */
  rotateSeconds: z.number().int().min(3).max(60).default(8),
  imageFit: z.enum(["cover", "contain"]).default("cover"),
  showTime: z.boolean().default(true),
});
export type ItemsWidgetOptions = z.infer<typeof itemsWidgetOptionsSchema>;
/** A stored item image, served by netrics only (never the source URL). */
export const itemsWidgetImageSchema = z.object({
  id: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const itemsWidgetItemSchema = z.object({
  /** At most 200 characters; longer values are cut with "…". */
  title: z.string().max(200).nullable(),
  subtitle: z.string().max(200).nullable(),
  /** ISO date or timestamp as stored; clients word it in the viewer's time zone. */
  time: z.string().max(40).nullable(),
  /** Null: the image was not stored (yet), was skipped, or has no URL. */
  image: itemsWidgetImageSchema.nullable(),
});
export type ItemsWidgetItem = z.infer<typeof itemsWidgetItemSchema>;
export const dashboardFilterValuesSchema = z.record(
  id,
  dashboardFilterValueSchema,
);
/**
 * A paired screen's fixed scope (#500): per shared filter of its dashboard,
 * the values or range it may show. Every entry must restrict something.
 */
export const deviceFilterScopeSchema = z
  .record(
    id,
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("values"),
        values: z.array(scalar).min(1).max(100),
      }),
      z.strictObject({ kind: z.literal("range"), from: scalar, to: scalar }),
    ]),
  )
  .refine((scope) => Object.keys(scope).length <= 30, {
    message: "at most 30 filters",
  });
/**
 * A slide's scope (#707): per shared filter of its dashboard, the values or
 * range every widget on the slide applies. The same rules as a screen's.
 */
export const slideFilterScopeSchema = deviceFilterScopeSchema;
/** As stored and shown: the dashboard the scope was set for, and its values. */
export const deviceScopeSchema = z.object({
  dashboardId: z.uuid(),
  values: deviceFilterScopeSchema,
});
export type DeviceScope = z.infer<typeof deviceScopeSchema>;
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
      /** The part of requiredDimensions the measure must be grouped by (its
       * rolling windows and day/week offsets): a filter fixing the date does
       * not give it a single value. */
      perDateDimensions: z.array(id).optional(),
      /** The value is a change ratio, (current − previous) / |previous|;
       * clients show it as a percentage. */
      percentChange: z.literal(true).optional(),
      /** The unit its values carry (#835), as cells do; absent: none or
       * unknown. The Studio's readability check counts its words. */
      unit: z.string().optional(),
    }),
  ),
  dimensions: z.array(
    z.object({
      id,
      name: z.string(),
      type: z.enum(DATA_TYPES),
      /** The field's presentation role: "image", an image URL (#810). */
      role: z.literal("image").optional(),
    }),
  ),
});
/** The fields of a freshness summary (ADR 0025 section 7). */
const freshnessSummaryShape = {
  kind: z.enum(["periodic", "continuous"]),
  /** The stream's name in the payload's language ("Sales"). */
  stream: z.string().min(1),
  /** The oldest check of the rows used: when netrics last read them. */
  fetchedAt: z.iso.datetime(),
  /** YYYY-MM-DD, the provider's last complete day; never converted. */
  dataThrough: z.iso.date().optional(),
  /** A stream published by calendar month: name the month, not the day. */
  period: z.literal("month").optional(),
  /** When the period after dataThrough should be published, when known. */
  nextExpectedAt: z.iso.datetime().optional(),
  /** A sync after nextExpectedAt (plus grace) still did not find the period. */
  late: z.literal(true).optional(),
  /** The earliest next scheduled sync of the connections used. */
  nextCheckAt: z.iso.datetime().optional(),
};
/**
 * One source of a widget that combines sources (ADR 0025 section 7, #784):
 * the summary of the rows of one connector ("App Store", "Google Play"),
 * the least fresh of them, named as screens list it.
 */
export const widgetFreshnessSourceSchema = z.object({
  /** The source's short name in the payload's language ("App Store"). */
  source: z.string().min(1).max(60),
  ...freshnessSummaryShape,
});
export type WidgetFreshnessSource = z.infer<typeof widgetFreshnessSourceSchema>;
/**
 * How far a widget's numbers reach (ADR 0025 section 7): the least fresh
 * of the freshness streams its data depends on. Absent for widgets whose
 * connectors report no freshness, which show `updatedAt` as before. Every
 * value comes from stored rows, never the clock; clients word the times
 * themselves, in the viewer's time zone.
 */
export const widgetFreshnessSchema = z.object({
  ...freshnessSummaryShape,
  /**
   * A widget whose rows come from more than one connector (#784): each
   * one's summary, in name order, so screens list every source's day and
   * next time ("App Store up to Nov 17 · next ~9 PM · Google Play up to
   * Nov 11") instead of the least fresh one's only: one per connector,
   * never one left out (bounded at 50). The fields above stay
   * the least fresh, for clients that do not know `sources`.
   */
  sources: z.array(widgetFreshnessSourceSchema).min(2).max(50).optional(),
});
export type WidgetFreshness = z.infer<typeof widgetFreshnessSchema>;
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
  /** ADR 0025: through the model's sources; absent without freshness. */
  freshness: widgetFreshnessSchema.optional(),
  /**
   * A value view with a grouping (a total with its split, #784): the first
   * measure summed over every group, one cell per currency (and unit).
   * Only for a sum or count over a complete result; absent where a total
   * makes no sense, and screens then show the groups alone.
   */
  totals: z.array(modelMeasureCellSchema).max(20).optional(),
});
export const itemsWidgetDataSchema = z.object({
  widgetId: z.uuid(),
  status: z.enum(["ok", "no_data"]),
  /** Newest first. */
  items: z.array(itemsWidgetItemSchema).max(CUSTOM_API_IMAGE_NEWEST_MAX),
  error: z.string().nullable(),
  exclusions: z.array(dashboardFilterExclusionSchema),
  /** ADR 0025: through the model's sources; absent without freshness. */
  freshness: widgetFreshnessSchema.optional(),
});
export type ItemsWidgetData = z.infer<typeof itemsWidgetDataSchema>;
export const dashboardDataResponseSchema = z.object({
  widgets: z.array(dashboardWidgetDataSchema),
  /** Latest-items widgets' data (#810). */
  items: z.array(itemsWidgetDataSchema).max(48).default([]),
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
        /** The scope of the widget's slide (#707); missing: none. */
        scope: slideFilterScopeSchema.optional(),
      }),
    )
    .max(48),
  /** Unsaved latest-items widgets (#810). */
  items: z
    .array(
      z.strictObject({
        id: z.uuid(),
        binding: itemsWidgetBindingSchema,
        options: itemsWidgetOptionsSchema,
        scope: slideFilterScopeSchema.optional(),
      }),
    )
    .max(48)
    .default([]),
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
