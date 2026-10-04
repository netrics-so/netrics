import { createTranslator, type Catalog, type Translator } from "../catalog.js";
import type { Locale } from "../locale.js";
import type { MessageKey } from "../catalog.js";
import type { Aggregation, Period } from "../../metrics.js";

import { sharedDe } from "./de.js";
import { sharedEn, type SharedMessages } from "./en.js";

export { sharedEn, sharedDe, type SharedMessages };

/** The shared catalogs by locale (ADR 0016 section 4). */
export const SHARED_CATALOGS: Readonly<
  Record<Locale, Catalog<SharedMessages>>
> = {
  en: sharedEn,
  de: sharedDe,
};

const translators = new Map<Locale, Translator<MessageKey<SharedMessages>>>();

/** A translator for the shared catalog, one per locale. */
export function sharedTranslator(
  locale: Locale,
): Translator<MessageKey<SharedMessages>> {
  let translator = translators.get(locale);
  if (!translator) {
    translator = createTranslator<SharedMessages>({
      locale,
      messages: SHARED_CATALOGS[locale],
      fallback: sharedEn,
    });
    translators.set(locale, translator);
  }
  return translator;
}

/** "Last 30 days", "Letzte 30 Tage". */
export function periodLabel(period: Period, locale: Locale = "en"): string {
  return sharedTranslator(locale)(`periods.${period}`);
}

/** What a change is measured against: "vs previous 30 days". */
export function comparisonLabel(period: Period, locale: Locale = "en"): string {
  return sharedTranslator(locale)(`comparisons.${period}`);
}

/**
 * An aggregation's name. A daily gauge (click-through rate, average
 * position) is one reading per day, so its latest, lowest or highest value
 * is a day's ("Latest day"), never a sum over the period.
 */
export function aggregationName(
  aggregation: Aggregation,
  metric: { kind: string; granularity: string } | null = null,
  locale: Locale = "en",
): string {
  const t = sharedTranslator(locale);
  if (
    metric?.kind === "gauge" &&
    metric.granularity === "day" &&
    (aggregation === "last" || aggregation === "min" || aggregation === "max")
  ) {
    return t(`dailyAggregations.${aggregation}`);
  }
  return t(`aggregations.${aggregation}`);
}

/** A breakdown's remainder: "Others", "Andere". */
export function othersLabel(locale: Locale = "en"): string {
  return sharedTranslator(locale)("others");
}
