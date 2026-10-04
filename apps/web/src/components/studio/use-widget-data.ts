"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  MetricBreakdownResponse,
  MetricQueryResponse,
} from "@netrics/contracts";

import { apiErrorMessage, queryMetric, queryMetricBreakdown } from "@/lib/api";
import type { RefreshCycle } from "@/lib/refresh-countdown";
import type { DataWidget } from "@/lib/studio-widgets";
import { useLocale } from "@/lib/i18n/client";

/** How often a widget refreshes its numbers while the page is visible. */
export const WIDGET_REFRESH_MS = 60_000;

/**
 * The refresh cadence of live widgets on a playing screen (TV mode, Play):
 * every widget polls each `WIDGET_REFRESH_MS` from when it mounted, which
 * is when the player started, so the header counts down from then.
 */
export function useWidgetRefreshCycle(): RefreshCycle {
  const [since] = useState(() => Date.now());
  return useMemo(() => ({ since, everyMs: WIDGET_REFRESH_MS }), [since]);
}

export interface WidgetData<T> {
  data: T | null;
  /** Why the last load failed; the last good data stays shown. */
  error: string | null;
  loading: boolean;
}

// ---------------------------------------------------------------------------
// Shared loads. The same widget can be on the page several times at once
// (the Studio's canvas and its previews; "All formats" shows a slide in
// every format, #284): widgets with the same query share one request, and
// a result stays good for a few seconds, so a refresh is not repeated per
// copy.

interface SharedLoad {
  promise: Promise<unknown>;
  startedAt: number;
  /** The result once it arrived (for copies mounted afterwards). */
  data?: unknown;
  settled: boolean;
}

/** How long a load is shared: well under the refresh interval. */
export const SHARED_LOAD_MS = 10_000;

const sharedLoads = new Map<string, SharedLoad>();

/** Forgets every shared load (tests). */
export function clearSharedLoads(): void {
  sharedLoads.clear();
}

/**
 * `load()` once per `key` within `maxAgeMs`: a caller with the same key
 * gets the request in flight, or its result while it is fresh. A failure
 * is not shared beyond the callers already waiting for it.
 */
export function sharedLoad<T>(
  key: string,
  load: () => Promise<T>,
  maxAgeMs = SHARED_LOAD_MS,
  now: () => number = Date.now,
): Promise<T> {
  const at = now();
  for (const [other, entry] of sharedLoads) {
    if (at - entry.startedAt >= maxAgeMs) sharedLoads.delete(other);
  }
  const existing = sharedLoads.get(key);
  if (existing) return existing.promise as Promise<T>;
  const entry: SharedLoad = {
    promise: Promise.resolve(),
    startedAt: at,
    settled: false,
  };
  entry.promise = load().then(
    (data) => {
      entry.data = data;
      entry.settled = true;
      return data;
    },
    (cause: unknown) => {
      if (sharedLoads.get(key) === entry) sharedLoads.delete(key);
      throw cause;
    },
  );
  sharedLoads.set(key, entry);
  return entry.promise as Promise<T>;
}

/** A fresh shared result for `key`, if one arrived. */
function sharedResult<T>(key: string | undefined): T | null {
  if (!key) return null;
  const entry = sharedLoads.get(key);
  return entry?.settled && Date.now() - entry.startedAt < SHARED_LOAD_MS
    ? (entry.data as T)
    : null;
}

/**
 * Loads a widget's numbers and refreshes them every minute while the page
 * is visible. A failure keeps the last good numbers and says why; it never
 * affects the other widgets. With `key`, copies of the same query share
 * their loads (`sharedLoad`).
 */
function usePolled<T>(
  load: () => Promise<T>,
  refreshMs: number,
  key?: string,
): WidgetData<T> {
  const locale = useLocale();
  const [state, setState] = useState<WidgetData<T>>(() => {
    const data = sharedResult<T>(key);
    return { data, error: null, loading: data === null };
  });

  useEffect(() => {
    let current = true;
    const run = () => {
      (key ? sharedLoad(key, load) : load())
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
  }, [load, refreshMs, key]);

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
  return usePolled(load, refreshMs, `metric|${workspaceId}|${key}`);
}

/**
 * A bar widget's groups, or a table's rows: with the Δ column, each with
 * its value over the previous window (ADR 0019 section 6).
 */
export function useBreakdownData(
  workspaceId: string,
  widget: Extract<DataWidget, { type: "bar" | "table" }>,
  refreshMs = WIDGET_REFRESH_MS,
): WidgetData<MetricBreakdownResponse> {
  const key = JSON.stringify({
    ...metricRequest(widget),
    groupBy: widget.options.groupBy,
    limit: widget.options.limit,
    ...(widget.type === "table" && widget.options.showChange
      ? { withPrevious: true }
      : {}),
  });
  const load = useCallback(
    () => queryMetricBreakdown(workspaceId, JSON.parse(key)),
    [workspaceId, key],
  );
  return usePolled(load, refreshMs, `breakdown|${workspaceId}|${key}`);
}
