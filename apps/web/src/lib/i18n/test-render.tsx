import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Locale } from "@netrics/domain";

import { ViewerTimeZoneProvider } from "../viewer-time-zone";

import { WEB_CATALOGS } from "./catalogs";
import { I18nProvider } from "./client";

/**
 * For tests: a component's static markup under an I18nProvider in the
 * given language, as the root layout provides it. Clocks show
 * `viewerTimeZone` (the viewer's zone, #736; UTC unless given), whatever
 * the machine's zone is.
 */
export function renderI18n(
  ui: ReactNode,
  locale: Locale = "en",
  viewerTimeZone = "UTC",
): string {
  return renderToStaticMarkup(
    <I18nProvider locale={locale} messages={WEB_CATALOGS[locale]}>
      <ViewerTimeZoneProvider zone={viewerTimeZone}>
        {ui}
      </ViewerTimeZoneProvider>
    </I18nProvider>,
  );
}
