"use client";

import { useEffect, useState } from "react";

import type {
  MetricAggregation,
  MetricPeriod,
  WorkspaceMetric,
} from "@netrics/contracts";
import { RESOURCE_DIMENSION, type ResourceNoun } from "@netrics/domain";

import {
  apiErrorMessage,
  listMetricCurrencies,
  listMetricResources,
  queryMetricBreakdown,
} from "@/lib/api";
import { metricIdOf } from "@/lib/studio-inspector";
import { needsCurrency, type CurrencyTotals } from "@/lib/tile-currency";
import { hasResources, type TileResources } from "@/lib/tile-resource";
import { useLocale } from "@/lib/i18n/client";

// What the inspector offers for a data widget's binding, loaded from the
// metric routes: resources with their names (#194), currencies with their
// totals (#191), and the values of other dimensions (#218).

interface Loaded<T> {
  key: string;
  value: T | null;
  error: string | null;
}

/**
 * Loads `load()` whenever `key` changes; an empty key loads nothing. The
 * result belongs to the current key only, so a slow answer for an earlier
 * choice never shows.
 */
function useLoaded<T>(
  key: string,
  load: () => Promise<T>,
): { value: T | null; error: string | null; loading: boolean } {
  const locale = useLocale();
  const [state, setState] = useState<Loaded<T>>({
    key: "",
    value: null,
    error: null,
  });
  useEffect(() => {
    if (key === "") return;
    let current = true;
    load()
      .then((value) => {
        if (current) setState({ key, value, error: null });
      })
      .catch((cause: unknown) => {
        if (current) {
          setState({ key, value: null, error: apiErrorMessage(cause, locale) });
        }
      });
    return () => {
      current = false;
    };
    // `load` closes over what `key` names, so the key alone decides.
  }, [key]);
  if (key === "" || state.key !== key) {
    return { value: null, error: null, loading: key !== "" };
  }
  return { value: state.value, error: state.error, loading: false };
}

/**
 * The resources a widget of the metric can show (#194), named first; null
 * while loading or for metrics without resources.
 */
export function useResources(
  workspaceId: string,
  metric: WorkspaceMetric | undefined,
): {
  resources: TileResources | null;
  noun: ResourceNoun | null;
  error: string | null;
} {
  const key = metric && hasResources(metric) ? metricIdOf(metric) : "";
  const loaded = useLoaded(key, () =>
    listMetricResources(workspaceId, {
      connectionId: metric!.connectionId,
      metricKey: metric!.key,
    }),
  );
  return {
    resources: loaded.value?.resources ?? null,
    noun: loaded.value?.resourceNoun ?? null,
    error: loaded.error,
  };
}

/**
 * The currencies of a per-currency amount metric over a period, largest
 * total first; null while loading or for other metrics.
 */
export function useCurrencies(
  workspaceId: string,
  metric: WorkspaceMetric | undefined,
  period: MetricPeriod,
  /** The widget's resource: its currencies only. */
  resourceId: string | null,
): { totals: CurrencyTotals | null; error: string | null } {
  const key =
    metric && needsCurrency(metric)
      ? `${metricIdOf(metric)}|${period}|${resourceId ?? ""}`
      : "";
  const loaded = useLoaded(key, () =>
    listMetricCurrencies(workspaceId, {
      connectionId: metric!.connectionId,
      metricKey: metric!.key,
      period,
      ...(resourceId
        ? { dimensions: { [RESOURCE_DIMENSION]: resourceId } }
        : {}),
    }),
  );
  return { totals: loaded.value?.currencies ?? null, error: loaded.error };
}

export interface DimensionValue {
  key: string;
  label: string;
}

/**
 * The largest values of one dimension over the widget's period (at most
 * ten, from the breakdown query), for filtering a widget on one of them.
 */
export function useDimensionValues(
  workspaceId: string,
  binding: {
    connectionId: string;
    metricKey: string;
    period: MetricPeriod;
    aggregation: MetricAggregation;
    displayCurrency: string | null;
    /** The widget's other filters; this dimension's own is left out. */
    dimensions: Readonly<Record<string, string>>;
  },
  dimension: string,
): { values: DimensionValue[] | null; error: string | null } {
  const { [dimension]: _own, ...others } = binding.dimensions;
  const request = {
    connectionId: binding.connectionId,
    metricKey: binding.metricKey,
    period: binding.period,
    aggregation: binding.aggregation,
    groupBy: dimension,
    limit: 10,
    ...(Object.keys(others).length > 0 ? { dimensions: others } : {}),
    ...(binding.displayCurrency
      ? { displayCurrency: binding.displayCurrency }
      : {}),
  };
  const key = JSON.stringify(request);
  const loaded = useLoaded(key, () =>
    queryMetricBreakdown(workspaceId, request),
  );
  return {
    values:
      loaded.value?.groups.map((group) => ({
        key: group.key,
        label: group.label,
      })) ?? null,
    error: loaded.error,
  };
}
