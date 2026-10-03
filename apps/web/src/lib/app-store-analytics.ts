/**
 * Copy and small rules of the "App Store analytics" card (ADR 0014, #174):
 * what each per-app status means, whether the one-time Admin step is
 * needed, and the steps for the temporary Admin key. Pure, so the card and
 * its tests share them.
 */

import type { AppStoreAnalyticsAppStatus } from "@netrics/contracts";

/** Where App Store Connect team keys are created and revoked. */
export const APP_STORE_CONNECT_KEYS_URL =
  "https://appstoreconnect.apple.com/access/integrations/api";

export type AnalyticsStatus = AppStoreAnalyticsAppStatus["status"];

/** One line per app status. */
export function analyticsStatusLabel(
  status: AnalyticsStatus,
  latestDay: string | null,
): string {
  switch (status) {
    case "not_enabled":
      return "Not enabled";
    case "stopped":
      return "App Store analytics paused — enable again";
    case "requested":
      return "Requested — data pending (the first reports take 1–2 days)";
    case "available":
      return latestDay ? `Available through ${latestDay}` : "Available";
    case "unknown":
      return "Status unknown right now";
  }
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

/** The guide of the temporary Admin key. */
export const ADMIN_KEY_GUIDE = {
  summary: "How to create the temporary Admin key",
  steps: [
    "Sign in to App Store Connect as the Account Holder or an Admin and open Users and Access → Integrations → App Store Connect API.",
    "Under Team Keys, generate a key named “netrics analytics (temporary)” with the Admin role. Download the .p8 file and copy its Key ID.",
    "Upload it below. netrics uses it once, in memory, to request the analytics reports of this connection's apps. It is not stored, queued or logged.",
    "Revoke the key right afterwards. The Sales key netrics stores keeps reading the reports.",
  ],
  links: [
    {
      step: 0,
      label: "Open App Store Connect API keys",
      url: APP_STORE_CONNECT_KEYS_URL,
    },
  ],
} as const;

/** The key ID of an Admin form's values, for the revocation reminder. */
export function adminKeyIdOf(values: Record<string, string>): string | null {
  const keyId = (values.keyId ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(keyId) ? keyId : null;
}
