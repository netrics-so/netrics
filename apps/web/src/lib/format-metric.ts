import type {
  MetricAggregation,
  MetricBetter,
  MetricPeriod,
} from "@netrics/contracts";
import {
  SERIES_UNITS,
  amountCurrency,
  compactNumber,
  currencyExponent,
  isPerCurrencyUnit,
  toMajorUnits,
  type SeriesUnit,
} from "@netrics/domain";

/**
 * Number formatting for dashboard tiles. Values are compacted (12.9K, 4.2M);
 * currency metrics arrive in integer minor units named "<ISO 4217>_minor"
 * (ADR 0008) and are shown in the major unit, with the currency's ISO 4217
 * exponent (JPY 0, EUR 2, BHD 3).
 */

const LOCALE = "en-US";

/**
 * The unit a tile formats with. A "currency_minor" amount (ADR 0014) becomes
 * its currency's "<ISO 4217>_minor"; other units stay as they are.
 */
export function displayUnit(unit: string, currency?: string | null): string {
  if (isPerCurrencyUnit(unit)) {
    const code = amountCurrency(unit, currency);
    return code ? `${code}_minor` : unit;
  }
  return unit;
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null) {
    return "—";
  }
  const currency = amountCurrency(unit);
  if (currency) {
    const major = toMajorUnits(value, currency);
    const digits = currencyExponent(currency);
    const compact = Math.abs(major) >= 10_000;
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      // Whole amounts without decimals; compact values keep one decimal.
      minimumFractionDigits: compact || Number.isInteger(major) ? 0 : digits,
      maximumFractionDigits: compact ? 1 : digits,
    }).format(major);
  }
  if (unit === "percent") {
    return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(value)}%`;
  }
  // A share from 0 to 1 (Search Console's click-through rate).
  if (unit === "ratio") {
    return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: Math.abs(value) < 0.1 ? 2 : 1 }).format(value * 100)}%`;
  }
  // A rank where 1 is the top (Search Console's average position).
  if (unit === "position") {
    return new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }
  const compact = Math.abs(value) >= 10_000;
  return new Intl.NumberFormat(LOCALE, {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
}

/**
 * The compact form of a value (12.3K, €4.2M) for a widget too narrow for
 * the full one (ADR 0015, section 8); percentages and positions are short
 * already and stay as they are.
 */
export function formatCompactValue(value: number | null, unit: string): string {
  if (value === null) {
    return "—";
  }
  const currency = amountCurrency(unit);
  if (currency) {
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(toMajorUnits(value, currency));
  }
  if (unit === "percent" || unit === "ratio" || unit === "position") {
    return formatValue(value, unit);
  }
  return compactNumber(value);
}

export type ChangeDirection = "up" | "down" | "flat";
/** Whether a change is an improvement, given which way is good. */
export type ChangeTone = "good" | "bad" | "neutral";

export interface ChangeView {
  direction: ChangeDirection;
  tone: ChangeTone;
  /** "+12.5%", or the signed absolute change when there is no ratio. */
  text: string;
}

/** Null when there is nothing to compare with. */
export function formatChange(
  delta: number | null,
  ratio: number | null,
  unit: string,
  better: MetricBetter = "higher",
): ChangeView | null {
  if (delta === null) {
    return null;
  }
  const direction: ChangeDirection =
    delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const tone: ChangeTone =
    direction === "flat"
      ? "neutral"
      : (direction === "up") === (better === "higher")
        ? "good"
        : "bad";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  // A change of rank reads in places, not as a percentage of the rank.
  if (ratio !== null && unit !== "position") {
    const percent = new Intl.NumberFormat(LOCALE, {
      maximumFractionDigits: Math.abs(ratio) < 0.1 ? 1 : 0,
    }).format(Math.abs(ratio) * 100);
    return { direction, tone, text: `${sign}${percent}%` };
  }
  return {
    direction,
    tone,
    text: `${sign}${formatValue(Math.abs(delta), unit)}`,
  };
}

export const PERIOD_LABELS: Record<MetricPeriod, string> = {
  today: "Today",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  this_month: "This month",
  last_90_days: "Last 90 days",
  last_12_months: "Last 12 months",
};

/** What the change is measured against, e.g. "vs previous 7 days". */
export const COMPARISON_LABELS: Record<MetricPeriod, string> = {
  today: "vs yesterday",
  last_7_days: "vs previous 7 days",
  last_30_days: "vs previous 30 days",
  this_month: "vs last month",
  last_90_days: "vs previous 90 days",
  last_12_months: "vs previous 12 months",
};

/**
 * A sparkline point's label in the workspace's zone: "14:00" for hours,
 * "Sep 28" for days, "Week of Sep 28" for weeks (starting Monday, or the
 * period's first day), "Sep 2026" for months. Daily metrics' buckets are
 * reporting dates stamped at UTC midnight (ADR 0008), so those are read in
 * UTC.
 */
export function sparkBucketLabel(
  bucket: string | undefined,
  period: MetricPeriod,
  timeZone: string,
): string | null {
  if (bucket === undefined) {
    return null;
  }
  const step: SeriesUnit = SERIES_UNITS[period];
  const reportingDate = step !== "hour" && bucket.endsWith("T00:00:00.000Z");
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(LOCALE, {
      timeZone: reportingDate ? "UTC" : timeZone,
      ...options,
    }).format(new Date(bucket));
  switch (step) {
    case "hour":
      return format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    case "day":
      return format({ month: "short", day: "numeric" });
    case "week":
      return `Week of ${format({ month: "short", day: "numeric" })}`;
    case "month":
      return format({ month: "short", year: "numeric" });
  }
}

export const AGGREGATION_LABELS: Record<MetricAggregation, string> = {
  sum: "Total",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  last: "Latest",
};

/**
 * The editor's name for an aggregation. A daily gauge (e.g. click-through
 * rate, average position) is one reading per day, so its latest, lowest or
 * highest value is a day's, never a sum over the period.
 */
export function aggregationLabel(
  aggregation: MetricAggregation,
  metric: { kind: string; granularity: string },
): string {
  if (metric.kind === "gauge" && metric.granularity === "day") {
    if (aggregation === "last") return "Latest day";
    if (aggregation === "min") return "Lowest day";
    if (aggregation === "max") return "Highest day";
  }
  return AGGREGATION_LABELS[aggregation];
}

/**
 * Every metric names the resource it belongs to (a property, a project);
 * further dimensions make it a breakdown (per page, query, route…).
 */
const RESOURCE_DIMENSION = "resource";

/** A metric's breakdown dimensions, i.e. all but the resource. */
export function breakdownDimensions(dimensions: readonly string[]): string[] {
  return dimensions.filter((dimension) => dimension !== RESOURCE_DIMENSION);
}

/**
 * Metrics a tile can show: displayable ones (an aggregation fits) that are
 * not helpers. Helpers (inputs for derived values, such as a position sum)
 * stay queryable, and existing tiles on them keep working.
 */
export function pickableMetrics<
  T extends { aggregations: readonly unknown[]; role: string },
>(metrics: readonly T[]): T[] {
  return metrics.filter(
    (metric) => metric.aggregations.length > 0 && metric.role !== "helper",
  );
}

/**
 * The tile picker's name for a metric. A breakdown says what it is broken
 * down by, e.g. "Clicks by breakdown (per page / query / country / device)",
 * so it cannot be mistaken for the total.
 */
export function metricPickerLabel(metric: {
  name: string;
  dimensions: readonly string[];
}): string {
  const breakdown = breakdownDimensions(metric.dimensions);
  return breakdown.length === 0
    ? metric.name
    : `${metric.name} (per ${breakdown.join(" / ")})`;
}

/**
 * An observation's breakdown values besides the resource, by dimension name,
 * e.g. [["device", "MOBILE"], ["query", "running shoes"]]; empty for a total.
 */
export function observationBreakdown(
  dimensions: Readonly<Record<string, string>>,
): Array<[dimension: string, value: string]> {
  return breakdownDimensions(Object.keys(dimensions))
    .sort()
    .map((dimension) => [dimension, dimensions[dimension]!]);
}
