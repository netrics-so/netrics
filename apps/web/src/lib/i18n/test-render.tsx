import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Locale } from "@netrics/domain";

import { WEB_CATALOGS } from "./catalogs";
import { I18nProvider } from "./client";

/**
 * For tests: a component's static markup under an I18nProvider in the
 * given language, as the root layout provides it.
 */
export function renderI18n(ui: ReactNode, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={WEB_CATALOGS[locale]}>
      {ui}
    </I18nProvider>,
  );
}
