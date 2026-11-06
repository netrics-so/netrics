import {
  dashboardDimensionValuesResponseSchema,
  publishedModelCatalogSchema,
  dashboardDataResponseSchema,
} from "@netrics/contracts";
import type {
  DashboardDataFilter,
  DashboardFilterValue,
  MeasureWidgetBinding,
} from "@netrics/domain";
import { browserSend } from "./api";
export const loadPublishedModels = (workspaceId: string) =>
  browserSend(
    publishedModelCatalogSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/dashboards/published-models`,
  );
export const previewDashboardMeasures = (
  workspaceId: string,
  filters: DashboardDataFilter[],
  values: Record<string, DashboardFilterValue>,
  widgets: Array<{
    id: string;
    binding: MeasureWidgetBinding;
    options: { view: "value" | "table" | "bar" | "line"; limit: number };
  }>,
) =>
  browserSend(
    dashboardDataResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards/data/preview`,
    { filters, values, widgets },
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
