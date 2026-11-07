import {
  compareMeasurePreviewResponseSchema,
  compareMeasureResponseSchema,
  type CompareMeasurePreview,
  type CompareMeasureRequest,
  type CompareMeasureResponse,
  type DashboardWidget,
  type PublishedModelCatalog,
  type WorkspaceMetric,
} from "@netrics/contracts";
import {
  COMPARE_MEASURE_REFUSALS,
  CURRENCY_DIMENSION,
  RESOURCE_DIMENSION,
  isPerCurrencyUnit,
  type CompareMeasureBinding,
  type CompareMeasureRefusal,
} from "@netrics/domain";

import { browserSend } from "./api";

// Saving a compare widget as a measure and binding it (#508, step 3 of
// #499): the request a widget makes, what the Studio remembers between a
// compiled draft and its publication, and what a bound widget's binding
// says against the published catalog.

export type CompareWidget = Extract<DashboardWidget, { type: "compare" }>;

/** The compile request for a widget: its sides, period and format. */
export function compareMeasureRequestOf(
  widget: CompareWidget,
  name: string,
  currency: string | null,
): CompareMeasureRequest {
  const dimensions = (filters: Readonly<Record<string, string>>) =>
    Object.keys(filters).length > 0 ? { dimensions: { ...filters } } : {};
  return {
    name: name.trim(),
    connectionId: widget.connectionId,
    metricKey: widget.metricKey,
    aggregation: widget.aggregation,
    period: widget.period,
    ...dimensions(widget.dimensions),
    denominator: {
      connectionId: widget.denominator.connectionId,
      metricKey: widget.denominator.metricKey,
      aggregation: widget.denominator.aggregation,
      ...dimensions(widget.denominator.dimensions),
    },
    format: widget.options.format,
    ...(currency ? { currency } : {}),
  };
}

