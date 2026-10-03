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
  better: string;
  role: string;
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
    better: row.better as string,
    role: row.role as string,
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
           m.aggregations, m.better, m.role
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
           m.aggregations, m.better, m.role
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
/** Twelve calendar months (one window of last_12_months), plus slack for time zones. */
const MAX_WINDOW_MS = 368 * DAY_MS;
/** Hourly buckets only for about a day (at most 50 buckets). */
const MAX_HOURLY_WINDOW_MS = 2 * DAY_MS + 2 * 60 * 60 * 1000;
const MAX_DIMENSION_FILTERS = 10;

function checkBucketQuery(query: MetricBucketQuery): void {
  const span = query.to.getTime() - query.from.getTime();
  if (!(span > 0) || span > MAX_WINDOW_MS) {
    throw new RangeError("metric window must be positive and at most 368 days");
  }
  if (query.unit === "hour" && span > MAX_HOURLY_WINDOW_MS) {
    throw new RangeError("hourly buckets cover at most two days");
  }
  if (Object.keys(query.dimensions ?? {}).length > MAX_DIMENSION_FILTERS) {
    throw new RangeError("at most 10 dimension filters");
  }
}

/**
 * Bucket sums of one metric of one connection, also by currency when
 * `byCurrency` is set.
 */
async function bucketRows(
  tx: Transaction,
  query: MetricBucketQuery,
  byCurrency: boolean,
) {
  checkBucketQuery(query);
  const dimensions = query.dimensions ?? {};
  const bucket = sql`date_trunc(${query.unit}, o.source_timestamp, ${query.timeZone})`;
  const currency = byCurrency
    ? sql`o.dimensions ->> 'currency'`
    : sql`null::text`;
  const points = sql`
    select o.series_key, ${bucket} as bucket, ${currency} as currency,
           o.source_timestamp, o.value
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
      and o.dimensions @> ${JSON.stringify(dimensions)}::jsonb
      ${byCurrency ? sql`and o.dimensions ->> 'currency' is not null` : sql``}`;

  const rows =
    query.combination === "sum"
      ? await tx.execute(sql`
          with points as (${points})
          select bucket, currency, sum(value) as value
          from points group by bucket, currency order by bucket, currency`)
      : await tx.execute(sql`
          with points as (${points}),
          last_per_series as (
            select distinct on (series_key, bucket) bucket, currency, value
            from points
            order by series_key, bucket, source_timestamp desc
          )
          select bucket, currency, sum(value) as value
          from last_per_series group by bucket, currency
          order by bucket, currency`);
  return rows.map((row) => ({
    bucket: new Date(row.bucket as string | Date).toISOString(),
    currency: row.currency as string | null,
    value: Number(row.value),
  }));
}

/**
 * Bucketed values of one metric of one connection. Rejects windows longer
 * than about a year, hourly buckets over more than about two days, and
 * more than 10 dimension filters (RangeError).
 */
export async function queryMetricBuckets(
  tx: Transaction,
  query: MetricBucketQuery,
): Promise<MetricBucket[]> {
  return (await bucketRows(tx, query, false)).map(({ bucket, value }) => ({
    bucket,
    value,
  }));
}

export interface MetricCurrencyBucket extends MetricBucket {
  /** ISO 4217 code from the observations' `currency` dimension. */
  currency: string;
}

/**
 * Like queryMetricBuckets for a "currency_minor" metric, with one row per
 * bucket and currency: amounts are never added across currencies here
 * (display-currency conversion happens on these rows, #191).
 */
export async function queryMetricCurrencyBuckets(
  tx: Transaction,
  query: MetricBucketQuery,
): Promise<MetricCurrencyBucket[]> {
  return (await bucketRows(tx, query, true)).map((row) => ({
    bucket: row.bucket,
    currency: row.currency!,
    value: row.value,
  }));
}

export interface MetricCurrencyQuery {
  workspaceId: string;
  connectionId: string;
  metricKey: string;
  /** Only series whose dimensions contain these values. */
  dimensions?: Record<string, string>;
  /** The window the totals cover; inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  /** As in MetricBucketQuery: deltas add up, levels add each series' last. */
  combination: "sum" | "sum_of_last";
}

export interface MetricCurrencyTotal {
  /** ISO 4217 code from the observations' `currency` dimension. */
  currency: string;
  /** Minor units over the window; 0 for a currency seen only outside it. */
  total: number;
}

/**
 * The currencies of a "currency_minor" metric (ADR 0014), each with its own
 * total over the window: amounts are grouped by currency, never added
 * across currencies. Currencies seen only outside the window are listed with
 * a total of 0. Largest total first.
 */
export async function queryMetricCurrencyTotals(
  tx: Transaction,
  query: MetricCurrencyQuery,
): Promise<MetricCurrencyTotal[]> {
  const span = query.to.getTime() - query.from.getTime();
  if (!(span > 0) || span > MAX_WINDOW_MS) {
    throw new RangeError("metric window must be positive and at most 368 days");
  }
  const dimensions = query.dimensions ?? {};
  if (Object.keys(dimensions).length > MAX_DIMENSION_FILTERS) {
    throw new RangeError("at most 10 dimension filters");
  }
  const series = sql`
    select o.series_key, o.dimensions ->> 'currency' as currency,
           o.source_timestamp, o.value
    from observations o
    join connections c on c.id = o.connection_id
    join metric_definitions m
      on m.id = o.metric_definition_id and m.connector_id = c.connector_id
    where o.workspace_id = ${query.workspaceId}
      and c.workspace_id = ${query.workspaceId}
      and o.connection_id = ${query.connectionId}
      and m.key = ${query.metricKey}
      and o.dimensions ->> 'currency' is not null
      and o.dimensions @> ${JSON.stringify(dimensions)}::jsonb`;
  const inWindow = sql`
    source_timestamp >= ${query.from.toISOString()}::timestamptz
    and source_timestamp < ${query.to.toISOString()}::timestamptz`;
  const totals =
    query.combination === "sum"
      ? sql`select currency, sum(value) as total
            from points where ${inWindow} group by currency`
      : sql`select currency, sum(value) as total
            from (
              select distinct on (series_key) currency, value
              from points where ${inWindow}
              order by series_key, source_timestamp desc
            ) last_per_series
            group by currency`;
  const rows = await tx.execute(sql`
    with points as (${series}),
    totals as (${totals})
    select seen.currency, coalesce(totals.total, 0) as total
    from (select distinct currency from points) seen
    left join totals on totals.currency = seen.currency
    order by total desc, seen.currency`);
  return rows.map((row) => ({
    currency: row.currency as string,
    total: Number(row.total),
  }));
}
