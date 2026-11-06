import {
  isLocale,
  localeFromAcceptLanguage,
  resolveLocale,
  type Locale,
} from "@netrics/domain";

let warned = false;

/**
 * NETRICS_DEFAULT_LOCALE, read at request time (ADR 0013, 0016): the
 * instance default language, else null. The API refuses to start with an
 * unsupported value; the web app must render anyway, so it warns once and
 * ignores it.
 */
export function instanceDefaultLocale(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Locale | null {
  const value = env.NETRICS_DEFAULT_LOCALE?.trim();
  if (!value) {
    return null;
  }
  if (!isLocale(value)) {
    if (!warned) {
      warned = true;
      console.warn(
        `NETRICS_DEFAULT_LOCALE=${JSON.stringify(value)} is not a supported language; using English.`,
      );
    }
    return null;
  }
  return value;
}

/**
 * The language of a web request (ADR 0016 section 3): the signed-in user's
 * setting, the instance default, the browser's Accept-Language, English.
 */
export function requestLocale(input: {
  userLocale: string | null | undefined;
  instanceDefault: Locale | null;
  acceptLanguage: string | null | undefined;
}): Locale {
  return resolveLocale([
    input.userLocale,
    input.instanceDefault,
    localeFromAcceptLanguage(input.acceptLanguage),
  ]);
}
