import { sharedTranslator } from "./i18n/shared/index.js";
import type { Locale } from "./i18n/locale.js";

/**
 * Metric semantics for dashboards and the TV endpoint (#48): which
 * aggregations fit which metric kind, which time windows a tile can show, and
 * how bucketed values combine into a tile's number and sparkline.
 *
 * Kinds (connector SDK):
 * - delta: an amount per interval (visits per day). Buckets add up.
 * - gauge: a level at a moment (active users, storage used). The latest
 *   reading counts.
 * - counter: a running total (all-time downloads). The latest reading counts.
 *
 * Time zones: a workspace has one IANA time zone; "today" and daily buckets
 * follow it. Daily metrics are stamped at UTC midnight of the provider's
 * reporting date (ADR 0008), so they are selected by reporting date, not by
 * instant.
 */

export const METRIC_KINDS = ["gauge", "delta", "counter"] as const;
export type MetricKind = (typeof METRIC_KINDS)[number];

export const AGGREGATIONS = ["sum", "avg", "min", "max", "last"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const GRANULARITIES = ["day", "hour", "instant"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * In the order pickers offer them: each period to date before the rolling
 * period of about its length (ADR 0019 §3 added the week, quarter and year).
 */
export const PERIODS = [
  "today",
  "this_week",
  "last_7_days",
  "this_month",
  "last_30_days",
  "this_quarter",
  "last_90_days",
  "this_year",
  "last_12_months",
] as const;
export type Period = (typeof PERIODS)[number];

/** The span of one sparkline point. */
export type SeriesUnit = "hour" | "day" | "week" | "month";

/**
 * Sparkline points per period, within MAX_BUCKETS: hours today, days up to a
 * month (and this week), weeks (starting Monday) for 90 days and this
 * quarter, calendar months for 12 months and this year. A daily metric has
 * one point today.
 */
export const SERIES_UNITS: Record<Period, SeriesUnit> = {
  today: "hour",
  last_7_days: "day",
  last_30_days: "day",
  this_month: "day",
  last_90_days: "week",
  last_12_months: "month",
  this_week: "day",
  this_quarter: "week",
  this_year: "month",
};

/** Aggregations that mean something for each kind, in preference order. */
const KIND_AGGREGATIONS: Record<MetricKind, readonly Aggregation[]> = {
  delta: ["sum", "avg", "min", "max"],
  gauge: ["last", "avg", "min", "max"],
  counter: ["last", "max"],
};

/**
 * The aggregations a tile may use for a metric: meaningful for its kind and
 * declared by the connector. The first entry is the default.
 */
export function compatibleAggregations(
  kind: MetricKind,
  declared: readonly Aggregation[],
): Aggregation[] {
  return KIND_AGGREGATIONS[kind].filter((aggregation) =>
    declared.includes(aggregation),
  );
}

/**
 * How one bucket's value is formed across series (dimension combinations):
 * deltas add up; gauges and counters add each series' latest reading.
 */
export function bucketCombination(kind: MetricKind): "sum" | "sum_of_last" {
  return kind === "delta" ? "sum" : "sum_of_last";
}

export interface BucketValue {
  /** Bucket start (ISO 8601). */
  bucket: string;
  value: number;
}

/** A tile's number for one window. Null when the window has no data. */
export function aggregateBuckets(
  aggregation: Aggregation,
  buckets: readonly BucketValue[],
): number | null {
  if (buckets.length === 0) {
    return null;
  }
  const values = buckets.map((bucket) => bucket.value);
  switch (aggregation) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "avg":
      return values.reduce((total, value) => total + value, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "last": {
      const latest = [...buckets].sort((a, b) =>
        a.bucket < b.bucket ? -1 : 1,
      )[buckets.length - 1]!;
      return latest.value;
    }
  }
}

export interface Change {
  value: number | null;
  previousValue: number | null;
  /** value − previousValue; null unless both exist. */
  delta: number | null;
  /** delta ÷ |previousValue|; null when either is missing or previous is 0. */
  ratio: number | null;
}

export function compare(
  value: number | null,
  previousValue: number | null,
): Change {
  if (value === null || previousValue === null) {
    return { value, previousValue, delta: null, ratio: null };
  }
  const delta = value - previousValue;
  return {
    value,
    previousValue,
    delta,
    ratio: previousValue === 0 ? null : delta / Math.abs(previousValue),
  };
}

// ─── Time zones and periods ─────────────────────────────────────────────────

/** A calendar date, YYYY-MM-DD. */
export type CivilDate = string;

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function zonedFields(instant: Date, timeZone: string) {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== "literal") {
      fields[part.type] = Number(part.value);
    }
  }
  return fields as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** The zone's offset from UTC at `instant`, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const f = zonedFields(new Date(instant), timeZone);
  const asUtc = Date.UTC(
    f.year,
    f.month - 1,
    f.day,
    f.hour,
    f.minute,
    f.second,
  );
  return asUtc - (instant - (instant % 1000));
}

