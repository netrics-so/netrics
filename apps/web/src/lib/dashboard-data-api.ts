import {
  compareMeasureReadingsResponseSchema,
  dashboardDimensionValuesResponseSchema,
  publishedModelCatalogSchema,
  dashboardDataResponseSchema,
  type ItemsWidgetOptions,
  type MetricPeriod,
  type ProjectFilterQuery,
} from "@netrics/contracts";
import type {
  CompareFormat,
  CompareMeasureBinding,
  DashboardDataFilter,
  DashboardFilterValue,
  ItemsWidgetBinding,
  MeasureWidgetBinding,
  SlideFilterScope,
} from "@netrics/domain";
import { browserSend } from "./api";
import { projectQueryString } from "./project-scope";
/** Published models for bindings; all, or those of a project scope (#573). */
export const loadPublishedModels = (
  workspaceId: string,
  query?: ProjectFilterQuery,
) =>
  browserSend(
    publishedModelCatalogSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/dashboards/published-models${projectQueryString(query)}`,
  );
export const previewDashboardMeasures = (
  workspaceId: string,
  filters: DashboardDataFilter[],
  values: Record<string, DashboardFilterValue>,
  widgets: Array<{
    id: string;
    binding: MeasureWidgetBinding;
    options: { view: "value" | "table" | "bar" | "line"; limit: number };
    /** The widget's slide's scope (#707). */
    scope?: SlideFilterScope;
  }>,
  /** Latest-items widgets (#810). */
  items: Array<{
    id: string;
    binding: ItemsWidgetBinding;
    options: ItemsWidgetOptions;
    scope?: SlideFilterScope;
  }> = [],
) =>
  browserSend(
    dashboardDataResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards/data/preview`,
    { filters, values, widgets, ...(items.length ? { items } : {}) },
  );

/** Compare widgets bound to published measures (#507), saved or not. */
export const readCompareMeasures = (
  workspaceId: string,
  widgets: Array<{
    id: string;
    period: MetricPeriod;
    measure: CompareMeasureBinding;
    format: CompareFormat;
  }>,
) =>
  browserSend(
    compareMeasureReadingsResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards/data/compare`,
    { widgets },
  );

export const loadDimensionValues = (
  workspaceId: string,
  modelId: string,
  dimensionId: string,
  search: string,
  offset = 0,
) =>
  browserSend(
    dashboardDimensionValuesResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards/models/${modelId}/dimensions/${dimensionId}/values`,
    { search, offset, limit: 100 },
  );
