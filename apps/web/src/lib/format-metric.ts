import type {
  MetricAggregation,
  MetricBetter,
  MetricPeriod,
} from "@netrics/contracts";
import {
  AGGREGATIONS,
  PERIODS,
  SERIES_UNITS,
  aggregationName,
  amountCurrency,
  comparisonLabel,
  currencyExponent,
  isPerCurrencyUnit,
  localeCompactNumber,
  narrowCompactNumber,
  periodLabel,
  sharedTranslator,
  toMajorUnits,
  type Locale,
  type SeriesUnit,
} from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

/**
 * Number formatting for dashboard tiles. Values are compacted (12.9K, 4.2M);
 * currency metrics arrive in integer minor units named "<ISO 4217>_minor"
 * (ADR 0008) and are shown in the major unit, with the currency's ISO 4217
 * exponent (JPY 0, EUR 2, BHD 3). Numbers follow the given language
 * (ADR 0016 section 8), English when none is given.
 */

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

export function formatValue(
  value: number | null,
  unit: string,
  locale: Locale = "en",
): string {
  if (value === null) {
    return "—";
  }
  const currency = amountCurrency(unit);
  if (currency) {
    const major = toMajorUnits(value, currency);
    const digits = currencyExponent(currency);
    if (Math.abs(major) >= 10_000) {
      return localeCompactNumber(major, locale, currency);
    }
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      // Whole amounts without decimals.
      minimumFractionDigits: Number.isInteger(major) ? 0 : digits,
      maximumFractionDigits: digits,
    }).format(major);
  }
  if (unit === "percent") {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)}%`;
  }
  // A share from 0 to 1 (Search Console's click-through rate).
  if (unit === "ratio") {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(value) < 0.1 ? 2 : 1 }).format(value * 100)}%`;
  }
  // A rank where 1 is the top (Search Console's average position).
  if (unit === "position") {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }
  if (Math.abs(value) >= 10_000) {
    return localeCompactNumber(value, locale);
  }
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
}

/**
 * The compact form of a value (12.3K, €4.2M) for a widget too narrow for
 * the full one (ADR 0015, section 8); percentages and positions are short
 * already and stay as they are.
 */
export function formatCompactValue(
  value: number | null,
  unit: string,
  locale: Locale = "en",
): string {
  if (value === null) {
    return "—";
  }
  const currency = amountCurrency(unit);
  if (currency) {
    return narrowCompactNumber(toMajorUnits(value, currency), locale, currency);
  }
  if (unit === "percent" || unit === "ratio" || unit === "position") {
    return formatValue(value, unit, locale);
  }
  return narrowCompactNumber(value, locale);
}

/** The shared compact form with the language's decimal separator ("12,3K"). */
export function localCompactNumber(value: number, locale: Locale): string {
  return narrowCompactNumber(value, locale);
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
  locale: Locale = "en",
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
    const percent = new Intl.NumberFormat(locale, {
      maximumFractionDigits: Math.abs(ratio) < 0.1 ? 1 : 0,
    }).format(Math.abs(ratio) * 100);
    return { direction, tone, text: `${sign}${percent}%` };
  }
  return {
    direction,
    tone,
    text: `${sign}${formatValue(Math.abs(delta), unit, locale)}`,
  };
}

/** English period names; periodLabel (@netrics/domain) for others. */
export const PERIOD_LABELS = Object.fromEntries(
  PERIODS.map((period) => [period, periodLabel(period)]),
) as Record<MetricPeriod, string>;

/** What the change is measured against, e.g. "vs previous 7 days". */
export const COMPARISON_LABELS = Object.fromEntries(
  PERIODS.map((period) => [period, comparisonLabel(period)]),
) as Record<MetricPeriod, string>;

export { comparisonLabel, periodLabel };

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
  locale: Locale = "en",
): string | null {
  if (bucket === undefined) {
    return null;
  }
  const step: SeriesUnit = SERIES_UNITS[period];
  const reportingDate = step !== "hour" && bucket.endsWith("T00:00:00.000Z");
  const format = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: reportingDate ? "UTC" : timeZone,
      ...options,
    }).format(new Date(bucket));
  switch (step) {
    case "hour":
      return format({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    case "day":
      return format({ month: "short", day: "numeric" });
    case "week":
      return sharedTranslator(locale)("weekOf", {
        date: format({ month: "short", day: "numeric" }),
      });
    case "month":
      return format({ month: "short", year: "numeric" });
  }
}

export const AGGREGATION_LABELS = Object.fromEntries(
  AGGREGATIONS.map((aggregation) => [
    aggregation,
    aggregationName(aggregation),
  ]),
) as Record<MetricAggregation, string>;

/**
 * The editor's name for an aggregation. A daily gauge (e.g. click-through
 * rate, average position) is one reading per day, so its latest, lowest or
 * highest value is a day's, never a sum over the period.
 */
export function aggregationLabel(
  aggregation: MetricAggregation,
  metric: { kind: string; granularity: string },
  locale: Locale = "en",
): string {
  return aggregationName(aggregation, metric, locale);
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
export function metricPickerLabel(
  metric: {
    name: string;
    dimensions: readonly string[];
    /** Dimension names in the viewer's language, from the API. */
    dimensionNames?: Readonly<Record<string, string>>;
  },
  locale: Locale,
): string {
  const breakdown = breakdownDimensions(metric.dimensions).map(
    (dimension) => metric.dimensionNames?.[dimension] ?? dimension,
  );
  return breakdown.length === 0
    ? metric.name
    : webTranslator(locale, "formats.metric")("perBreakdown", {
        name: metric.name,
        dimensions: breakdown.join(" / "),
      });
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
