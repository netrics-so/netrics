"use client";

import { useCallback, useEffect, useState } from "react";

import type {
  MetricBreakdownResponse,
  MetricQueryResponse,
} from "@netrics/contracts";

import { apiErrorMessage, queryMetric, queryMetricBreakdown } from "@/lib/api";
import type { DataWidget } from "@/lib/studio-widgets";
import { useLocale } from "@/lib/i18n/client";

/** How often a widget refreshes its numbers while the page is visible. */
export const WIDGET_REFRESH_MS = 60_000;

export interface WidgetData<T> {
  data: T | null;
  /** Why the last load failed; the last good data stays shown. */
  error: string | null;
  loading: boolean;
}

/**
 * Loads a widget's numbers and refreshes them every minute while the page
 * is visible. A failure keeps the last good numbers and says why; it never
 * affects the other widgets.
 */
function usePolled<T>(
  load: () => Promise<T>,
  refreshMs: number,
): WidgetData<T> {
  const locale = useLocale();
  const [state, setState] = useState<WidgetData<T>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let current = true;
    const run = () => {
      load()
        .then((data) => {
          if (current) setState({ data, error: null, loading: false });
        })
        .catch((cause: unknown) => {
          if (current) {
            setState((previous) => ({
              data: previous.data,
              error: apiErrorMessage(cause, locale),
              loading: false,
            }));
          }
        });
    };
    run();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, refreshMs);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [load, refreshMs]);

  return state;
}

/** The binding of a data widget as a metric query. */
export function metricRequest(widget: DataWidget) {
  return {
    connectionId: widget.connectionId,
    metricKey: widget.metricKey,
    period: widget.period,
    aggregation: widget.aggregation,
    ...(Object.keys(widget.dimensions).length > 0
      ? { dimensions: widget.dimensions }
      : {}),
    ...(widget.displayCurrency
      ? { displayCurrency: widget.displayCurrency }
      : {}),
  };
}

/** A metric or line widget's numbers (value, series, previous series). */
export function useMetricData(
  workspaceId: string,
  widget: DataWidget,
  refreshMs = WIDGET_REFRESH_MS,
): WidgetData<MetricQueryResponse> {
  const key = JSON.stringify(metricRequest(widget));
  const load = useCallback(
    () => queryMetric(workspaceId, JSON.parse(key)),
    [workspaceId, key],
  );
  return usePolled(load, refreshMs);
}

/** A bar widget's groups. */
export function useBreakdownData(
  workspaceId: string,
  widget: Extract<DataWidget, { type: "bar" }>,
  refreshMs = WIDGET_REFRESH_MS,
): WidgetData<MetricBreakdownResponse> {
  const key = JSON.stringify({
    ...metricRequest(widget),
    groupBy: widget.options.groupBy,
    limit: widget.options.limit,
  });
  const load = useCallback(
    () => queryMetricBreakdown(workspaceId, JSON.parse(key)),
    [workspaceId, key],
  );
  return usePolled(load, refreshMs);
}
