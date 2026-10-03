import type { MetricCurrenciesResponse } from "@netrics/contracts";
import { CURRENCY_DIMENSION, isPerCurrencyUnit } from "@netrics/domain";

import { formatValue } from "./format-metric";

/**
 * The tile editor's currency choice for a "currency_minor" metric (ADR
 * 0014): a tile shows one currency, since amounts in different currencies
 * are never added up.
 */

export type CurrencyTotals = MetricCurrenciesResponse["currencies"];

/** Whether a tile of this metric needs a currency picked. */
export function needsCurrency(metric: { unit: string } | undefined): boolean {
  return metric !== undefined && isPerCurrencyUnit(metric.unit);
}

/**
 * The currency a new tile uses: the one picked, while the metric still has
 * it, else the one with the largest total over the tile's period (the list
 * comes largest first). Null when the metric has no amounts yet.
 */
export function effectiveCurrency(
  totals: CurrencyTotals,
  picked: string,
): string | null {
  if (picked && totals.some((option) => option.currency === picked)) {
    return picked;
  }
  return totals[0]?.currency ?? null;
}

/** "EUR · €1,234.56": a currency option with its total over the period. */
export function currencyOptionLabel(option: CurrencyTotals[number]): string {
  return `${option.currency} · ${formatValue(option.total, `${option.currency}_minor`)}`;
}

/** The dimension filter a tile saves: the currency, when it needs one. */
export function tileDimensions(
  metric: { unit: string },
  currency: string | null,
): Record<string, string> {
  return needsCurrency(metric) && currency
    ? { [CURRENCY_DIMENSION]: currency }
    : {};
}

/** A saved tile's currency, for its summary in the editor. */
export function tileCurrency(
  dimensions: Record<string, string>,
): string | null {
  return dimensions[CURRENCY_DIMENSION] ?? null;
}
