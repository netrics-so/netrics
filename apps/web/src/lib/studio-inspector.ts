import {
  dashboardWidgetInputSchema,
  type DashboardWidget,
  type WorkspaceMetric,
} from "@netrics/contracts";
import {
  CURRENCY_DIMENSION,
  RESOURCE_DIMENSION,
  STUDIO_LABEL_MAX_LINES,
  allResourcesName,
  isDataWidgetType,
  labelFit,
  tileLabel,
  type ResourceNoun,
  type StudioLabelFit,
  type WidgetType,
} from "@netrics/domain";

import type { NewWidget, WidgetPatch } from "./studio-document";
import { pickableMetrics } from "./format-metric";
import { newWidget } from "./studio-new-widget";
import { needsCurrency, type CurrencyChoice } from "./tile-currency";
import type { DataWidget } from "./studio-widgets";

// The Studio inspector's rules (ADR 0015 sections 2 and 9; #225): which
// metrics, dimensions and types a widget can use, what a change keeps, and
// how its label reads on a TV. Pure, so the inspector is tested without a
// browser; the components only render these choices.

/** A widget of any type without its id and placement. */
type WidgetFields = NewWidget;

export function metricIdOf(metric: {
  connectionId: string;
  key: string;
}): string {
  return `${metric.connectionId}|${metric.key}`;
}

export function findMetric(
  metrics: readonly WorkspaceMetric[],
  widget: { connectionId: string; metricKey: string },
): WorkspaceMetric | undefined {
  return metrics.find(
    (metric) =>
      metric.connectionId === widget.connectionId &&
      metric.key === widget.metricKey,
  );
}

/**
 * Dimensions a bar can group by: the metric's own, resources first, never
 * the currency (amounts are grouped within one currency or converted).
 */
export function groupByOptions(metric: {
  dimensions: readonly string[];
}): string[] {
  const options = metric.dimensions.filter(
    (dimension) => dimension !== CURRENCY_DIMENSION,
  );
  return options.sort((a, b) =>
    a === RESOURCE_DIMENSION ? -1 : b === RESOURCE_DIMENSION ? 1 : 0,
  );
}

/** Metrics a data widget of `type` can show: bars need a dimension. */
export function metricsForType(
  metrics: readonly WorkspaceMetric[],
  type: WidgetType,
): WorkspaceMetric[] {
  const pickable = pickableMetrics(metrics);
  return type === "bar"
    ? pickable.filter((metric) => groupByOptions(metric).length > 0)
    : pickable;
}

