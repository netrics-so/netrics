import type { ConnectionStateView, DeviceTileStatus } from "@netrics/contracts";

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

/**
 * Data older than this many poll intervals (at least 15 minutes) is marked
 * stale: the numbers may no longer reflect the source.
 */
const STALE_AFTER_INTERVALS = 3;
const MIN_STALE_MS = 15 * 60 * 1000;

/**
 * Why a widget's numbers may be out of date, from its connection's sync
 * state (signed-in views); null when they are fresh.
 */
export function connectionNotice(
  connection: { state: ConnectionStateView } | undefined,
  now: number = Date.now(),
): string | null {
  if (!connection) {
    return TILE_NOTICES.removed;
  }
  const { state } = connection;
  if (state.health === "auth_failed") {
    return TILE_NOTICES.authFailed;
  }
  if (state.health === "needs_reauthorization") {
    return TILE_NOTICES.needsReconnect;
  }
  if (state.health === "outage") {
    return TILE_NOTICES.outage;
  }
  if (!state.lastSuccessAt) {
    return TILE_NOTICES.firstSync;
  }
  const age = now - new Date(state.lastSuccessAt).getTime();
  const limit = Math.max(
    STALE_AFTER_INTERVALS * state.pollIntervalSeconds * 1000,
    MIN_STALE_MS,
  );
  return age > limit ? lastSyncNotice(state.lastSuccessAt) : null;
}
