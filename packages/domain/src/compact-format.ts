/**
 * Compact numbers in the viewer's language (ADR 0016, section 8): the
 * dashboard's full form from 10,000 ("12.9K", "12,9 Tsd.", "€4.2M",
 * "4,2 Mio. €") and the narrow-widget form ("12.3K", "12,3K"). The web
 * formats with these, and the tvOS app (NetricsKit MetricFormat) runs the
 * same rules against packages/domain/test-vectors/compact-numbers.json, so
 * a change here needs `pnpm vectors:compact` and a port to Swift.
 */
import type { Locale } from "./i18n/locale.js";
import { compactNumber } from "./studio-layout.js";

/**
 * Compact suffixes for languages whose `Intl` short compact notation does
 * not abbreviate thousands (German CLDR writes 12.900, not 12,9 Tsd.).
 * Languages not listed use `Intl` as it is.
 */
export const COMPACT_SUFFIXES_BY_LOCALE: Readonly<
  Partial<Record<Locale, readonly string[]>>
> = {
  de: ["", "Tsd.", "Mio.", "Mrd.", "Bio."],
};

/**
 * `value` with the language's own suffixes and one decimal at most
 * ("12,9 Tsd.", "4,2 Mio. $"), or null when the language's `Intl` compact
 * notation is used as it is.
 */
function suffixCompact(
  value: number,
  locale: Locale,
  currency?: string,
): string | null {
  const suffixes = COMPACT_SUFFIXES_BY_LOCALE[locale];
  if (!suffixes) {
    return null;
  }
  const magnitude = Math.abs(value);
  let tier = 0;
  while (tier < suffixes.length - 1 && magnitude >= 1000 ** (tier + 1)) {
    tier += 1;
  }
  // Tenths of the tier, rounded half away from zero (as Intl does), from
  // the magnitude so that negatives round like positives.
  let tenths = Math.round((magnitude * 10) / 1000 ** tier);
  // 999,950 rounds to 1000 thousand: one million.
  if (tenths >= 10_000 && tier < suffixes.length - 1) {
    tier += 1;
    tenths = Math.round((magnitude * 10) / 1000 ** tier);
  }
  const scaled = ((value < 0 ? -1 : 1) * tenths) / 10;
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

/**
 * The full compact form of a value, as tiles show values from 10,000:
 * one decimal at most, rounded half away from zero ("12.9K", "€4.2M";
 * German "12,9 Tsd.", "4,2 Mio. €"). `currency` is an ISO 4217 code for an
 * amount in the major unit.
 */
export function localeCompactNumber(
  value: number,
  locale: Locale,
  currency?: string,
): string {
  const local = suffixCompact(value, locale, currency);
  if (local !== null) {
    return local;
  }
  return new Intl.NumberFormat(locale, {
    ...(currency ? { style: "currency", currency } : {}),
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * The narrow-widget form (ADR 0015, section 8): the shared compactNumber
 * ("12.3K") with the language's decimal separator ("12,3K" in German); the
 * suffixes stay, so the width the layout measured is the same. An amount
 * (`currency` set, major unit) takes the full compact form at any size
 * ("€1.2K", "1,2 Tsd. €"): German `Intl` would write 12.345,5 €.
 */
export function narrowCompactNumber(
  value: number,
  locale: Locale,
  currency?: string,
): string {
  if (currency) {
    return localeCompactNumber(value, locale, currency);
  }
  const text = compactNumber(value);
  const decimal =
    new Intl.NumberFormat(locale)
      .formatToParts(1.5)
      .find((part) => part.type === "decimal")?.value ?? ".";
  return decimal === "." ? text : text.replace(".", decimal);
}