const base = (workspaceId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/data/compare-measures`;

/** What saving would create, or the typed refusal (an ApiError). */
export const previewCompareMeasure = (
  workspaceId: string,
  request: CompareMeasureRequest,
): Promise<CompareMeasurePreview> =>
  browserSend(
    compareMeasurePreviewResponseSchema,
    "POST",
    `${base(workspaceId)}/preview`,
    request,
  );

/** Creates the preparation (published) and the draft model. */
export const createCompareMeasure = (
  workspaceId: string,
  request: CompareMeasureRequest,
): Promise<CompareMeasureResponse> =>
  browserSend(compareMeasureResponseSchema, "POST", base(workspaceId), request);

/** A refusal the Studio words itself; other codes are API errors. */
export function compareRefusalOf(code: string): CompareMeasureRefusal | null {
  return (COMPARE_MEASURE_REFUSALS as readonly string[]).includes(code)
    ? (code as CompareMeasureRefusal)
    : null;
}

/** The suggested measure name: the title, the ratio label, else A / B. */
export function defaultMeasureName(
  widget: CompareWidget,
  numerator: WorkspaceMetric | undefined,
  denominator: WorkspaceMetric | undefined,
): string {
  const named = widget.title?.trim() || widget.options.ratioLabel?.trim();
  if (named) return named.slice(0, 100);
  return `${numerator?.name ?? widget.metricKey} / ${denominator?.name ?? widget.denominator.metricKey}`.slice(
    0,
    100,
  );
}

/** A side that needs a pinned currency, with its own resource filter. */
export interface UnpinnedSide {
  side: "numerator" | "denominator";
  metric: WorkspaceMetric;
  resourceId: string | null;
}

/**
 * The sides that need a pinned currency: per-currency amounts without a
 * currency filter. By side, since both sides can have the same metric.
 */
export function unpinnedSides(
  widget: CompareWidget,
  numerator: WorkspaceMetric | undefined,
  denominator: WorkspaceMetric | undefined,
): UnpinnedSide[] {
  const sides = [
    ["numerator", numerator, widget.dimensions],
    ["denominator", denominator, widget.denominator.dimensions],
  ] as const;
  return sides.flatMap(([side, metric, filters]) =>
    metric &&
    isPerCurrencyUnit(metric.unit) &&
    filters[CURRENCY_DIMENSION] === undefined
      ? [{ side, metric, resourceId: filters[RESOURCE_DIMENSION] ?? null }]
      : [],
  );
}

/** What a compiled widget remembers until it is bound. */
export interface SavedCompareMeasure {
  /** The widget's sides, period and format when it was compiled. */
  source: string;
  name: string;
  modelId: string;
  binding: CompareMeasureBinding;
}

/**
 * The part of a widget a compiled measure stands for: its sides and
 * format. Not the period: every period reads the same model (#507).
 */
export function compareMeasureSource(widget: CompareWidget): string {
  const {
    name: _name,
    period: _period,
    ...request
  } = compareMeasureRequestOf(widget, "", null);
  return JSON.stringify(request);
}

export function savedMeasureOf(
  result: CompareMeasureResponse,
  widget: CompareWidget,
  name: string,
): SavedCompareMeasure {
  return {
    source: compareMeasureSource(widget),
    name,
    modelId: result.modelId,
    binding: {
      modelId: result.modelId,
      dateDimensionId: result.dateDimensionId,
      measureIds: {
        numerator: result.measures.numerator,
        denominator: result.measures.denominator,
        ratio: result.measures.ratio,
      },
    },
  };
}

/**
 * Kept by the widget's sides, not its id: a widget added since the last
 * save gets its id from the server when the dashboard is saved, and a
 * compare with the same sides compiles to the same measures.
 */
const storageKey = (workspaceId: string, source: string) =>
  `netrics.compareMeasure.${workspaceId}.${source}`;

/**
 * A compiled draft kept for this tab (the author publishes it in another),
 * as long as the widget still has the sides it was compiled from.
 */
export function readSavedMeasure(
  workspaceId: string,
  widget: CompareWidget,
): SavedCompareMeasure | null {
  try {
    const source = compareMeasureSource(widget);
    const raw = sessionStorage.getItem(storageKey(workspaceId, source));
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedCompareMeasure;
    return saved.source === source && typeof saved.modelId === "string"
      ? saved
      : null;
  } catch {
    return null;
  }
}

export function writeSavedMeasure(
  workspaceId: string,
  saved: SavedCompareMeasure,
): void {
  try {
    sessionStorage.setItem(
      storageKey(workspaceId, saved.source),
      JSON.stringify(saved),
    );
  } catch {
    // Storage is a convenience: the flow works without it in this page.
  }
}

/** A bound widget's binding against the published catalog. */
export type BoundMeasure =
  | {
      kind: "published";
      modelName: string;
      measureName: string;
    }
  | { kind: "unpublished" }
  | { kind: "removed"; modelName: string; measureName: string };

export function boundMeasureOf(
  binding: CompareMeasureBinding,
  models: PublishedModelCatalog["models"],
): BoundMeasure {
  const model = models.find(
    (candidate) => candidate.modelId === binding.modelId,
  );
  if (!model) return { kind: "unpublished" };
  const measures = new Map(model.measures.map((m) => [m.id, m.name]));
  const measureName =
    measures.get(binding.measureIds.ratio) ?? binding.measureIds.ratio;
  const complete =
    Object.values(binding.measureIds).every((id) => measures.has(id)) &&
    model.dimensions.some((d) => d.id === binding.dateDimensionId);
  return complete
    ? { kind: "published", modelName: model.modelName, measureName }
    : { kind: "removed", modelName: model.modelName, measureName };
}

/** The message a bound widget's typed error gets (studio.compareMeasure.errors). */
export type BoundErrorKey =
  | "unpublished"
  | "modelRemoved"
  | "measureRemoved"
  | "dimensionRemoved"
  | "dateRequired"
  | "notNumeric"
  | "units"
  | "invalid";

export function boundErrorKey(code: string): BoundErrorKey | null {
  switch (code) {
    case "data_model_not_published":
      return "unpublished";
    case "data_model_not_found":
    case "compare_measure_model_not_found":
      return "modelRemoved";
    case "model_measure_not_found":
    case "compare_measure_not_found":
      return "measureRemoved";
    case "model_dimension_not_found":
      return "dimensionRemoved";
    case "compare_measure_date_required":
      return "dateRequired";
    case "compare_measure_not_numeric":
      return "notNumeric";
    case "compare_units_incompatible":
      return "units";
    case "compare_measure_binding_invalid":
      return "invalid";
    default:
      return null;
  }
}

/** The data page with a model open, for publishing it (the existing flow). */
export function modelHref(workspaceId: string, modelId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/data?model=${encodeURIComponent(modelId)}`;
}
