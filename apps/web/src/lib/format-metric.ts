import type { MetricAggregation, MetricPeriod } from "@netrics/contracts";

/**
 * Number formatting for dashboard tiles. Values are compacted (12.9K, 4.2M);
 * currency metrics arrive in integer minor units named "<ISO 4217>_minor"
 * (ADR 0008) and are shown in the major unit.
 */

const LOCALE = "en-US";

function currencyOf(unit: string): string | null {
  const match = /^([A-Z]{3})_minor$/.exec(unit);
  return match ? match[1]! : null;
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null) {
    return "—";
  }
  const currency = currencyOf(unit);
  if (currency) {
    const major = value / 100;
    const compact = Math.abs(major) >= 10_000;
    return new Intl.NumberFormat(LOCALE, {
      style: "currency",
      currency,
      notation: compact ? "compact" : "standard",
      // Whole amounts without ".00"; compact values keep one decimal.
      minimumFractionDigits: compact || Number.isInteger(major) ? 0 : 2,
      maximumFractionDigits: compact ? 1 : 2,
    }).format(major);
  }
  if (unit === "percent") {
    return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1 }).format(value)}%`;
  }
  const compact = Math.abs(value) >= 10_000;
  return new Intl.NumberFormat(LOCALE, {
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : Math.abs(value) >= 100 ? 0 : 2,
  }).format(value);
}

export type ChangeDirection = "up" | "down" | "flat";

export interface ChangeView {
  direction: ChangeDirection;
  /** "+12.5%", or the signed absolute change when there is no ratio. */
  text: string;
}

/** Null when there is nothing to compare with. */
export function formatChange(
  delta: number | null,
  ratio: number | null,
  unit: string,
): ChangeView | null {
  if (delta === null) {
    return null;
  }
  const direction: ChangeDirection =
    delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  if (ratio !== null) {
    const percent = new Intl.NumberFormat(LOCALE, {
      maximumFractionDigits: Math.abs(ratio) < 0.1 ? 1 : 0,
    }).format(Math.abs(ratio) * 100);
    return { direction, text: `${sign}${percent}%` };
  }
  return {
    direction,
    text: `${sign}${formatValue(Math.abs(delta), unit)}`,
  };
}

export const PERIOD_LABELS: Record<MetricPeriod, string> = {
  today: "Today",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  this_month: "This month",
};

/** What the change is measured against, e.g. "vs previous 7 days". */
export const COMPARISON_LABELS: Record<MetricPeriod, string> = {
  today: "vs yesterday",
  last_7_days: "vs previous 7 days",
  last_30_days: "vs previous 30 days",
  this_month: "vs last month",
};

export const AGGREGATION_LABELS: Record<MetricAggregation, string> = {
  sum: "Total",
  avg: "Average",
  min: "Minimum",
  max: "Maximum",
  last: "Latest",
};
