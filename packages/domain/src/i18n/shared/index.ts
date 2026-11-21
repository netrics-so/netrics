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

/**
 * A latest-items widget's label (#810): its title, else "Latest items".
 */
export function itemsWidgetLabel(
  title: string | null,
  locale: Locale = "en",
): string {
  const trimmed = title?.trim() ?? "";
  return trimmed !== "" ? trimmed : sharedTranslator(locale)("latestItems");
}

/**
 * The text an older screen shows in place of a latest-items widget (#810):
 * "Update netrics TV to show the latest items."
 */
export function itemsNeedNewerAppText(locale: Locale = "en"): string {
  return sharedTranslator(locale)("itemsNeedNewerApp");
}

/**
 * The reason codes the server records next to a provider message (#795),
 * and the shared catalog entry each one reads. A code is stable: the
 * English wording may change without breaking a translation, and a code
 * is never renamed or reused for another reason once rows carry it.
 */
export const PROVIDER_MESSAGE_CODES = {
  "apple_ads.invalid_client": "providerMessages.appleAds.invalidClient",
  "apple_ads.unauthorized": "providerMessages.appleAds.unauthorized",
  "apple_ads.forbidden": "providerMessages.appleAds.forbidden",
  "app_store_connect.unauthorized":
    "providerMessages.appStoreConnect.unauthorized",
  "app_store_connect.forbidden": "providerMessages.appStoreConnect.forbidden",
  "app_store_connect.key_mismatch":
    "providerMessages.appStoreConnect.keyMismatch",
  "app_store_connect.role_missing":
    "providerMessages.appStoreConnect.roleMissing",
  "app_store_connect.agreements_missing":
    "providerMessages.appStoreConnect.agreementsMissing",
} as const satisfies Readonly<Record<string, MessageKey<SharedMessages>>>;

export type ProviderMessageCode = keyof typeof PROVIDER_MESSAGE_CODES;

/**
 * The text of a recorded reason code in `locale` (#795); null for a code
 * this build does not know (a community connector's, or a newer server's),
 * for which clients show the recorded message.
 */
export function providerMessageForCode(
  code: string | null | undefined,
  locale: Locale = "en",
): string | null {
  if (!code || !Object.hasOwn(PROVIDER_MESSAGE_CODES, code)) {
    return null;
  }
  return sharedTranslator(locale)(
    PROVIDER_MESSAGE_CODES[code as ProviderMessageCode],
  );
}

/**
 * A recorded provider failure in `locale`: by its reason code (#795), else
 * (rows recorded before codes) by its exact English text; null when
 * neither is known, and clients show the message as it is.
 */
export function localizedProviderFailure(
  failure: { code?: string | null | undefined; message?: string | null },
  locale: Locale = "en",
): string | null {
  return (
    providerMessageForCode(failure.code, locale) ??
    (failure.message ? localizedProviderMessage(failure.message, locale) : null)
  );
}

/**
 * A provider message recorded in English before reason codes (#378, #795)
 * in `locale`, found by its exact English text; null for any other text,
 * which clients show as it is (the provider's own words). New rows carry a
 * code: use `localizedProviderFailure`.
 */
export function localizedProviderMessage(
  message: string,
  locale: Locale = "en",
): string | null {
  const text = message.trim();
  for (const [provider, messages] of Object.entries(
    sharedEn.providerMessages,
  )) {
    for (const [code, english] of Object.entries(messages)) {
      if (english === text) {
        return sharedTranslator(locale)(
          `providerMessages.${provider}.${code}` as MessageKey<SharedMessages>,
        );
      }
    }
  }
  return null;
}
