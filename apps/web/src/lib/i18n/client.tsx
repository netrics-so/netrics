"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { Catalog, Locale } from "@netrics/domain";

import {
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

function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (!value) {
    throw new Error("useT and useLocale need an I18nProvider above them");
  }
  return value;
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