/** The calendar date at `instant` in the zone. */
export function civilDate(instant: Date, timeZone: string): CivilDate {
  const f = zonedFields(instant, timeZone);
  return `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`;
}

function parseCivil(date: CivilDate): [number, number, number] {
  const [year, month, day] = date.split("-").map(Number);
  return [year!, month!, day!];
}

export function addDays(date: CivilDate, days: number): CivilDate {
  const [year, month, day] = parseCivil(date);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * The first instant of `date` in the zone. Where a DST change skips
 * midnight, this is the first instant that exists on that date.
 */
export function startOfDay(date: CivilDate, timeZone: string): Date {
  const [year, month, day] = parseCivil(date);
  const wall = Date.UTC(year, month - 1, day);
  let instant = wall - offsetAt(wall, timeZone);
  const corrected = wall - offsetAt(instant, timeZone);
  if (corrected !== instant) {
    instant = corrected;
  }
  // A skipped midnight lands on the previous day; step to the next hour that
  // belongs to `date`.
  while (civilDate(new Date(instant), timeZone) < date) {
    instant += 60 * 60 * 1000;
  }
  return new Date(instant);
}

/**
 * The instant on `date` at `now`'s wall-clock time in the zone. A time a DST
 * change skips moves forward by the gap; a repeated one takes the second.
 */
function atTimeOfDay(date: CivilDate, now: Date, timeZone: string): Date {
  const [year, month, day] = parseCivil(date);
  const f = zonedFields(now, timeZone);
  const wall =
    Date.UTC(year, month - 1, day, f.hour, f.minute, f.second) +
    (now.getTime() % 1000);
  const guess = wall - offsetAt(wall, timeZone);
  return new Date(wall - offsetAt(guess, timeZone));
}

export interface DateRange {
  /** Inclusive. */
  from: CivilDate;
  /** Inclusive. */
  to: CivilDate;
}

export interface InstantRange {
  start: Date;
  /** Exclusive. */
  end: Date;
}

export interface PeriodWindow {
  period: Period;
  timeZone: string;
  /** Reporting dates; daily metrics are selected by these. */
  dates: DateRange;
  previousDates: DateRange;
  /** Instants; hourly and instant metrics are selected by these. */
  current: InstantRange;
  /**
   * The previous window: the same elapsed length as `current` immediately
   * before it, or for periods to date the same span of the previous period.
   */
  previous: InstantRange;
  /** Read bucket for hourly and instant metrics. */
  bucket: "hour" | "day";
  /** Sparkline point; days roll up into weeks or months for long periods. */
  series: SeriesUnit;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The first of the month `months` after (or before) `date`'s month. */
function addMonths(date: CivilDate, months: number): CivilDate {
  const [year, month] = parseCivil(date);
  return new Date(Date.UTC(year, month - 1 + months, 1))
    .toISOString()
    .slice(0, 10);
}

/** `date`'s day of month in the month starting `monthStart`, capped at its end. */
function sameDayIn(monthStart: CivilDate, day: number): CivilDate {
  const [year, month] = parseCivil(monthStart);
  return addDays(monthStart, Math.min(day, daysInMonth(year, month)) - 1);
}

function dayOfWeek(date: CivilDate): number {
  const [year, month, day] = parseCivil(date);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysBetween(from: CivilDate, to: CivilDate): number {
  const [y1, m1, d1] = parseCivil(from);
  const [y2, m2, d2] = parseCivil(to);
  return Math.round(
    (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) /
      (24 * 60 * 60 * 1000),
  );
}

/** Monday of `date`'s ISO week. */
function startOfWeek(date: CivilDate): CivilDate {
  return addDays(date, -((dayOfWeek(date) + 6) % 7));
}

/** The first day of `date`'s quarter (1 January, April, July or October). */
function startOfQuarter(date: CivilDate): CivilDate {
  const [, month] = parseCivil(date);
  return addMonths(date, -((month - 1) % 3));
}

/**
 * Reporting dates of a period to date (ADR 0019 §3) and of the same span of
 * the previous period: the previous week up to the same weekday, the
 * previous quarter up to the same day of the quarter (capped at its last
 * day), the previous year up to the same date (29 February becomes 28
 * February). `sameTimeOfDay` is false where the previous span was capped:
 * it then runs to the end of its last day.
 */
function toDateWindows(
  period: "this_week" | "this_quarter" | "this_year",
  today: CivilDate,
): { dates: DateRange; previousDates: DateRange; sameTimeOfDay: boolean } {
  switch (period) {
    case "this_week": {
      const from = startOfWeek(today);
      return {
        dates: { from, to: today },
        previousDates: { from: addDays(from, -7), to: addDays(today, -7) },
        sameTimeOfDay: true,
      };
    }
    case "this_quarter": {
      const from = startOfQuarter(today);
      const previousFrom = addMonths(from, -3);
      const previousLast = addDays(from, -1);
      const sameDay = addDays(previousFrom, daysBetween(from, today));
      const to = sameDay < previousLast ? sameDay : previousLast;
      return {
        dates: { from, to: today },
        previousDates: { from: previousFrom, to },
        sameTimeOfDay: sameDay <= previousLast,
      };
    }
    case "this_year": {
      const [year, , day] = parseCivil(today);
      const to = sameDayIn(addMonths(today, -12), day);
      return {
        dates: { from: `${year}-01-01`, to: today },
        previousDates: { from: `${year - 1}-01-01`, to },
        sameTimeOfDay: parseCivil(to)[2] === day,
      };
    }
  }
}

/**
 * The current and previous window of a period at `now` in the zone. The
 * previous window is the same length: yesterday up to the same time of day,
 * the 7, 30 or 90 days before, the same first days of the previous month, or
 * the 12 calendar months before up to the same day a year ago; for this
 * week, quarter and year, the same span of the previous one (toDateWindows).
 */
export function resolvePeriod(
  period: Period,
  now: Date,
  timeZone: string,
): PeriodWindow {
  const today = civilDate(now, timeZone);
  let dates: DateRange;
  let previousDates: DateRange;
  let sameTimeOfDay = false;
  switch (period) {
    case "today":
      dates = { from: today, to: today };
      previousDates = { from: addDays(today, -1), to: addDays(today, -1) };
      break;
    case "last_7_days":
    case "last_30_days":
    case "last_90_days": {
      const length = { last_7_days: 7, last_30_days: 30, last_90_days: 90 }[
        period
      ];
      const from = addDays(today, -(length - 1));
      dates = { from, to: today };
      previousDates = { from: addDays(from, -length), to: addDays(from, -1) };
      break;
    }
    case "this_month": {
      const from = addMonths(today, 0);
      dates = { from, to: today };
      const previousFrom = addMonths(today, -1);
      previousDates = {
        from: previousFrom,
        to: sameDayIn(previousFrom, parseCivil(today)[2]),
      };
      break;
    }
    case "last_12_months": {
      // Twelve calendar months, the current one so far: whole months make
      // whole sparkline points.
      const from = addMonths(today, -11);
      dates = { from, to: today };
      previousDates = {
        from: addMonths(today, -23),
        to: sameDayIn(addMonths(today, -12), parseCivil(today)[2]),
      };
      break;
    }
    case "this_week":
    case "this_quarter":
    case "this_year": {
      const toDate = toDateWindows(period, today);
      dates = toDate.dates;
      previousDates = toDate.previousDates;
      sameTimeOfDay = toDate.sameTimeOfDay;
      break;
    }
  }

  const start = startOfDay(dates.from, timeZone);
  const previousStart = startOfDay(previousDates.from, timeZone);
  const previousLimit = startOfDay(addDays(previousDates.to, 1), timeZone);
  // Period to date (week, quarter, year) ends on the matching date at the
  // same wall-clock time, so a DST change in between does not shift it; the
  // others keep the same elapsed time.
  const reach = sameTimeOfDay
    ? atTimeOfDay(previousDates.to, now, timeZone).getTime()
    : previousStart.getTime() + (now.getTime() - start.getTime());
  const previousEnd = new Date(Math.min(reach, previousLimit.getTime()));

  return {
    period,
    timeZone,
    dates,
    previousDates,
    current: { start, end: now },
    previous: { start: previousStart, end: previousEnd },
    bucket: period === "today" ? "hour" : "day",
    series: SERIES_UNITS[period],
  };
}

// ─── Buckets ────────────────────────────────────────────────────────────────

/** Longest window a query may cover, in days (12 calendar months). */
export const MAX_WINDOW_DAYS = 366;
/** Most sparkline points a query may return. */
export const MAX_BUCKETS = 100;

export type BucketUnit = "hour" | "day";

/**
 * Where a metric's values fall for a window: daily metrics by reporting date
 * (UTC midnight of each date, ADR 0008), everything else by instant in the
 * workspace zone. A daily metric cannot be split into hours.
 */
export interface BucketPlan {
  selection: "dates" | "instants";
  /** The buckets values are read in, and a tile's number is formed over. */
  unit: BucketUnit;
  /**
   * Sparkline point starts (ISO 8601) of the current window, in order: the
   * read buckets, or for weeks and months the first read bucket of each
   * (the window's first day for a partial first week).
   */
  starts: string[];
  /** The sparkline point: `unit`, or weeks or months of days. */
  series: SeriesUnit;
  /** Zone the read buckets start in ("UTC" for reporting dates). */
  timeZone: string;
  /** The window's first reporting date. */
  from: CivilDate;
}

/** The first day of the week (Monday) or month holding `date`, not before `from`. */
function seriesDate(
  date: CivilDate,
  series: SeriesUnit,
  from: CivilDate,
): CivilDate {
  const start =
    series === "week"
      ? startOfWeek(date)
      : series === "month"
        ? addMonths(date, 0)
        : date;
  return start < from ? from : start;
}

function dateStarts(
  range: DateRange,
  series: SeriesUnit,
  toInstant: (date: CivilDate) => Date,
) {
  const starts: string[] = [];
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    if (seriesDate(date, series, range.from) === date) {
      starts.push(toInstant(date).toISOString());
    }
  }
  return starts;
}

export function planBuckets(
  window: PeriodWindow,
  granularity: Granularity,
): BucketPlan {
  const series = window.series === "hour" ? "day" : window.series;
  if (granularity === "day") {
    return {
      selection: "dates",
      unit: "day",
      series,
      timeZone: "UTC",
      from: window.dates.from,
      starts: dateStarts(
        window.dates,
        series,
        (date) => new Date(`${date}T00:00:00Z`),
      ),
    };
  }
  if (window.bucket === "day") {
    return {
      selection: "instants",
      unit: "day",
      series,
      timeZone: window.timeZone,
      from: window.dates.from,
      starts: dateStarts(window.dates, series, (date) =>
        startOfDay(date, window.timeZone),
      ),
    };
  }
  const starts: string[] = [];
  const hour = 60 * 60 * 1000;
  for (
    let instant = window.current.start.getTime();
    instant < window.current.end.getTime();
    instant += hour
  ) {
    starts.push(new Date(instant).toISOString());
  }
  return {
    selection: "instants",
    unit: "hour",
    series: "hour",
    timeZone: window.timeZone,
    from: window.dates.from,
    starts,
  };
}

/**
 * The sparkline points of read buckets: each point is the tile's
 * aggregation over the buckets it spans (a week's total, its average day,
 * its highest day, its latest reading), so a point means what the tile's
 * number means. Identity when points are the read buckets.
 */
export function seriesPoints(
  plan: BucketPlan,
  aggregation: Aggregation,
  buckets: readonly BucketValue[],
): BucketValue[] {
  if (plan.series === plan.unit) {
    return [...buckets];
  }
  const groups = new Map<string, BucketValue[]>();
  for (const bucket of buckets) {
    const date = civilDate(new Date(bucket.bucket), plan.timeZone);
    const start = seriesDate(date, plan.series, plan.from);
    const key = (
      plan.selection === "dates"
        ? new Date(`${start}T00:00:00Z`)
        : startOfDay(start, plan.timeZone)
    ).toISOString();
    groups.set(key, [...(groups.get(key) ?? []), bucket]);
  }
  return [...groups]
    .map(([bucket, members]) => ({
      bucket,
      value: aggregateBuckets(aggregation, members)!,
    }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

// ─── Previous period (line charts, ADR 0015 §2) ─────────────────────────────

/** Calendar months a period's previous window lies before its current one. */
const PREVIOUS_MONTHS: Partial<Record<Period, number>> = {
  this_month: 1,
  last_12_months: 12,
  this_year: 12,
};

/**
 * The current window's date at the same position as `date` of the previous
 * window: the same day of the month for monthly periods (capped at the
 * month's end), else the same number of days from the window's start.
 */
function samePositionDate(window: PeriodWindow, date: CivilDate): CivilDate {
  const months = PREVIOUS_MONTHS[window.period];
  if (months !== undefined) {
    return sameDayIn(addMonths(date, months), parseCivil(date)[2]);
  }
  return addDays(
    date,
    daysBetween(window.previousDates.from, window.dates.from),
  );
}

/**
 * The previous window's points aligned to the current window's (the dashed
 * line of a line chart): point i is the same hour, day, week or month of the
 * previous window as point i of `plan.starts`, formed with the tile's
 * aggregation like seriesPoints, and stamped with the current point's
 * start. Null where the previous window has no data.
 */
export function alignedPreviousSeries(
  window: PeriodWindow,
  plan: BucketPlan,
  aggregation: Aggregation,
  previousBuckets: readonly BucketValue[],
): { bucket: string; value: number | null }[] {
  const shift =
    window.current.start.getTime() - window.previous.start.getTime();
  const moved = previousBuckets.flatMap((bucket) => {
    if (plan.unit === "hour") {
      const instant = new Date(new Date(bucket.bucket).getTime() + shift);
      return [{ bucket: instant.toISOString(), value: bucket.value }];
    }
    const date = samePositionDate(
      window,
      civilDate(new Date(bucket.bucket), plan.timeZone),
    );
    if (date < window.dates.from || date > window.dates.to) {
      return [];
    }
    const instant =
      plan.selection === "dates"
        ? new Date(`${date}T00:00:00Z`)
        : startOfDay(date, plan.timeZone);
    return [{ bucket: instant.toISOString(), value: bucket.value }];
  });
  const values = new Map(
    seriesPoints(plan, aggregation, moved).map((b) => [b.bucket, b.value]),
  );
  return plan.starts.map((bucket) => ({
    bucket,
    value: values.get(bucket) ?? null,
  }));
}

// ─── Breakdown by dimension (bar charts, ADR 0015 §2) ───────────────────────

/** Fewest and most groups a breakdown shows before "Others". */
export const MIN_BREAKDOWN_GROUPS = 3;
export const MAX_BREAKDOWN_GROUPS = 10;

/**
 * The dimension value connectors use for what they already folded together
 * (App Store territories beyond the top 10); a breakdown adds it to its own
 * "Others" group.
 */
export const OTHERS_DIMENSION_VALUE = "Others";

export interface BreakdownGroup {
  /** The dimension value. */
  key: string;
  value: number;
}

export interface Breakdown {
  /** The largest groups, largest first (ties by key). */
  groups: BreakdownGroup[];
  /**
   * Everything else added up per bucket, then aggregated like a group:
   * the remaining groups, series without the dimension and the
   * connector's own "Others". Null when there is nothing else.
   */
  others: { value: number; groups: number } | null;
}

/** Buckets of several series added up per bucket, in bucket order. */
export function addUpBuckets(buckets: readonly BucketValue[]): BucketValue[] {
  const totals = new Map<string, number>();
  for (const { bucket, value } of buckets) {
    totals.set(bucket, (totals.get(bucket) ?? 0) + value);
  }
  return [...totals]
    .map(([bucket, value]) => ({ bucket, value }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
}

/**
 * One value per dimension value over a window: each group is the tile's
 * aggregation over its buckets (a total, an average day, the latest
 * reading), so a bar means what a tile of that one value would show. The
 * `limit` largest are kept; the rest form "Others", whose buckets add up
 * across groups before they are aggregated (as series do within a tile).
 * Rows with a null key (series without the dimension) count as "Others".
 */
export function rankBreakdown(
  aggregation: Aggregation,
  rows: readonly (BucketValue & { key: string | null })[],
  limit: number,
): Breakdown {
  const byKey = new Map<string, BucketValue[]>();
  const rest: BucketValue[] = [];
  let restGroups = 0;
  for (const { key, bucket, value } of rows) {
    if (key === null || key === OTHERS_DIMENSION_VALUE) {
      rest.push({ bucket, value });
      continue;
    }
    const members = byKey.get(key) ?? [];
    members.push({ bucket, value });
    byKey.set(key, members);
  }
  const ranked = [...byKey]
    .map(([key, buckets]) => ({
      key,
      buckets,
      value: aggregateBuckets(aggregation, buckets)!,
    }))
    .sort((a, b) =>
      b.value !== a.value ? b.value - a.value : a.key < b.key ? -1 : 1,
    );
  const kept = ranked.slice(0, limit);
  for (const group of ranked.slice(limit)) {
    rest.push(...group.buckets);
    restGroups += 1;
  }
  if (rows.some((row) => row.key === OTHERS_DIMENSION_VALUE)) {
    restGroups += 1;
  }
  const othersValue =
    rest.length > 0 ? aggregateBuckets(aggregation, addUpBuckets(rest)) : null;
  return {
    groups: kept.map(({ key, value }) => ({ key, value })),
    others:
      othersValue === null ? null : { value: othersValue, groups: restGroups },
  };
}

/** Dimensions whose values are ISO 3166-1 alpha-2 region codes. */
const REGION_DIMENSIONS = new Set(["territory", "country"]);
const regionNames = new Map<Locale, Intl.DisplayNames | null>();

function regionNamesIn(locale: Locale): Intl.DisplayNames | null {
  if (!regionNames.has(locale)) {
    try {
      regionNames.set(
        locale,
        new Intl.DisplayNames([locale], { type: "region", fallback: "none" }),
      );
    } catch {
      regionNames.set(locale, null);
    }
  }
  return regionNames.get(locale) ?? null;
}

/**
 * A breakdown group's label: a resource's discovered name, a territory's or
 * country's name in the given language ("DE" → "Germany", "Deutschland"),
 * else the value itself.
 */
export function dimensionValueLabel(
  dimension: string,
  value: string,
  resourceName?: string | null,
  locale: Locale = "en",
): string {
  if (resourceName) {
    return resourceName;
  }
  if (value === "") {
    return sharedTranslator(locale)("none");
  }
  if (REGION_DIMENSIONS.has(dimension) && /^[A-Z]{2}$/.test(value)) {
    try {
      return regionNamesIn(locale)?.of(value) ?? value;
    } catch {
      return value;
    }
  }
  return value;
}
