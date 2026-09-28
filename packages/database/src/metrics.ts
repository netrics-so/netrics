import { sql } from "drizzle-orm";

import type { Transaction } from "./context.js";

// Metric reads for dashboards (#48), as netrics_app inside withWorkspace.
// The metric semantics (periods, kinds, aggregations) live in
// @netrics/domain; this module only buckets and combines stored values, and
// refuses unbounded requests.

export interface ConnectionMetric {
  connectionId: string;
  connectionName: string;
  key: string;
  name: string;
  description: string;
  kind: string;
  unit: string;
  granularity: string;
  dimensions: string[];
  aggregations: string[];
}

function toMetric(row: Record<string, unknown>): ConnectionMetric {
  return {
    connectionId: row.connection_id as string,
    connectionName: row.connection_name as string,
    key: row.key as string,
    name: row.name as string,
    description: row.description as string,
    kind: row.kind as string,
    unit: row.unit as string,
    granularity: row.granularity as string,
    dimensions: row.dimensions as string[],
    aggregations: row.aggregations as string[],
  };
}

/** Every metric the workspace's connections provide. */
export async function listWorkspaceMetrics(
  tx: Transaction,
  workspaceId: string,
): Promise<ConnectionMetric[]> {
  const rows = await tx.execute(sql`
    select c.id as connection_id, c.name as connection_name, m.key, m.name,
           m.description, m.kind, m.unit, m.granularity, m.dimensions,
           m.aggregations
    from connections c
    join metric_definitions m on m.connector_id = c.connector_id
    where c.workspace_id = ${workspaceId}
    order by c.created_at, m.key`);
  return rows.map(toMetric);
}

export async function findConnectionMetric(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  metricKey: string,
): Promise<ConnectionMetric | null> {
  const rows = await tx.execute(sql`
    select c.id as connection_id, c.name as connection_name, m.key, m.name,
           m.description, m.kind, m.unit, m.granularity, m.dimensions,
           m.aggregations
    from connections c
    join metric_definitions m on m.connector_id = c.connector_id
    where c.workspace_id = ${workspaceId}
      and c.id = ${connectionId}
      and m.key = ${metricKey}`);
  return rows[0] ? toMetric(rows[0]) : null;
}

export interface MetricBucketQuery {
  workspaceId: string;
  connectionId: string;
  metricKey: string;
  /** Only series whose dimensions contain these values. */
  dimensions?: Record<string, string>;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  unit: "hour" | "day";
  /** Zone the buckets start in ("UTC" for reporting dates). */
  timeZone: string;
  /** "sum": add all values; "sum_of_last": add each series' last value. */
  combination: "sum" | "sum_of_last";
}

export interface MetricBucket {
  /** Bucket start (ISO 8601). */
  bucket: string;
  value: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A month and its predecessor, plus slack for time zones. */
const MAX_WINDOW_MS = 63 * DAY_MS;
/** Hourly buckets only for about a day (at most 50 buckets). */
const MAX_HOURLY_WINDOW_MS = 2 * DAY_MS + 2 * 60 * 60 * 1000;
const MAX_DIMENSION_FILTERS = 10;

/**
 * Bucketed values of one metric of one connection. Rejects windows longer
 * than about two months, hourly buckets over more than about two days, and
 * more than 10 dimension filters (RangeError).
 */
export async function queryMetricBuckets(
  tx: Transaction,
  query: MetricBucketQuery,
): Promise<MetricBucket[]> {
  const span = query.to.getTime() - query.from.getTime();
  if (!(span > 0) || span > MAX_WINDOW_MS) {
    throw new RangeError("metric window must be positive and at most 63 days");
  }
  if (query.unit === "hour" && span > MAX_HOURLY_WINDOW_MS) {
    throw new RangeError("hourly buckets cover at most two days");
  }
  const dimensions = query.dimensions ?? {};
  if (Object.keys(dimensions).length > MAX_DIMENSION_FILTERS) {
    throw new RangeError("at most 10 dimension filters");
  }

  const bucket = sql`date_trunc(${query.unit}, o.source_timestamp, ${query.timeZone})`;
  const points = sql`
    select o.series_key, ${bucket} as bucket, o.source_timestamp, o.value
    from observations o
    join connections c on c.id = o.connection_id
    join metric_definitions m
      on m.id = o.metric_definition_id and m.connector_id = c.connector_id
    where o.workspace_id = ${query.workspaceId}
      and c.workspace_id = ${query.workspaceId}
      and o.connection_id = ${query.connectionId}
      and m.key = ${query.metricKey}
      and o.source_timestamp >= ${query.from.toISOString()}::timestamptz
      and o.source_timestamp < ${query.to.toISOString()}::timestamptz
      and o.dimensions @> ${JSON.stringify(dimensions)}::jsonb`;

  const rows =
    query.combination === "sum"
      ? await tx.execute(sql`
          with points as (${points})
          select bucket, sum(value) as value
          from points group by bucket order by bucket`)
      : await tx.execute(sql`
          with points as (${points}),
          last_per_series as (
            select distinct on (series_key, bucket) bucket, value
            from points
            order by series_key, bucket, source_timestamp desc
          )
          select bucket, sum(value) as value
          from last_per_series group by bucket order by bucket`);

  return rows.map((row) => ({
    bucket: new Date(row.bucket as string | Date).toISOString(),
    value: Number(row.value),
  }));
}
