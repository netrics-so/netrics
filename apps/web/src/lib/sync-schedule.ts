import type { ConnectionAuthState } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import { relativeTime } from "./relative-time";

/**
 * When the next scheduled sync runs, in words. The scheduler skips
 * connections whose credentials failed or whose grant needs reconnecting, so
 * their stored due time would be misleading.
 */
export function nextSyncLabel(
  state: {
    authState: ConnectionAuthState;
    nextDueAt: string | null;
  },
  locale: Locale,
): string {
  const t = webTranslator(locale, "formats.nextSync");
  if (state.authState === "needs_reauthorization") {
    return t("pausedReconnect");
  }
  if (state.authState === "auth_failed") {
    return t("pausedCredentials");
  }
  return relativeTime(state.nextDueAt, locale);
}
