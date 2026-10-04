import { createTranslator, type Catalog, type Translator } from "../catalog.js";
import type { Locale } from "../locale.js";
import type { MessageKey } from "../catalog.js";
import type { Aggregation, Period } from "../../metrics.js";
import type { CountdownUnit } from "../../studio-layout.js";

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

/** A goal widget's label without a title or goal: "Goal", "Ziel". */
export function goalLabel(locale: Locale = "en"): string {
  return sharedTranslator(locale)("goal");
}

/** A breakdown's remainder: "Others", "Andere". */
export function othersLabel(locale: Locale = "en"): string {
  return sharedTranslator(locale)("others");
}

/** A status board's label without a title: "Sources", "Quellen". */
export function sourcesLabel(locale: Locale = "en"): string {
  return sharedTranslator(locale)("sources");
}

/** A countdown's label (ADR 0019 section 8): its title, else "Countdown". */
export function countdownLabel(
  title: string | null,
  locale: Locale = "en",
): string {
  const trimmed = title?.trim() ?? "";
  return trimmed !== "" ? trimmed : sharedTranslator(locale)("countdown.label");
}

/** What a countdown shows at its target: its own text, else "Now"/"Jetzt". */
export function countdownDoneText(
  doneText: string | null,
  locale: Locale = "en",
): string {
  const trimmed = doneText?.trim() ?? "";
  return trimmed !== "" ? trimmed : sharedTranslator(locale)("countdown.done");
}

/** The unit letters after a countdown's numbers: d/h/m, T/Std/Min. */
export function countdownUnits(
  locale: Locale = "en",
): Readonly<Record<CountdownUnit, string>> {
  const t = sharedTranslator(locale);
  return {
    d: t("countdown.units.d"),
    h: t("countdown.units.h"),
    m: t("countdown.units.m"),
  };
}

/**
 * A latest-review widget's label (ADR 0019 section 12): its title, else
 * "Latest review", and the app's name when it shows one app
 * ("Latest review · Wurfel").
 */
export function reviewWidgetLabel(
  input: { title: string | null; resourceName: string | null },
  locale: Locale = "en",
): string {
  const title = input.title ?? sharedTranslator(locale)("latestReview");
  return input.resourceName ? `${title} · ${input.resourceName}` : title;
}
