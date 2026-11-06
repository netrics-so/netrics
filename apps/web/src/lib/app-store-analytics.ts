/**
 * Copy and small rules of the "App Store analytics" card (ADR 0014, #174):
 * what each per-app status means, whether the one-time Admin step is
 * needed, and the steps for the temporary Admin key. Pure, so the card and
 * its tests share them.
 */

import type { AppStoreAnalyticsAppStatus } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";

/** Where App Store Connect team keys are created and revoked. */
export const APP_STORE_CONNECT_KEYS_URL =
  "https://appstoreconnect.apple.com/access/integrations/api";

export type AnalyticsStatus = AppStoreAnalyticsAppStatus["status"];

/** One line per app status. */
export function analyticsStatusLabel(
  status: AnalyticsStatus,
  latestDay: string | null,
  locale: Locale,
): string {
  const t = webTranslator(locale, "connections.appStoreAnalytics.status");
  if (status === "available" && latestDay) {
    return t("availableThrough", {
      day: formatReportingDay(latestDay, locale),
    });
  }
  return t(status);
}

/** A reporting day (YYYY-MM-DD) as a date in the user's language. */
export function formatReportingDay(day: string, locale: Locale): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(time)
    ? day
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(time);
}

/** Whether some app needs the one-time Admin step (never or no longer requested). */
export function needsEnablement(
  apps: readonly Pick<AppStoreAnalyticsAppStatus, "status">[],
): boolean {
  return apps.some(
    (app) => app.status === "not_enabled" || app.status === "stopped",
  );
}

/** Apps whose request Apple stopped: shown as paused. */
export function pausedApps<
  T extends Pick<AppStoreAnalyticsAppStatus, "status">,
>(apps: readonly T[]): T[] {
  return apps.filter((app) => app.status === "stopped");
}

/** A setup guide shown above a key form: summary, steps and links. */
export interface KeyGuide {
  summary: string;
  steps: readonly string[];
  links: readonly { step: number; label: string; url: string }[];
}

/** The guide of the temporary Admin key. */
export function adminKeyGuide(locale: Locale): KeyGuide {
  const t = webTranslator(locale, "connections.appStoreAnalytics.guide");
  return {
    summary: t("summary"),
    steps: [t("step1"), t("step2"), t("step3"), t("step4")],
    links: [
      {
        step: 0,
        label: webTranslator(locale, "connections.signedKey")("openKeys"),
        url: APP_STORE_CONNECT_KEYS_URL,
      },
    ],
  };
}

/** The key ID of an Admin form's values, for the revocation reminder. */
export function adminKeyIdOf(values: Record<string, string>): string | null {
  const keyId = (values.keyId ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(keyId) ? keyId : null;
}
