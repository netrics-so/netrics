import { sql } from "drizzle-orm";

import {
  DEFAULT_LOCALE,
  localizedDimensionName,
  localizedMetric,
  type ConnectorTranslations,
} from "@netrics/domain";

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
  /**
   * A display name for each dimension, in the requested locale: the
   * connector's translation, else the key in sentence case (#257).
   */
  dimensionNames: Record<string, string>;
}

/**
 * A catalog row in `locale` (ADR 0016 section 6, #257): name, description
 * and dimension names from the connector's stored translations (the
 * manifest's `translations`, SDK 0.2.6), each falling back to English.
 */
function toMetric(
  row: Record<string, unknown>,
  locale: string,
): ConnectionMetric {
  const key = row.key as string;
  const dimensions = row.dimensions as string[];
  const manifest = {
    translations: (row.translations ?? null) as ConnectorTranslations | null,
  };
  const text = localizedMetric(
    manifest,
    {
      key,
      name: row.name as string,
      description: row.description as string,
    },
    locale,
  );
  return {
    connectionId: row.connection_id as string,
    connectionName: row.connection_name as string,
    key,
    name: text.name,
    description: text.description,
    kind: row.kind as string,
    unit: row.unit as string,
    granularity: row.granularity as string,
    dimensions,
    aggregations: row.aggregations as string[],
    better: row.better as string,
    role: row.role as string,
    dimensionNames: Object.fromEntries(
      dimensions.map((dimension) => [
        dimension,
        localizedDimensionName(manifest, dimension, locale),
      ]),
    ),
  };
}

/**
 * Every metric the workspace's connections provide, named in `locale`
 * (default English).
 */
export async function listWorkspaceMetrics(
  tx: Transaction,
  workspaceId: string,
  locale: string = DEFAULT_LOCALE,
): Promise<ConnectionMetric[]> {
  const rows = await tx.execute(sql`
    select c.id as connection_id, c.name as connection_name, m.key, m.name,
           m.description, m.kind, m.unit, m.granularity, m.dimensions,
           m.aggregations, m.better, m.role,
           k.manifest -> 'translations' as translations
    from connections c
    join metric_definitions m on m.connector_id = c.connector_id
    join connectors k on k.id = c.connector_id
    where c.workspace_id = ${workspaceId}
    order by c.created_at, m.key`);
  return rows.map((row) => toMetric(row, locale));
}

/** One metric of a connection, named in `locale` (default English). */
export async function findConnectionMetric(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  metricKey: string,
  locale: string = DEFAULT_LOCALE,
): Promise<ConnectionMetric | null> {
  const rows = await tx.execute(sql`
    select c.id as connection_id, c.name as connection_name, m.key, m.name,
           m.description, m.kind, m.unit, m.granularity, m.dimensions,
           m.aggregations, m.better, m.role,
           k.manifest -> 'translations' as translations
    from connections c
    join metric_definitions m on m.connector_id = c.connector_id
    join connectors k on k.id = c.connector_id
    where c.workspace_id = ${workspaceId}
      and c.id = ${connectionId}
      and m.key = ${metricKey}`);
  return rows[0] ? toMetric(rows[0], locale) : null;
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
  groupBy: string | null = null,
  groups: readonly string[] | null = null,
) {
  checkBucketQuery(query);
  const dimensions = query.dimensions ?? {};
  const bucket = sql`date_trunc(${query.unit}, o.source_timestamp, ${query.timeZone})`;
  const currency = byCurrency
    ? sql`o.dimensions ->> 'currency'`
    : sql`null::text`;
  const group =
    groupBy === null ? sql`null::text` : sql`o.dimensions ->> ${groupBy}`;
  const points = sql`
    select o.series_key, ${bucket} as bucket, ${currency} as currency,
           ${group} as grp, o.source_timestamp, o.value
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
      ${byCurrency ? sql`and o.dimensions ->> 'currency' is not null` : sql``}
      ${
        groupBy !== null && groups !== null
          ? sql`and o.dimensions ->> ${groupBy} in (${sql.join(
              groups.map((value) => sql`${value}`),
              sql`, `,
            )})`
          : sql``
      }`;

  const rows =
    query.combination === "sum"
      ? await tx.execute(sql`
          with points as (${points})
          select grp, bucket, currency, sum(value) as value
          from points group by grp, bucket, currency
          order by grp, bucket, currency`)
      : await tx.execute(sql`
          with points as (${points}),
          last_per_series as (
            select distinct on (series_key, bucket) grp, bucket, currency, value
            from points
            order by series_key, bucket, source_timestamp desc
          )
          select grp, bucket, currency, sum(value) as value
          from last_per_series group by grp, bucket, currency
          order by grp, bucket, currency`);
  return rows.map((row) => ({
    group: row.grp as string | null,
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

/** Longest a breakdown query may run (ADR 0015 §2: a query time budget). */
export const BREAKDOWN_TIMEOUT_MS = 5_000;

export interface MetricGroupBucket extends MetricBucket {
  /** The `groupBy` dimension's value; null for series without it. */
  group: string | null;
  /** ISO 4217 code with `byCurrency`, else null. */
  currency: string | null;
}

/**
 * Like queryMetricBuckets, with one row per value of the `groupBy`
 * dimension and bucket (and currency with `byCurrency`): the rows of a bar
 * chart's breakdown. It runs in a savepoint under a statement timeout of
 * BREAKDOWN_TIMEOUT_MS; a query that takes longer fails with Postgres error
 * 57014 and leaves the caller's transaction usable.
 */
export async function queryMetricGroupBuckets(
  tx: Transaction,
  query: MetricBucketQuery & {
    groupBy: string;
    byCurrency: boolean;
    /**
     * Only these values of `groupBy` (at least one): a table's previous
     * window, restricted to the groups the current one returned.
     */
    groups?: readonly string[];
  },
): Promise<MetricGroupBucket[]> {
  checkBucketQuery(query);
  if (query.groups !== undefined && query.groups.length === 0) {
    return [];
  }
  return tx.transaction(async (savepoint) => {
    const [setting] = await savepoint.execute(
      sql`select current_setting('statement_timeout') as value`,
    );
    await savepoint.execute(
      sql`select set_config('statement_timeout', ${String(BREAKDOWN_TIMEOUT_MS)}, true)`,
    );
    const rows = await bucketRows(
      savepoint,
      query,
      query.byCurrency,
      query.groupBy,
      query.groups ?? null,
    );
    await savepoint.execute(
      sql`select set_config('statement_timeout', ${setting!.value as string}, true)`,
    );
    return rows;
  });
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
