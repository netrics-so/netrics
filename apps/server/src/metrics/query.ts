import type {
  CurrencyConversionOptionsResponse,
  MetricBreakdownRequest,
  MetricBreakdownResponse,
  MetricCurrenciesRequest,
  MetricCurrenciesResponse,
  MetricQueryRequest,
  MetricQueryResponse,
  MetricResourcesRequest,
  MetricResourcesResponse,
  WorkspaceMetric,
} from "@netrics/contracts";
import {
  findConnectionMetric,
  findConnectionResourceNoun,
  findResourceNames,
  findWorkspace,
  listMetricResources,
  listWorkspaceMetrics,
  findExchangeRates,
  listRateCurrencies,
  queryMetricBuckets,
  queryMetricCurrencyBuckets,
  queryMetricCurrencyTotals,
  queryMetricGroupBuckets,
  resourceNameKey,
  type ConnectionMetric,
  type MetricCurrencyBucket,
  type MetricCurrencyTotal,
  type Transaction,
} from "@netrics/database";
import {
  CURRENCY_DIMENSION,
  DEFAULT_LOCALE,
  DEFAULT_RESOURCE_NOUN,
  EXCHANGE_RATE_SOURCE,
  RATE_BASE_CURRENCY,
  RATE_LOOKBACK_DAYS,
  RESOURCE_DIMENSION,
  RateTable,
  addDays,
  allResourcesName,
  amountCurrency,
  addUpBuckets,
  aggregateBuckets,
  alignedPreviousSeries,
  bucketCombination,
  civilDate,
  compare,
  convertBuckets,
  compatibleAggregations,
  dimensionValueLabel,
  othersLabel,
  isCurrencyCode,
  isPerCurrencyUnit,
  planBuckets,
  rankBreakdown,
  resolvePeriod,
  seriesPoints,
  type Aggregation,
  type BucketValue,
  type DateRange,
  type Granularity,
  type InstantRange,
  type Locale,
  type MetricKind,
} from "@netrics/domain";

/**
 * The metric query service (#48): one read path for dashboard tiles and, later,
 * the TV endpoint. Runs inside the caller's workspace transaction.
 */

export type MetricResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 503; error: string };

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
    role: metric.role === "helper" ? "helper" : "primary",
  };
}

