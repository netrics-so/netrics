import type {
  MetricQueryRequest,
  MetricQueryResponse,
  WorkspaceMetric,
} from "@netrics/contracts";
import {
  findConnectionMetric,
  findWorkspace,
  listWorkspaceMetrics,
  queryMetricBuckets,
  type ConnectionMetric,
  type Transaction,
} from "@netrics/database";
import {
  addDays,
  aggregateBuckets,
  bucketCombination,
  compare,
  compatibleAggregations,
  planBuckets,
  resolvePeriod,
  type Aggregation,
  type DateRange,
  type Granularity,
  type InstantRange,
  type MetricKind,
} from "@netrics/domain";

/**
 * The metric query service (#48): one read path for dashboard tiles and, later,
 * the TV endpoint. Runs inside the caller's workspace transaction.
 */

export type MetricResult<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 404; error: string };

function present(metric: ConnectionMetric): WorkspaceMetric {
  return {
    ...metric,
    kind: metric.kind as MetricKind,
    granularity: metric.granularity as Granularity,
    aggregations: compatibleAggregations(
      metric.kind as MetricKind,
      metric.aggregations as Aggregation[],
    ),
    better: metric.better === "lower" ? "lower" : "higher",
  };
}

export async function listMetrics(
  tx: Transaction,
  workspaceId: string,
): Promise<WorkspaceMetric[]> {
  return (await listWorkspaceMetrics(tx, workspaceId)).map(present);
}

/** Reporting dates as a UTC instant range (dates.to inclusive). */
function datesToRange(dates: DateRange): InstantRange {
  return {
    start: new Date(`${dates.from}T00:00:00Z`),
    end: new Date(`${addDays(dates.to, 1)}T00:00:00Z`),
  };
}

export async function queryMetric(
  tx: Transaction,
  workspaceId: string,
  request: MetricQueryRequest,
  now: Date = new Date(),
): Promise<MetricResult<MetricQueryResponse>> {
  const workspace = await findWorkspace(tx, workspaceId);
  const found = await findConnectionMetric(
    tx,
    workspaceId,
    request.connectionId,
    request.metricKey,
  );
  if (!workspace || !found) {
    return { ok: false, status: 404, error: "metric_not_found" };
  }
  const metric = present(found);
  const aggregation = request.aggregation ?? metric.aggregations[0];
  if (!aggregation || !metric.aggregations.includes(aggregation)) {
    return { ok: false, status: 400, error: "aggregation_not_supported" };
  }
  if (Object.keys(request.dimensions ?? {}).length > 10) {
    return { ok: false, status: 400, error: "too_many_dimension_filters" };
  }

  const window = resolvePeriod(request.period, now, workspace.timeZone);
  const plan = planBuckets(window, metric.granularity);
  const byDate = plan.selection === "dates";
  const current = byDate ? datesToRange(window.dates) : window.current;
  const previous = byDate
    ? datesToRange(window.previousDates)
    : window.previous;
  const base = {
    workspaceId,
    connectionId: metric.connectionId,
    metricKey: metric.key,
    ...(request.dimensions ? { dimensions: request.dimensions } : {}),
    unit: plan.unit,
    timeZone: byDate ? "UTC" : workspace.timeZone,
    combination: bucketCombination(metric.kind),
  };
  // A window can be empty, e.g. exactly at local midnight.
  const read = (range: InstantRange) =>
    range.end > range.start
      ? queryMetricBuckets(tx, { ...base, from: range.start, to: range.end })
      : Promise.resolve([]);
  const currentBuckets = await read(current);
  const previousBuckets = await read(previous);

  const change = compare(
    aggregateBuckets(aggregation, currentBuckets),
    aggregateBuckets(aggregation, previousBuckets),
  );
  const values = new Map(currentBuckets.map((b) => [b.bucket, b.value]));
  return {
    ok: true,
    value: {
      metric,
      period: request.period,
      timeZone: workspace.timeZone,
      aggregation,
      value: change.value,
      previousValue: change.previousValue,
      delta: change.delta,
      ratio: change.ratio,
      series: plan.starts.map((bucket) => ({
        bucket,
        value: values.get(bucket) ?? null,
      })),
    },
  };
}
