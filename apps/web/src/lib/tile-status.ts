import type { DeviceTileStatus } from "@netrics/contracts";

import { relativeTime } from "./relative-time";

/**
 * Why a tile's numbers may be out of date, worded the same on the web
 * dashboard, its TV layout and the kiosk (#52, #59).
 */
export const TILE_NOTICES = {
  removed: "Connection removed",
  authFailed: "Connection needs new credentials",
  needsReconnect: "Connection needs to be reconnected",
  outage: "Source unreachable",
  firstSync: "Waiting for the first sync",
} as const;

export function lastSyncNotice(lastSuccessAt: string): string {
  return `Last sync ${relativeTime(lastSuccessAt)}`;
}

/** The notice for a device read-model tile (#57); null when it is fresh. */
export function deviceTileNotice(
  status: DeviceTileStatus,
  updatedAt: string | null,
): string | null {
  switch (status) {
    case "auth_failed":
      return TILE_NOTICES.authFailed;
    case "outage":
      return TILE_NOTICES.outage;
    case "stale":
      return updatedAt ? lastSyncNotice(updatedAt) : TILE_NOTICES.firstSync;
    case "no_data":
    case "ok":
      return null;
  }
}