/** The workspace's metrics, named in `locale` (#257). */
export async function listMetrics(
  tx: Transaction,
  workspaceId: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<WorkspaceMetric[]> {
  return (await listWorkspaceMetrics(tx, workspaceId, locale)).map(present);
}

/** Reporting dates as a UTC instant range (dates.to inclusive). */
function datesToRange(dates: DateRange): InstantRange {
  return {
    start: new Date(`${dates.from}T00:00:00Z`),
    end: new Date(`${addDays(dates.to, 1)}T00:00:00Z`),
  };
}

/** Instance settings the query service follows. */
export interface QueryOptions {
  /**
   * Whether amounts may be converted into a display currency (#191):
   * NETRICS_EXCHANGE_RATES. Off, every amount stays per currency.
   */
  exchangeRates?: boolean;
  /**
   * The language of what the query names: the metric's name and
   * description (#257), a breakdown's "Others" and country names (ADR
   * 0016). The caller's, or a screen's; English when absent.
   */
  locale?: Locale;
}

/**
 * The window a per-currency ranking covers: the current one, or the day
 * before when it is empty (exactly at local midnight).
 */
function rankingRange(current: InstantRange): InstantRange {
  return current.end > current.start
    ? current
    : {
        start: new Date(current.end.getTime() - 24 * 60 * 60 * 1000),
        end: current.end,
      };
}

export async function queryMetric(
  tx: Transaction,
  workspaceId: string,
  request: MetricQueryRequest,
  now: Date = new Date(),
  options: QueryOptions = {},
): Promise<MetricResult<MetricQueryResponse>> {
  const workspace = await findWorkspace(tx, workspaceId);
  const found = await findConnectionMetric(
    tx,
    workspaceId,
    request.connectionId,
    request.metricKey,
    options.locale,
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
  // Amounts in different currencies never add up unconverted (ADR 0014).
  const perCurrency = isPerCurrencyUnit(metric.unit);
  const filtered = request.dimensions?.[CURRENCY_DIMENSION];
  if (perCurrency && filtered !== undefined && !isCurrencyCode(filtered)) {
    return { ok: false, status: 400, error: "currency_required" };
  }

  const window = resolvePeriod(request.period, now, workspace.timeZone);
  const plan = planBuckets(window, metric.granularity);
  const byDate = plan.selection === "dates";
  const current = byDate ? datesToRange(window.dates) : window.current;
  const previous = byDate
    ? datesToRange(window.previousDates)
    : window.previous;
  const timeZone = byDate ? "UTC" : workspace.timeZone;
  const combination = bucketCombination(metric.kind);

  // Without a currency filter a per-currency amount is converted into the
  // tile's or the workspace's display currency (#191), else read in the
  // currency with the largest total over the period.
  let dimensions = request.dimensions;
  let displayCurrency: string | null = null;
  if (perCurrency && filtered === undefined) {
    displayCurrency = options.exchangeRates
      ? (request.displayCurrency ?? workspace.displayCurrency ?? null)
      : null;
    if (displayCurrency === null) {
      const [largest] = await rankedCurrencyTotals(tx, {
        workspaceId,
        metric,
        ...(request.dimensions ? { dimensions: request.dimensions } : {}),
        range: rankingRange(current),
        timeZone,
        exchangeRates: options.exchangeRates ?? false,
      });
      dimensions = largest
        ? { ...request.dimensions, [CURRENCY_DIMENSION]: largest.currency }
        : request.dimensions;
    }
  }

  const base = {
    workspaceId,
    connectionId: metric.connectionId,
    metricKey: metric.key,
    ...(dimensions ? { dimensions } : {}),
    unit: plan.unit,
    timeZone,
    combination,
  };
  // The tile's number is formed over the read buckets (days, or hours
  // today), so an average is per day; the sparkline rolls days up into weeks
  // or months for long periods. Amounts are converted per day before.
  const series = (buckets: readonly BucketValue[]) => {
    const values = new Map(
      seriesPoints(plan, aggregation, buckets).map((b) => [b.bucket, b.value]),
    );
    return plan.starts.map((bucket) => ({
      bucket,
      value: values.get(bucket) ?? null,
    }));
  };
  const respond = (
    currentBuckets: readonly BucketValue[],
    previousBuckets: readonly BucketValue[],
    currency: string | null,
    conversion: MetricQueryResponse["conversion"],
  ): MetricResult<MetricQueryResponse> => {
    const change = compare(
      aggregateBuckets(aggregation, currentBuckets),
      aggregateBuckets(aggregation, previousBuckets),
    );
    return {
      ok: true,
      value: {
        metric,
        period: request.period,
        timeZone: workspace.timeZone,
        aggregation,
        currency,
        conversion,
        value: change.value,
        previousValue: change.previousValue,
        delta: change.delta,
        ratio: change.ratio,
        series: series(currentBuckets),
        previousSeries: alignedPreviousSeries(
          window,
          plan,
          aggregation,
          previousBuckets,
        ),
      },
    };
  };

  if (displayCurrency !== null) {
    const target = displayCurrency;
    const read = (range: InstantRange) =>
      range.end > range.start
        ? queryMetricCurrencyBuckets(tx, {
            ...base,
            from: range.start,
            to: range.end,
          })
        : Promise.resolve([]);
    const [currentRows, previousRows] = [
      await read(current),
      await read(previous),
    ];
    // Each bucket at the rate of its reporting day (the bucket's date in
    // the zone it was cut in), or the last rate before it.
    const dated = (rows: readonly MetricCurrencyBucket[]) =>
      rows.map((row) => ({
        ...row,
        date: civilDate(new Date(row.bucket), timeZone),
      }));
    const all = [...dated(currentRows), ...dated(previousRows)];
    const currencies = [
      ...new Set([target, ...all.map((row) => row.currency)]),
    ].filter((currency) => currency !== RATE_BASE_CURRENCY);
    const dates = all.map((row) => row.date).sort();
    const rates = new RateTable(
      dates.length > 0
        ? await findExchangeRates(tx, {
            currencies,
            from: addDays(dates[0]!, -RATE_LOOKBACK_DAYS),
            to: dates.at(-1)!,
          })
        : [],
    );
    const inWindow = convertBuckets(dated(currentRows), target, rates);
    const before = convertBuckets(dated(previousRows), target, rates);
    const left = [
      ...new Set([
        ...inWindow.unconverted.keys(),
        ...before.unconverted.keys(),
      ]),
    ].sort();
    return respond(inWindow.converted, before.converted, target, {
      displayCurrency: target,
      approximate: true,
      source: {
        name: EXCHANGE_RATE_SOURCE.name,
        url: EXCHANGE_RATE_SOURCE.url,
      },
      unconverted: left.map((currency) => ({
        currency,
        value: aggregateBuckets(
          aggregation,
          inWindow.unconverted.get(currency) ?? [],
        ),
        previousValue: aggregateBuckets(
          aggregation,
          before.unconverted.get(currency) ?? [],
        ),
      })),
    });
  }

  // A window can be empty, e.g. exactly at local midnight.
  const read = (range: InstantRange) =>
    range.end > range.start
      ? queryMetricBuckets(tx, { ...base, from: range.start, to: range.end })
      : Promise.resolve([]);
  const currentBuckets = await read(current);
  const previousBuckets = await read(previous);
  return respond(
    currentBuckets,
    previousBuckets,
    amountCurrency(metric.unit, dimensions?.[CURRENCY_DIMENSION]),
    null,
  );
}

/** Postgres: canceling statement due to statement timeout. */
const QUERY_CANCELED = "57014";

function isQueryCanceled(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 5 && e && typeof e === "object"; depth++) {
    if ((e as { code?: unknown }).code === QUERY_CANCELED) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A metric by one of its dimensions over a period (a bar chart, ADR 0015
 * §2): one value per dimension value, formed like a tile's number over that
 * value's buckets, the largest `limit` plus "Others". Amounts follow the
 * tile rules of #191, except that amounts in several currencies are refused
 * (400 currency_required) when nothing converts them: picking the largest
 * currency would silently drop groups.
 */
export async function queryMetricBreakdown(
  tx: Transaction,
  workspaceId: string,
  request: MetricBreakdownRequest,
  now: Date = new Date(),
  options: QueryOptions = {},
): Promise<MetricResult<MetricBreakdownResponse>> {
  const workspace = await findWorkspace(tx, workspaceId);
  const found = await findConnectionMetric(
    tx,
    workspaceId,
    request.connectionId,
    request.metricKey,
    options.locale,
  );
  if (!workspace || !found) {
    return { ok: false, status: 404, error: "metric_not_found" };
  }
  const metric = present(found);
  const aggregation = request.aggregation ?? metric.aggregations[0];
  if (!aggregation || !metric.aggregations.includes(aggregation)) {
    return { ok: false, status: 400, error: "aggregation_not_supported" };
  }
  if (
    !metric.dimensions.includes(request.groupBy) ||
    request.groupBy === CURRENCY_DIMENSION
  ) {
    return { ok: false, status: 400, error: "unknown_dimension" };
  }
  if (Object.keys(request.dimensions ?? {}).length > 10) {
    return { ok: false, status: 400, error: "too_many_dimension_filters" };
  }
  const limit = request.limit;
  const perCurrency = isPerCurrencyUnit(metric.unit);
  const filtered = request.dimensions?.[CURRENCY_DIMENSION];
  if (perCurrency && filtered !== undefined && !isCurrencyCode(filtered)) {
    return { ok: false, status: 400, error: "currency_required" };
  }

  const window = resolvePeriod(request.period, now, workspace.timeZone);
  const plan = planBuckets(window, metric.granularity);
  const current =
    plan.selection === "dates" ? datesToRange(window.dates) : window.current;
  const timeZone = plan.selection === "dates" ? "UTC" : workspace.timeZone;
  const byCurrency = perCurrency && filtered === undefined;
  const displayCurrency =
    byCurrency && options.exchangeRates
      ? (request.displayCurrency ?? workspace.displayCurrency ?? null)
      : null;

  // One grouped read per window; the previous one only for the groups the
  // current one ranks (a table's Δ, ADR 0019 section 6).
  const readGroups = (range: InstantRange, groups?: readonly string[]) =>
    range.end > range.start
      ? queryMetricGroupBuckets(tx, {
          workspaceId,
          connectionId: metric.connectionId,
          metricKey: metric.key,
          ...(request.dimensions ? { dimensions: request.dimensions } : {}),
          from: range.start,
          to: range.end,
          unit: plan.unit,
          timeZone,
          combination: bucketCombination(metric.kind),
          groupBy: request.groupBy,
          byCurrency,
          ...(groups ? { groups } : {}),
        })
      : Promise.resolve([]);
  type GroupRow = Awaited<ReturnType<typeof queryMetricGroupBuckets>>[number];
  type GroupValue = { key: string | null; bucket: string; value: number };

  /** Rows converted into the display currency, and what could not be. */
  const converted = async (
    rows: readonly GroupRow[],
    target: string,
  ): Promise<{
    values: GroupValue[];
    unconverted: Map<string, BucketValue[]>;
  }> => {
    const dated = rows.map((row) => ({
      ...row,
      currency: row.currency!,
      date: civilDate(new Date(row.bucket), timeZone),
    }));
    const currencies = [
      ...new Set([target, ...dated.map((row) => row.currency)]),
    ].filter((code) => code !== RATE_BASE_CURRENCY);
    const dates = dated.map((row) => row.date).sort();
    const rates = new RateTable(
      dates.length > 0
        ? await findExchangeRates(tx, {
            currencies,
            from: addDays(dates[0]!, -RATE_LOOKBACK_DAYS),
            to: dates.at(-1)!,
          })
        : [],
    );
    const byGroup = new Map<string | null, typeof dated>();
    for (const row of dated) {
      const members = byGroup.get(row.group) ?? [];
      members.push(row);
      byGroup.set(row.group, members);
    }
    const values: GroupValue[] = [];
    const unconverted = new Map<string, BucketValue[]>();
    for (const [key, members] of byGroup) {
      const result = convertBuckets(members, target, rates);
      values.push(...result.converted.map((b) => ({ key, ...b })));
      for (const [code, buckets] of result.unconverted) {
        unconverted.set(code, (unconverted.get(code) ?? []).concat(buckets));
      }
    }
    return { values, unconverted };
  };

  let rows: GroupRow[];
  try {
    rows = await readGroups(current);
  } catch (err) {
    if (isQueryCanceled(err)) {
      return { ok: false, status: 503, error: "query_timeout" };
    }
    throw err;
  }

  let currency = amountCurrency(metric.unit, filtered);
  let conversion: MetricBreakdownResponse["conversion"] = null;
  let values: GroupValue[] = rows.map(({ group, bucket, value }) => ({
    key: group,
    bucket,
    value,
  }));
  if (byCurrency && displayCurrency === null) {
    const currencies = [...new Set(rows.map((row) => row.currency!))];
    if (currencies.length > 1) {
      return { ok: false, status: 400, error: "currency_required" };
    }
    currency = currencies[0] ?? null;
  } else if (displayCurrency !== null) {
    const result = await converted(rows, displayCurrency);
    values = result.values;
    currency = displayCurrency;
    conversion = {
      displayCurrency,
      approximate: true,
      source: {
        name: EXCHANGE_RATE_SOURCE.name,
        url: EXCHANGE_RATE_SOURCE.url,
      },
      unconverted: [...result.unconverted.keys()].sort().map((code) => ({
        currency: code,
        value: aggregateBuckets(
          aggregation,
          addUpBuckets(result.unconverted.get(code) ?? []),
        ),
        previousValue: null,
      })),
    };
  }

  const breakdown = rankBreakdown(aggregation, values, limit);

  // The previous window's value of each ranked group, formed the same way:
  // the same aggregation, the same currency (a per-currency amount keeps
  // the current window's currency; converted amounts convert again).
  let previousOf: Map<string, number> | null = null;
  if (request.withPrevious) {
    const keys = breakdown.groups.map((group) => group.key);
    const previousRange =
      plan.selection === "dates"
        ? datesToRange(window.previousDates)
        : window.previous;
    let previousRows: GroupRow[];
    try {
      previousRows = await readGroups(previousRange, keys);
    } catch (err) {
      if (isQueryCanceled(err)) {
        return { ok: false, status: 503, error: "query_timeout" };
      }
      throw err;
    }
    let previousValues: GroupValue[];
    if (displayCurrency !== null) {
      previousValues = (await converted(previousRows, displayCurrency)).values;
    } else {
      previousValues = previousRows
        .filter((row) => !byCurrency || row.currency === currency)
        .map(({ group, bucket, value }) => ({ key: group, bucket, value }));
    }
    previousOf = new Map(
      rankBreakdown(aggregation, previousValues, keys.length).groups.map(
        (group) => [group.key, group.value],
      ),
    );
  }

  const resourceNames =
    request.groupBy === RESOURCE_DIMENSION
      ? await findResourceNames(
          tx,
          workspaceId,
          breakdown.groups.map((group) => ({
            connectionId: metric.connectionId,
            resourceId: group.key,
          })),
        )
      : new Map<string, string>();
  // A column head: "Site" rather than "Resource" (the connector's noun).
  const noun =
    request.groupBy === RESOURCE_DIMENSION
      ? ((await findConnectionResourceNoun(
          tx,
          workspaceId,
          metric.connectionId,
          options.locale,
        )) ?? DEFAULT_RESOURCE_NOUN)
      : null;
  const groupByName = noun
    ? noun.singular.charAt(0).toUpperCase() + noun.singular.slice(1)
    : (metric.dimensionNames[request.groupBy] ?? request.groupBy);
  return {
    ok: true,
    value: {
      metric,
      period: request.period,
      timeZone: workspace.timeZone,
      aggregation,
      groupBy: request.groupBy,
      groupByName,
      currency,
      conversion,
      groups: breakdown.groups.map((group) => ({
        key: group.key,
        label: dimensionValueLabel(
          request.groupBy,
          group.key,
          resourceNames.get(resourceNameKey(metric.connectionId, group.key)),
          options.locale,
        ),
        value: group.value,
        ...(previousOf
          ? (() => {
              const change = compare(
                group.value,
                previousOf.get(group.key) ?? null,
              );
              return {
                previousValue: change.previousValue,
                ratio: change.ratio,
              };
            })()
          : {}),
      })),
      others: breakdown.others && {
        label: othersLabel(options.locale),
        value: breakdown.others.value,
        groups: breakdown.others.groups,
      },
    },
  };
}

/**
 * Whether amounts can be converted on this instance, and into which
 * currencies: EUR and those with a rate in the last RATE_LOOKBACK_DAYS
 * before the latest publication day (#191).
 */
export async function conversionOptions(
  tx: Transaction,
  enabled: boolean,
): Promise<CurrencyConversionOptionsResponse> {
  const source = {
    name: EXCHANGE_RATE_SOURCE.name,
    url: EXCHANGE_RATE_SOURCE.url,
  };
  if (!enabled) {
    return { enabled: false, currencies: [], latestRateDate: null, source };
  }
  const { currencies, latestDate } = await listRateCurrencies(
    tx,
    RATE_LOOKBACK_DAYS,
  );
  return {
    enabled: true,
    currencies: [...new Set([RATE_BASE_CURRENCY, ...currencies])].sort(),
    latestRateDate: latestDate,
    source,
  };
}

/**
 * The currencies of a "currency_minor" metric, each with its own total over
 * the period's current window, largest first (ADR 0014). This is the
 * per-currency breakdown a tile editor picks from; nothing is added across
 * currencies.
 */
export async function listMetricCurrencies(
  tx: Transaction,
  workspaceId: string,
  request: MetricCurrenciesRequest,
  now: Date = new Date(),
  options: QueryOptions = {},
): Promise<MetricResult<MetricCurrenciesResponse>> {
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
  if (!isPerCurrencyUnit(metric.unit)) {
    return { ok: false, status: 400, error: "metric_not_per_currency" };
  }
  const { [CURRENCY_DIMENSION]: _currency, ...dimensions } =
    request.dimensions ?? {};
  if (Object.keys(dimensions).length > 10) {
    return { ok: false, status: 400, error: "too_many_dimension_filters" };
  }
  const window = resolvePeriod(request.period, now, workspace.timeZone);
  const plan = planBuckets(window, metric.granularity);
  const current =
    plan.selection === "dates" ? datesToRange(window.dates) : window.current;
  // An empty window (exactly at local midnight) ranks by the day before.
  const currencies = await rankedCurrencyTotals(tx, {
    workspaceId,
    metric,
    ...(Object.keys(dimensions).length > 0 ? { dimensions } : {}),
    range: rankingRange(current),
    timeZone: plan.selection === "dates" ? "UTC" : workspace.timeZone,
    exchangeRates: options.exchangeRates ?? false,
  });
  return { ok: true, value: { currencies } };
}

/**
 * Each currency's own total over the range, largest first. Totals in
 * different currencies are not comparable as they are: with rates (#191)
 * they rank by their value in EUR at each day's rate, currencies without a
 * rate after those with one; without rates, by minor units.
 */
async function rankedCurrencyTotals(
  tx: Transaction,
  query: {
    workspaceId: string;
    metric: WorkspaceMetric;
    dimensions?: Record<string, string>;
    range: InstantRange;
    /** The zone reporting days are cut in. */
    timeZone: string;
    exchangeRates: boolean;
  },
): Promise<MetricCurrencyTotal[]> {
  const scope = {
    workspaceId: query.workspaceId,
    connectionId: query.metric.connectionId,
    metricKey: query.metric.key,
    ...(query.dimensions ? { dimensions: query.dimensions } : {}),
    from: query.range.start,
    to: query.range.end,
    combination: bucketCombination(query.metric.kind),
  };
  const totals = await queryMetricCurrencyTotals(tx, scope);
  if (!query.exchangeRates || totals.length < 2) {
    return totals;
  }
  const rows = (
    await queryMetricCurrencyBuckets(tx, {
      ...scope,
      unit: "day",
      timeZone: query.timeZone,
    })
  ).map((row) => ({
    ...row,
    date: civilDate(new Date(row.bucket), query.timeZone),
  }));
  const dates = rows.map((row) => row.date).sort();
  if (dates.length === 0) {
    return totals;
  }
  const rates = new RateTable(
    await findExchangeRates(tx, {
      currencies: totals
        .map((total) => total.currency)
        .filter((currency) => currency !== RATE_BASE_CURRENCY),
      from: addDays(dates[0]!, -RATE_LOOKBACK_DAYS),
      to: dates.at(-1)!,
    }),
  );
  const inEur = new Map<string, number>();
  for (const { currency } of totals) {
    const converted = convertBuckets(
      rows.filter((row) => row.currency === currency),
      RATE_BASE_CURRENCY,
      rates,
    ).converted;
    if (converted.length > 0) {
      inEur.set(
        currency,
        converted.reduce((sum, bucket) => sum + bucket.value, 0),
      );
    }
  }
  // Stable: unrated currencies keep their minor-unit order after the rest.
  return [...totals].sort((a, b) => {
    const x = inEur.get(a.currency);
    const y = inEur.get(b.currency);
    if (x === undefined || y === undefined) {
      return x === undefined ? (y === undefined ? 0 : 1) : -1;
    }
    return y - x;
  });
}

/**
 * The resources a tile of this metric can show instead of all of them added
 * up (#194), with the names the connector reported. Empty for a metric
 * without a "resource" dimension.
 */
export async function listResourcesOfMetric(
  tx: Transaction,
  workspaceId: string,
  request: MetricResourcesRequest,
  /** The language of the resource noun (#257). */
  locale: Locale = DEFAULT_LOCALE,
): Promise<MetricResult<MetricResourcesResponse>> {
  const metric = await findConnectionMetric(
    tx,
    workspaceId,
    request.connectionId,
    request.metricKey,
  );
  if (!metric) {
    return { ok: false, status: 404, error: "metric_not_found" };
  }
  const resourceNoun =
    (await findConnectionResourceNoun(
      tx,
      workspaceId,
      metric.connectionId,
      locale,
    )) ?? DEFAULT_RESOURCE_NOUN;
  if (!metric.dimensions.includes(RESOURCE_DIMENSION)) {
    return { ok: true, value: { resources: [], resourceNoun } };
  }
  const resources = await listMetricResources(tx, {
    workspaceId,
    connectionId: metric.connectionId,
    metricKey: metric.key,
  });
  return { ok: true, value: { resources, resourceNoun } };
}

function allResourcesKey(connectionId: string, metricKey: string): string {
  return `${connectionId}|${metricKey}`;
}

interface ScopedTile {
  connectionId: string;
  metricKey: string;
  dimensions: Readonly<Record<string, string>>;
}

/**
 * A tile's scope from findAllResourcesNames: null for a tile of one
 * resource, whose resource name labels it instead.
 */
export function tileAllResourcesName(
  names: ReadonlyMap<string, string>,
  tile: ScopedTile,
): string | null {
  return tile.dimensions[RESOURCE_DIMENSION] === undefined
    ? (names.get(allResourcesKey(tile.connectionId, tile.metricKey)) ?? null)
    : null;
}

/**
 * The scope of each tile of all resources (#208), read with
 * tileAllResourcesName: "All apps" when the metric has a "resource" dimension and
 * its connection more than one resource of it. Tiles of one resource, of
 * metrics without resources and of connections with a single resource are
 * missing from the map; their labels stay as they were.
 */
export async function findAllResourcesNames(
  tx: Transaction,
  workspaceId: string,
  tiles: readonly ScopedTile[],
  locale: Locale = DEFAULT_LOCALE,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const done = new Set<string>();
  for (const tile of tiles) {
    const key = allResourcesKey(tile.connectionId, tile.metricKey);
    if (tile.dimensions[RESOURCE_DIMENSION] !== undefined || done.has(key)) {
      continue;
    }
    done.add(key);
    const metric = await findConnectionMetric(
      tx,
      workspaceId,
      tile.connectionId,
      tile.metricKey,
    );
    if (!metric?.dimensions.includes(RESOURCE_DIMENSION)) {
      continue;
    }
    const resources = await listMetricResources(tx, {
      workspaceId,
      connectionId: tile.connectionId,
      metricKey: tile.metricKey,
    });
    // The connector's noun in the language when it has a translation
    // (#257), else its English one.
    const name = allResourcesName(
      resources.length > 1
        ? await findConnectionResourceNoun(
            tx,
            workspaceId,
            tile.connectionId,
            locale,
          )
        : null,
      resources.length,
      locale,
    );
    if (name !== null) {
      names.set(key, name);
    }
  }
  return names;
}
