"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { Catalog, Locale } from "@netrics/domain";

import {
  WEB_CATALOGS,
  webTranslator,
  type WebMessages,
  type WebNamespace,
  type WebTranslator,
} from "./catalogs";

interface I18nContextValue {
  locale: Locale;
  messages: Catalog<WebMessages>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Gives client components the request's language and catalog; the root
 * layout fills it (ADR 0016 section 4).
 */
export function I18nProvider({
  locale,
  messages,
  children,
}: I18nContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * English when there is no provider above: the root layout always gives
 * one, so this only applies to components rendered on their own (unit
 * tests of shared widgets).
 */
const ENGLISH: I18nContextValue = { locale: "en", messages: WEB_CATALOGS.en };

function useI18n(): I18nContextValue {
  return useContext(I18nContext) ?? ENGLISH;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

/** A translator for client components: `const t = useT("account")`. */
export function useT<N extends WebNamespace>(namespace: N): WebTranslator<N> {
  const { locale, messages } = useI18n();
  return useMemo(
    () => webTranslator(locale, namespace, messages),
    [locale, namespace, messages],
  );
}
