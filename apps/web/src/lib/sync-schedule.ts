import type { ConnectionAuthState } from "@netrics/contracts";

import { relativeTime } from "./relative-time";

/**
 * When the next scheduled sync runs, in words. The scheduler skips
 * connections whose credentials failed or whose grant needs reconnecting, so
 * their stored due time would be misleading.
 */
export function nextSyncLabel(state: {
  authState: ConnectionAuthState;
  nextDueAt: string | null;
}): string {
  if (state.authState === "needs_reauthorization") {
    return "Paused until reconnected";
  }
  if (state.authState === "auth_failed") {
    return "Paused until the credentials work";
  }
  return relativeTime(state.nextDueAt);
}