/** Connections with at least one metric the widget type can show. */
export function connectionsForType(
  metrics: readonly WorkspaceMetric[],
  type: WidgetType,
): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const metric of metricsForType(metrics, type)) {
    if (!seen.has(metric.connectionId)) {
      seen.set(metric.connectionId, metric.connectionName);
    }
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

/**
 * Dimensions a widget can filter on besides the resource and the currency
 * (which have their own choices): "territory", "device", … A bar does not
 * filter on what it groups by.
 */
export function filterDimensions(
  metric: { dimensions: readonly string[] },
  widget: DataWidget,
): string[] {
  const groupBy = widget.type === "bar" ? widget.options.groupBy : null;
  return metric.dimensions.filter(
    (dimension) =>
      dimension !== RESOURCE_DIMENSION &&
      dimension !== CURRENCY_DIMENSION &&
      dimension !== groupBy,
  );
}

/** "territory" → "Territory". */
export function dimensionLabel(dimension: string): string {
  const words = dimension.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The groupBy a bar of `metric` starts with: one it does not filter on. */
function startingGroupBy(
  metric: WorkspaceMetric,
  dimensions: Readonly<Record<string, string>>,
  current: string | null,
): { groupBy: string; dimensions: Record<string, string> } | null {
  const options = groupByOptions(metric);
  if (options.length === 0) return null;
  const preferred =
    (current && options.includes(current) ? current : null) ??
    options.find((option) => dimensions[option] === undefined) ??
    options[0]!;
  // Grouping by a dimension the widget filters on would show one bar.
  const { [preferred]: _grouped, ...rest } = dimensions;
  return { groupBy: preferred, dimensions: rest };
}

/**
 * The patch that binds a data widget to another metric: the aggregation
 * when the metric offers it (else its default), filters on dimensions the
 * metric still has, the currency choice only for amounts, and for a bar a
 * dimension of the new metric to group by. Null when a bar cannot show
 * the metric.
 */
export function bindMetricPatch(
  widget: DataWidget,
  metric: WorkspaceMetric,
): WidgetPatch | null {
  const sameResources =
    widget.connectionId === metric.connectionId &&
    metric.dimensions.includes(RESOURCE_DIMENSION);
  const dimensions = Object.fromEntries(
    Object.entries(widget.dimensions).filter(
      ([dimension]) =>
        metric.dimensions.includes(dimension) &&
        (dimension !== RESOURCE_DIMENSION || sameResources) &&
        (dimension !== CURRENCY_DIMENSION || needsCurrency(metric)),
    ),
  );
  const aggregation = metric.aggregations.includes(widget.aggregation)
    ? widget.aggregation
    : metric.aggregations[0]!;
  const base: WidgetPatch = {
    connectionId: metric.connectionId,
    metricKey: metric.key,
    aggregation,
    dimensions,
    displayCurrency: needsCurrency(metric) ? widget.displayCurrency : null,
    resourceName:
      dimensions[RESOURCE_DIMENSION] !== undefined ? widget.resourceName : null,
    allResourcesName:
      dimensions[RESOURCE_DIMENSION] === undefined && sameResources
        ? widget.allResourcesName
        : null,
  };
  if (widget.type !== "bar") {
    return base;
  }
  const grouped = startingGroupBy(metric, dimensions, widget.options.groupBy);
  if (!grouped) return null;
  return {
    ...base,
    dimensions: grouped.dimensions,
    options: { ...widget.options, groupBy: grouped.groupBy },
  } as WidgetPatch;
}

/** A bar's patch for another groupBy: no filter on what it groups by. */
export function groupByPatch(
  widget: Extract<DataWidget, { type: "bar" }>,
  groupBy: string,
): WidgetPatch {
  const { [groupBy]: _grouped, ...dimensions } = widget.dimensions;
  return {
    dimensions,
    ...(groupBy === RESOURCE_DIMENSION ? { resourceName: null } : {}),
    options: { ...widget.options, groupBy },
  } as WidgetPatch;
}

/** The patch that shows one resource, or all of them added up. */
export function resourcePatch(
  widget: DataWidget,
  resource: { id: string; name: string | null } | null,
  allResourcesName: string | null,
): WidgetPatch {
  const { [RESOURCE_DIMENSION]: _resource, ...rest } = widget.dimensions;
  return resource
    ? {
        dimensions: { ...rest, [RESOURCE_DIMENSION]: resource.id },
        resourceName: resource.name,
        allResourcesName: null,
      }
    : { dimensions: rest, resourceName: null, allResourcesName };
}

/**
 * The scope a widget of all resources is named by ("All apps", #208),
 * once its resources are known: a patch when the draft's name differs
 * (a new widget has none until the server names it), else null.
 */
export function scopePatch(
  widget: DataWidget,
  resourceCount: number | null,
  noun: ResourceNoun | null,
): WidgetPatch | null {
  if (resourceCount === null || widget.dimensions[RESOURCE_DIMENSION]) {
    return null;
  }
  const scope = allResourcesName(noun, resourceCount);
  return scope === widget.allResourcesName ? null : { allResourcesName: scope };
}

/** The patch that filters on one value of a dimension, or none. */
export function dimensionPatch(
  widget: DataWidget,
  dimension: string,
  value: string | null,
): WidgetPatch {
  const { [dimension]: _old, ...rest } = widget.dimensions;
  return {
    dimensions: value === null ? rest : { ...rest, [dimension]: value },
  };
}

/** The widget's currency choice (#191), as the tile editor named it. */
export function currencyChoiceOf(
  widget: Pick<DataWidget, "dimensions" | "displayCurrency">,
): CurrencyChoice {
  const only = widget.dimensions[CURRENCY_DIMENSION];
  if (only) return { kind: "only", currency: only };
  if (widget.displayCurrency) {
    return { kind: "convert", currency: widget.displayCurrency };
  }
  return { kind: "workspace" };
}

/** The patch for a currency choice; other filters stay. */
export function currencyPatch(
  widget: DataWidget,
  choice: CurrencyChoice,
): WidgetPatch {
  const { [CURRENCY_DIMENSION]: _old, ...rest } = widget.dimensions;
  switch (choice.kind) {
    case "workspace":
      return { dimensions: rest, displayCurrency: null };
    case "convert":
      return { dimensions: rest, displayCurrency: choice.currency };
    case "only":
      return {
        dimensions: { ...rest, [CURRENCY_DIMENSION]: choice.currency },
        displayCurrency: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Changing the type

const BINDING_KEYS = [
  "connectionId",
  "metricKey",
  "aggregation",
  "period",
  "dimensions",
  "displayCurrency",
  "resourceName",
  "allResourcesName",
] as const;

/**
 * The widget as another type, keeping what fits: the title always, the
 * data binding between metric, line and bar, the alignment between text
 * and image. A type that cannot be made says why (no metric to show, no
 * image uploaded, a metric that cannot be broken down).
 */
export function convertWidget(
  widget: DashboardWidget,
  to: WidgetType,
  context: {
    metrics: readonly WorkspaceMetric[];
    imageIds: readonly string[];
  },
): { widget: WidgetFields } | { reason: string } {
  const made = newWidget(to, context);
  const { id: _id, x: _x, y: _y, w: _w, h: _h, ...current } = widget;
  if (current.type === to) {
    return { widget: current };
  }
  if (isDataWidgetType(to) && isDataWidgetType(widget.type)) {
    const data = widget as DataWidget;
    const binding = Object.fromEntries(
      BINDING_KEYS.map((key) => [key, data[key]]),
    );
    const fields = {
      type: to,
      title: widget.title,
      ...binding,
    } as Record<string, unknown>;
    if (to === "metric") {
      return {
        widget: {
          ...fields,
          options: { showSparkline: true, showChange: true },
        } as WidgetFields,
      };
    }
    if (to === "line") {
      return {
        widget: {
          ...fields,
          options: { showPrevious: true, showAxis: true },
        } as WidgetFields,
      };
    }
    const metric = findMetric(context.metrics, data);
    const grouped = metric
      ? startingGroupBy(metric, data.dimensions, null)
      : null;
    if (!grouped) {
      return { reason: "This metric cannot be broken down into bars." };
    }
    return {
      widget: {
        ...fields,
        dimensions: grouped.dimensions,
        ...(grouped.groupBy === RESOURCE_DIMENSION
          ? { resourceName: null }
          : {}),
        options: { groupBy: grouped.groupBy, limit: 5 },
      } as WidgetFields,
    };
  }
  if ("reason" in made) {
    return made;
  }
  const next = { ...made.widget, title: widget.title } as WidgetFields;
  // Alignment carries over between text and image.
  if (
    (next.type === "text" || next.type === "image") &&
    (widget.type === "text" || widget.type === "image")
  ) {
    (next.options as { align: string }).align = widget.options.align;
  }
  if (next.type === "text" && widget.title) {
    next.text = widget.title;
  }
  return { widget: next };
}

// ---------------------------------------------------------------------------
// Label and validation

export interface LabelPreview {
  /** What the widget shows as its label. */
  label: string;
  /** The default label, without a title override. */
  defaultLabel: string;
  fit: StudioLabelFit;
  /** Set when the label would be cut on a TV at the widget's size. */
  warning: string | null;
}

/**
 * The effective label of a data widget ("Downloads · All apps", the title
 * when it has one) and whether it fits at its size on a 1080p TV; null for
 * widgets without a label.
 */
export function labelPreview(
  widget: DashboardWidget,
  metric: { name: string } | undefined,
  fontScale = 1,
): LabelPreview | null {
  if (!isDataWidgetType(widget.type)) {
    return null;
  }
  const data = widget as DataWidget;
  const parts = {
    metricName: metric?.name ?? data.metricKey,
    dimensions: data.dimensions,
    resourceName: data.resourceName,
    allResourcesName: data.allResourcesName,
  };
  const title = data.title?.trim() || null;
  const label = tileLabel({ title, ...parts });
  const fit = labelFit(label, widget, { fontScale });
  const lines = Math.max(fit.titleLines, fit.resourceLines);
  return {
    label,
    defaultLabel: tileLabel({ title: null, ...parts }),
    fit,
    warning: fit.fits
      ? null
      : `On a TV this label needs ${lines} lines at this width and would be cut (at most ${STUDIO_LABEL_MAX_LINES}). Shorten the title or make the widget wider.`,
  };
}

/**
 * What the API would refuse in the widget's fields (options per type, the
 * text, the title), as one message, or null. Placement is checked
 * separately (documentProblems).
 */
export function widgetInputProblem(widget: DashboardWidget): string | null {
  const {
    resourceName: _resourceName,
    allResourcesName: _allResourcesName,
    ...input
  } = widget as DashboardWidget & {
    resourceName?: unknown;
    allResourcesName?: unknown;
  };
  const result = dashboardWidgetInputSchema.safeParse({
    ...input,
    title: widget.title?.trim() || null,
  });
  if (result.success) {
    return null;
  }
  const issue = result.error.issues[0]!;
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** The time zones a clock can show (IANA), workspace's first. */
export function clockTimeZones(workspaceTimeZone: string): string[] {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  return [workspaceTimeZone, ...zones.filter((z) => z !== workspaceTimeZone)];
}
