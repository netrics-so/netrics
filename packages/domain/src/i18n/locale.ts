/**
 * Languages netrics speaks (ADR 0016). Adding one means a catalog file per
 * catalog and an entry here; stored settings are not constrained to this
 * list, so a removed language falls back instead of breaking rows.
 */
export const SUPPORTED_LOCALES = ["en", "de"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** The last resort of every resolution chain. */
export const DEFAULT_LOCALE: Locale = "en";

/** Each language named in itself, for language pickers. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  de: "Deutsch",
};

export function isLocale(value: unknown): value is Locale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * The supported locale a language tag asks for, by its primary language
 * subtag ("de-AT" → "de", "EN" → "en"); null when there is none.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) {
    return null;
  }
  const language = tag.trim().split(/[-_]/)[0]?.toLowerCase();
  return isLocale(language) ? language : null;
}

/**
 * The language tags of an Accept-Language header, most preferred first
 * (RFC 9110 §12.5.4). Entries with q=0 and malformed entries are dropped;
 * equal weights keep the header's order.
 */
export function parseAcceptLanguage(
  header: string | null | undefined,
): string[] {
  if (!header) {
    return [];
  }
  const entries: { tag: string; q: number; index: number }[] = [];
  header.split(",").forEach((part, index) => {
    const [rawTag = "", ...params] = part.split(";");
    const tag = rawTag.trim();
    if (!/^(?:[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*|\*)$/.test(tag)) {
      return;
    }
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/i.exec(param);
      if (match?.[1] !== undefined) {
        q = Number(match[1]);
      }
    }
    if (q > 0 && q <= 1) {
      entries.push({ tag, q, index });
    }
  });
  return entries
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((entry) => entry.tag);
}

/** The most preferred supported locale of an Accept-Language header. */
export function localeFromAcceptLanguage(
  header: string | null | undefined,
): Locale | null {
  for (const tag of parseAcceptLanguage(header)) {
    const locale = matchLocale(tag);
    if (locale) {
      return locale;
    }
  }
  return null;
}

/**
 * The first supported locale among the candidates, else English. Callers
 * pass their chain in order (ADR 0016 section 3), e.g. for a signed-in
 * web request: the user's setting, the instance default, the
 * Accept-Language match.
 */
export function resolveLocale(
  candidates: ReadonlyArray<string | null | undefined>,
): Locale {
  for (const candidate of candidates) {
    const locale = matchLocale(candidate);
    if (locale) {
      return locale;
    }
  }
  return DEFAULT_LOCALE;
}
