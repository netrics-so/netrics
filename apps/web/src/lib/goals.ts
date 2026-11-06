import type { Goal, WorkspaceMetric } from "@netrics/contracts";
import {
  CURRENCY_DIMENSION,
  amountCurrency,
  currencyExponent,
  isGoalAggregation,
  type Locale,
} from "@netrics/domain";

// The Goals page (ADR 0019 section 4, #335): which metrics can be a goal,
// and the target in display units (major units, percent) as the form shows
// it, against the payload units the API stores.

/** Metrics a goal can follow: higher is better, with a sum or last. */
export function goalMetrics(
  metrics: readonly WorkspaceMetric[],
): WorkspaceMetric[] {
  return metrics.filter(
    (metric) =>
      metric.better !== "lower" && metric.aggregations.some(isGoalAggregation),
  );
}

/** How a target is entered: an amount, a percentage or a plain number. */
export type TargetUnit =
  | { kind: "currency"; currency: string }
  | { kind: "currency_missing" }
  | { kind: "percent" }
  | { kind: "number" };

/** The unit a goal's target is entered in, from its metric and binding. */
export function targetUnit(
  unit: string,
  binding: {
    dimensions: Readonly<Record<string, string>>;
    displayCurrency: string | null;
  },
): TargetUnit {
  const currency = amountCurrency(
    unit,
    binding.dimensions[CURRENCY_DIMENSION] ?? binding.displayCurrency,
  );
  if (currency) return { kind: "currency", currency };
  if (unit === "currency_minor") return { kind: "currency_missing" };
  if (unit === "ratio") return { kind: "percent" };
  return { kind: "number" };
}

/** Payload units (minor units, 0–1) to what the form shows. */
export function targetToDisplay(target: number, unit: TargetUnit): number {
  switch (unit.kind) {
    case "currency":
      return target / 10 ** currencyExponent(unit.currency);
    case "percent":
      return Math.round(target * 100 * 1e6) / 1e6;
    default:
      return target;
  }
}

/** What the form shows to payload units; null for no positive number. */
export function targetFromDisplay(
  input: string,
  unit: TargetUnit,
): number | null {
  const value = Number(input.trim().replace(",", "."));
  if (input.trim() === "" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  switch (unit.kind) {
    case "currency":
      return Math.round(value * 10 ** currencyExponent(unit.currency));
    case "percent":
      return value / 100;
    default:
      return value;
  }
}

/**
 * Percent of the target, rounded down: never "100 %" before the goal is
 * reached (ADR 0019 §5).
 */
export function progressPercent(progress: number): number {
  // Guard against 0.29 * 100 = 28.999…
  return Math.floor(progress * 100 + 1e-9);
}

/** A goal's number in full ("15,000", "€1,234.50", "12.5%"), never compacted. */
export function formatGoalNumber(
  value: number | null,
  unit: TargetUnit,
  locale: Locale,
): string {
  if (value === null) return "—";
  const shown = targetToDisplay(value, unit);
  switch (unit.kind) {
    case "currency": {
      const digits = currencyExponent(unit.currency);
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency: unit.currency,
        minimumFractionDigits: Number.isInteger(shown) ? 0 : digits,
        maximumFractionDigits: digits,
      }).format(shown);
    }
    case "percent":
      return new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);
    default:
      return new Intl.NumberFormat(locale, {
        maximumFractionDigits: Math.abs(shown) >= 100 ? 0 : 2,
      }).format(shown);
  }
}

/** Value and target of a goal as text, in the unit it was read in. */
export function goalNumbers(
  goal: Pick<Goal, "current" | "target" | "dimensions" | "displayCurrency">,
  metricUnit: string,
  locale: Locale,
): { value: string; target: string } {
  const unit = targetUnit(
    metricUnit,
    goal.current?.currency
      ? {
          dimensions: { [CURRENCY_DIMENSION]: goal.current.currency },
          displayCurrency: null,
        }
      : goal,
  );
  return {
    value: formatGoalNumber(goal.current?.value ?? null, unit, locale),
    target: formatGoalNumber(goal.target, unit, locale),
  };
}
