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
  compactNumber,
  comparisonLabel,
  currencyExponent,
  isPerCurrencyUnit,
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

/**
 * Compact suffixes for languages whose `Intl` short compact notation does
 * not abbreviate thousands (German CLDR writes 12.900, not 12,9 Tsd.).
 * Languages not listed use `Intl` as it is.
 */
const COMPACT_SUFFIXES: Partial<Record<Locale, readonly string[]>> = {
  de: ["", "Tsd.", "Mio.", "Mrd.", "Bio."],
};

/**
 * `value` in compact notation with one decimal at most ("12,9 Tsd.",
 * "4,2 Mio. $"), or null when the language's `Intl` compact notation is
 * used as it is.
 */
function suffixCompact(
  value: number,
  locale: Locale,
  currency?: string,
): string | null {
  const suffixes = COMPACT_SUFFIXES[locale];
  if (!suffixes) {
    return null;
  }
  const magnitude = Math.abs(value);
  let tier = 0;
  while (tier < suffixes.length - 1 && magnitude >= 1000 ** (tier + 1)) {
    tier += 1;
  }
  let scaled = Math.round((value / 1000 ** tier) * 10) / 10;
  // 999,950 rounds to 1000 thousand: one million.
  if (Math.abs(scaled) >= 1000 && tier < suffixes.length - 1) {
    tier += 1;
    scaled = Math.round((value / 1000 ** tier) * 10) / 10;
  }
  const format = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    ...(currency ? { style: "currency", currency } : {}),
    minimumFractionDigits: 0,
  });
  const suffix = suffixes[tier];
  if (!suffix) {
    return format.format(scaled);
  }
  // The suffix follows the number, before a trailing currency sign.
  const parts = format.formatToParts(scaled);
  const lastNumber = parts.findLastIndex((part) =>
    ["integer", "fraction", "group", "decimal"].includes(part.type),
  );
  return parts
    .map((part, index) =>
      index === lastNumber ? `${part.value}\u00a0${suffix}` : part.value,
    )
    .join("");
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
    const compact = Math.abs(major) >= 10_000;
    const local = compact ? suffixCompact(major, locale, currency) : null;
    if (local !== null) {
      return local;
    }
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      // Whole amounts without decimals; compact values keep one decimal.
      minimumFractionDigits: compact || Number.isInteger(major) ? 0 : digits,
      maximumFractionDigits: compact ? 1 : digits,
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
  const compact = Math.abs(value) >= 10_000;
  const local = compact ? suffixCompact(value, locale) : null;
  if (local !== null) {
    return local;
  }
  return new Intl.NumberFormat(locale, {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : Math.abs(value) >= 100 ? 0 : 2,
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
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(toMajorUnits(value, currency));
  }
  if (unit === "percent" || unit === "ratio" || unit === "position") {
    return formatValue(value, unit, locale);
  }
  return localCompactNumber(value, locale);
}

/**
 * The shared compact form ("12.3K", the studio vectors' text) with the
 * language's decimal separator ("12,3K" in German). The suffixes stay:
 * the width the layout measured is the same.
 */
export function localCompactNumber(value: number, locale: Locale): string {
  const text = compactNumber(value);
  const decimal =
    new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((part) => part.type === "decimal")?.value ?? ".";
  return decimal === "." ? text : text.replace(".", decimal);
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
