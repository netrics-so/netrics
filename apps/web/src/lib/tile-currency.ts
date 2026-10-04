import type {
  CurrencyConversion,
  MetricCurrenciesResponse,
} from "@netrics/contracts";
import {
  CURRENCY_DIMENSION,
  isPerCurrencyUnit,
  type Locale,
} from "@netrics/domain";

import { formatValue } from "./format-metric";
import { webTranslator } from "./i18n/catalogs";

/**
 * The tile editor's currency choice for a "currency_minor" metric (ADR
 * 0014, #191). Amounts in different currencies are never added up as they
 * are: a tile follows the workspace (converted into its display currency,
 * else the largest currency), converts into a currency of its own, or shows
 * one currency exactly.
 */

export type CurrencyTotals = MetricCurrenciesResponse["currencies"];

export type CurrencyChoice =
  | { kind: "workspace" }
  | { kind: "convert"; currency: string }
  | { kind: "only"; currency: string };

/** Whether a tile of this metric needs a currency choice. */
export function needsCurrency(metric: { unit: string } | undefined): boolean {
  return metric !== undefined && isPerCurrencyUnit(metric.unit);
}

/** The select value of a choice: "", "convert:USD" or "only:CLP". */
export function choiceValue(choice: CurrencyChoice): string {
  return choice.kind === "workspace" ? "" : `${choice.kind}:${choice.currency}`;
}

/**
 * The choice a new tile uses: the one picked, while it is still on offer
 * (the metric has that currency, or it can be converted into), else the
 * workspace's.
 */
export function effectiveChoice(
  picked: string,
  totals: CurrencyTotals,
  convertible: readonly string[],
): CurrencyChoice {
  const [kind, currency] = picked.split(":");
  if (
    kind === "only" &&
    currency &&
    totals.some((option) => option.currency === currency)
  ) {
    return { kind, currency };
  }
  if (kind === "convert" && currency && convertible.includes(currency)) {
    return { kind, currency };
  }
  return { kind: "workspace" };
}

/** "EUR · €1,234.56": a currency option with its total over the period. */
export function currencyOptionLabel(
  option: CurrencyTotals[number],
  locale: Locale,
): string {
  return `${option.currency} · ${formatValue(option.total, `${option.currency}_minor`, locale)}`;
}

/**
 * The workspace option: "Workspace: converted to EUR (≈)", or per currency
 * with the largest one now ("Workspace: per currency, now JPY").
 */
export function workspaceChoiceLabel(
  displayCurrency: string | null,
  totals: CurrencyTotals | null,
): string {
  if (displayCurrency) {
    return `Workspace: converted to ${displayCurrency} (≈)`;
  }
  const largest = totals?.[0]?.currency;
  return largest
    ? `Workspace: per currency, the largest (now ${largest})`
    : "Workspace: per currency, the largest";
}

/** What a tile saves for its choice. */
export function tileCurrencyFields(
  metric: { unit: string },
  choice: CurrencyChoice,
): { dimensions: Record<string, string>; displayCurrency: string | null } {
  if (!needsCurrency(metric) || choice.kind === "workspace") {
    return { dimensions: {}, displayCurrency: null };
  }
  return choice.kind === "only"
    ? {
        dimensions: { [CURRENCY_DIMENSION]: choice.currency },
        displayCurrency: null,
      }
    : { dimensions: {}, displayCurrency: choice.currency };
}

/**
 * A saved tile's currency for its summary in the editor: "USD" for one
 * currency, "≈ EUR" converted, null when it follows the workspace.
 */
export function tileCurrencySummary(tile: {
  dimensions: Record<string, string>;
  displayCurrency: string | null;
}): string | null {
  const only = tile.dimensions[CURRENCY_DIMENSION];
  if (only) {
    return only;
  }
  return tile.displayCurrency ? `≈ ${tile.displayCurrency}` : null;
}

/**
 * The note under a converted value: what it is, where the rates come from,
 * and what could not be converted (shown apart, never dropped).
 */
export function conversionNote(
  conversion: CurrencyConversion,
  locale: Locale,
): {
  text: string;
  title: string;
  unconverted: string[];
} {
  return {
    text: `≈ ${conversion.displayCurrency}, ${shortSource(conversion)}`,
    title:
      "Converted with the ECB reference rate of each day (the last published one on weekends and holidays). Apple's own reports use different rates.",
    unconverted: conversion.unconverted
      .filter((entry) => entry.value !== null)
      .map((entry) =>
        webTranslator(locale, "formats.metric")("notConverted", {
          amount: formatValue(entry.value, `${entry.currency}_minor`, locale),
        }),
      ),
  };
}

function shortSource(conversion: CurrencyConversion): string {
  return conversion.source.name.startsWith("ECB")
    ? "ECB reference rates"
    : conversion.source.name;
}
