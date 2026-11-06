// Names of built-in themes and of copies of them (#216); names are unique
// per workspace regardless of case.

import type { BuiltinThemeKey, Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

/**
 * A built-in theme's name in the viewer's language, by its stable key
 * (ADR 0016 section 5); the API's English name is not shown.
 */
export function builtinThemeName(key: BuiltinThemeKey, locale: Locale): string {
  return webTranslator(locale, "themes.builtinNames")(key);
}

/**
 * "Copy of Paper", or "Copy of Paper 2" when that name is taken; in the
 * creator's language (the copy is then the workspace's data).
 */
export function copyName(
  baseName: string,
  takenNames: string[],
  locale: Locale,
): string {
  const t = webTranslator(locale, "themes");
  const taken = new Set(takenNames.map((name) => name.toLowerCase()));
  const first = t("copyName", { name: baseName });
  if (!taken.has(first.toLowerCase())) {
    return first;
  }
  for (let n = 2; ; n += 1) {
    const candidate = t("copyNameNumbered", { name: baseName, n: String(n) });
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
}
