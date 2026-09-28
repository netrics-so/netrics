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

export const PERIODS = [
  "today",
  "last_7_days",
  "last_30_days",
  "this_month",
] as const;
export type Period = (typeof PERIODS)[number];

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
  /** Same elapsed length as `current`, immediately before it. */
  previous: InstantRange;
  /** Sparkline bucket for hourly and instant metrics. */
  bucket: "hour" | "day";
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The current and previous window of a period at `now` in the zone. The
 * previous window is the same length: yesterday up to the same time of day,
 * the 7 or 30 days before, or the same first days of the previous month.
 */
export function resolvePeriod(
  period: Period,
  now: Date,
  timeZone: string,
): PeriodWindow {
  const today = civilDate(now, timeZone);
  let dates: DateRange;
  let previousDates: DateRange;
  switch (period) {
    case "today":
      dates = { from: today, to: today };
      previousDates = { from: addDays(today, -1), to: addDays(today, -1) };
      break;
    case "last_7_days":
    case "last_30_days": {
      const length = period === "last_7_days" ? 7 : 30;
      const from = addDays(today, -(length - 1));
      dates = { from, to: today };
      previousDates = { from: addDays(from, -length), to: addDays(from, -1) };
      break;
    }
    case "this_month": {
      const [year, month, day] = parseCivil(today);
      const from = `${today.slice(0, 7)}-01`;
      dates = { from, to: today };
      const previousYear = month === 1 ? year - 1 : year;
      const previousMonth = month === 1 ? 12 : month - 1;
      const previousFrom = `${previousYear}-${String(previousMonth).padStart(2, "0")}-01`;
      const previousDays = Math.min(
        day,
        daysInMonth(previousYear, previousMonth),
      );
      previousDates = {
        from: previousFrom,
        to: addDays(previousFrom, previousDays - 1),
      };
      break;
    }
  }

  const start = startOfDay(dates.from, timeZone);
  const elapsed = now.getTime() - start.getTime();
  const previousStart = startOfDay(previousDates.from, timeZone);
  const previousLimit = startOfDay(addDays(previousDates.to, 1), timeZone);
  const previousEnd = new Date(
    Math.min(previousStart.getTime() + elapsed, previousLimit.getTime()),
  );

  return {
    period,
    timeZone,
    dates,
    previousDates,
    current: { start, end: now },
    previous: { start: previousStart, end: previousEnd },
    bucket: period === "today" ? "hour" : "day",
  };
}

// ─── Buckets ────────────────────────────────────────────────────────────────

/** Longest window a query may cover, in days (a month plus its predecessor). */
export const MAX_WINDOW_DAYS = 62;
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
  unit: BucketUnit;
  /** Bucket starts (ISO 8601) of the current window, in order. */
  starts: string[];
}

function dateStarts(range: DateRange, toInstant: (date: CivilDate) => Date) {
  const starts: string[] = [];
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    starts.push(toInstant(date).toISOString());
  }
  return starts;
}

export function planBuckets(
  window: PeriodWindow,
  granularity: Granularity,
): BucketPlan {
  if (granularity === "day") {
    return {
      selection: "dates",
      unit: "day",
      starts: dateStarts(window.dates, (date) => new Date(`${date}T00:00:00Z`)),
    };
  }
  if (window.bucket === "day") {
    return {
      selection: "instants",
      unit: "day",
      starts: dateStarts(window.dates, (date) =>
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
  return { selection: "instants", unit: "hour", starts };
}
