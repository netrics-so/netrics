import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

/**
 * "Vercel limit reached, continuing at 10:40" (#781): the provider's
 * request limit is used up and syncing continues at the reset, in the
 * workspace's time zone (with the day when that is not today). Null when no
 * limit holds at `now`.
 */
export function rateLimitLabel(
  state: { rateLimitedUntil?: string | null },
  connectorName: string,
  locale: Locale,
  timeZone: string,
  now: number = Date.now(),
): string | null {
  const until = state.rateLimitedUntil
    ? Date.parse(state.rateLimitedUntil)
    : NaN;
  if (!Number.isFinite(until) || until <= now) return null;
  const t = webTranslator(locale, "health");
  const zone = safeZone(timeZone, locale);
  const time = new Intl.DateTimeFormat(locale, {
    timeStyle: "short",
    timeZone: zone,
  }).format(until);
  const dayOf = (ms: number) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeZone: zone,
    }).format(ms);
  if (dayOf(until) === dayOf(now)) {
    return t("rateLimited", { connector: connectorName, time });
  }
  const date = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: zone,
  }).format(until);
  return t("rateLimitedDay", { connector: connectorName, date, time });
}

function safeZone(timeZone: string, locale: Locale): string {
  try {
    new Intl.DateTimeFormat(locale, { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}
