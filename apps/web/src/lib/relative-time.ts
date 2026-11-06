import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now", "5 minutes ago", "in 2 hours" — for sync state timestamps,
 * worded by `Intl.RelativeTimeFormat` in the given language.
 */
export function relativeTime(
  iso: string | null,
  locale: Locale,
  now: number = Date.now(),
): string {
  const t = webTranslator(locale, "formats.time");
  if (!iso) {
    return t("never");
  }
  const deltaSeconds = Math.round((Date.parse(iso) - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  if (absolute < 45) {
    return t("justNow");
  }
  const sign = deltaSeconds > 0 ? 1 : -1;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  if (absolute < HOUR) {
    return format.format(sign * Math.round(absolute / MINUTE), "minute");
  }
  if (absolute < DAY) {
    return format.format(sign * Math.round(absolute / HOUR), "hour");
  }
  return format.format(sign * Math.round(absolute / DAY), "day");
}

/**
 * "5 minutes ago", "vor 5 Minuten", "in 2 hours" with Intl in the given
 * language (ADR 0016 section 8); "now" within 45 seconds. Null without a
 * time (or one that does not parse). `style: "short"` reads "5 min. ago".
 */
export function relativeTimeIn(
  iso: string | null,
  locale: string,
  now: number = Date.now(),
  style: Intl.RelativeTimeFormatStyle = "long",
): string | null {
  if (!iso || Number.isNaN(Date.parse(iso))) {
    return null;
  }
  const deltaSeconds = Math.round((Date.parse(iso) - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const format = new Intl.RelativeTimeFormat(locale, {
    numeric: "auto",
    style,
  });
  if (absolute < 45) {
    return format.format(0, "second");
  }
  const sign = deltaSeconds < 0 ? -1 : 1;
  if (absolute < HOUR) {
    return format.format(sign * Math.round(absolute / MINUTE), "minute");
  }
  if (absolute < DAY) {
    return format.format(sign * Math.round(absolute / HOUR), "hour");
  }
  return format.format(sign * Math.round(absolute / DAY), "day");
}

/** "every 5 minutes", "every 6 hours" — a poll interval in words. */
export function intervalLabel(seconds: number, locale: Locale): string {
  const t = webTranslator(locale, "formats.interval");
  const units = [
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
  ] as const;
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      return t(name, { count: seconds / size });
    }
  }
  return t("second", { count: seconds });
}
