import type { WorkspaceMetric } from "@netrics/contracts";
import {
  RESOURCE_DIMENSION,
  type Locale,
  type WidgetType,
} from "@netrics/domain";

import type { NewWidget } from "./studio-document";
import { pickableMetrics } from "./format-metric";
import { webTranslator } from "./i18n/catalogs";
import { needsCurrency } from "./tile-currency";

// What "Add widget" creates (ADR 0015, section 2): every type with
// sensible defaults, so a widget saves as it is. The inspector (#225)
// changes the data binding and style afterwards.

/** Metrics a new data widget can start with: displayable, one currency. */
function startingMetrics(metrics: readonly WorkspaceMetric[]) {
  return pickableMetrics(metrics).filter((metric) => !needsCurrency(metric));
}

/** A dimension a bar widget can group by: resources first. */
function groupBy(metric: WorkspaceMetric): string | null {
  if (metric.dimensions.includes(RESOURCE_DIMENSION)) {
    return RESOURCE_DIMENSION;
  }
  return (
    metric.dimensions.find((dimension) => dimension !== "currency") ?? null
  );
}

/**
 * A new widget of `type` with defaults, or null with the reason it cannot
 * be made yet (no metric to show, no image uploaded).
 */
export function newWidget(
  type: WidgetType,
  input: {
    metrics: readonly WorkspaceMetric[];
    /** Workspace images, newest first. */
    imageIds: readonly string[];
    /** The language of the reasons and of a new text widget's text. */
    locale: Locale;
  },
): { widget: NewWidget } | { reason: string } {
  const t = webTranslator(input.locale, "studio.newWidget");
  switch (type) {
    case "metric":
    case "line": {
      const metric = startingMetrics(input.metrics)[0];
      if (!metric) {
        return { reason: t("noMetrics") };
      }
      const binding = {
        title: null,
        connectionId: metric.connectionId,
        metricKey: metric.key,
        aggregation: metric.aggregations[0]!,
        period: "last_7_days" as const,
        dimensions: {},
        displayCurrency: null,
        resourceName: null,
        allResourcesName: null,
      };
      return type === "metric"
        ? {
            widget: {
              type,
              ...binding,
              options: { showSparkline: true, showChange: true },
            },
          }
        : {
            widget: {
              type,
              ...binding,
              options: { showPrevious: true, showAxis: true },
            },
          };
    }
    case "bar": {
      const metric = startingMetrics(input.metrics).find(
        (candidate) => groupBy(candidate) !== null,
      );
      if (!metric) {
        return { reason: t("noBreakdown") };
      }
      return {
        widget: {
          type,
          title: null,
          connectionId: metric.connectionId,
          metricKey: metric.key,
          aggregation: metric.aggregations[0]!,
          period: "last_30_days",
          dimensions: {},
          displayCurrency: null,
          resourceName: null,
          allResourcesName: null,
          options: { groupBy: groupBy(metric)!, limit: 5 },
        },
      };
    }
    case "image": {
      const imageId = input.imageIds[0];
      if (!imageId) {
        return { reason: t("noImage") };
      }
      return {
        widget: {
          type,
          title: null,
          imageId,
          options: { fit: "contain", align: "center" },
        },
      };
    }
    case "text":
      return {
        widget: {
          type,
          title: null,
          text: t("text"),
          options: { size: "body", align: "start" },
        },
      };
    case "clock":
      return {
        widget: {
          type,
          title: null,
          options: {
            showDate: true,
            hour12: false,
            timeZone: null,
            dateStyle: "short",
            showZone: false,
          },
        },
      };
  }
}
