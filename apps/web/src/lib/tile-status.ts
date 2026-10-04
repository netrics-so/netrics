import type { ConnectionStateView, DeviceTileStatus } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

import { webTranslator } from "./i18n/catalogs";
import { relativeTime, relativeTimeIn } from "./relative-time";

/**
 * Why a tile's numbers may be out of date, worded the same on the web
 * dashboard, its TV layout and the kiosk (#52, #59), in English; the
 * functions below take the language (ADR 0016).
 */
export const TILE_NOTICES = {
  removed: "Connection removed",
  authFailed: "Connection needs new credentials",
  needsReconnect: "Connection needs to be reconnected",
  outage: "Source unreachable",
  firstSync: "Waiting for the first sync",
} as const;

type Notice = keyof typeof TILE_NOTICES;

function notice(key: Notice, locale: Locale): string {
  return locale === "en"
    ? TILE_NOTICES[key]
    : webTranslator(locale, "screen.notices")(key);
}

export function lastSyncNotice(
  lastSuccessAt: string,
  locale: Locale = "en",
): string {
  if (locale === "en") {
    return `Last sync ${relativeTime(lastSuccessAt)}`;
  }
  const t = webTranslator(locale, "screen.notices");
  return t("lastSync", {
    time: relativeTimeIn(lastSuccessAt, locale) ?? t("never"),
  });
}

/** The notice for a device read-model tile (#57); null when it is fresh. */
export function deviceTileNotice(
  status: DeviceTileStatus,
  updatedAt: string | null,
  locale: Locale = "en",
): string | null {
  switch (status) {
    case "auth_failed":
      return notice("authFailed", locale);
    case "outage":
      return notice("outage", locale);
    case "stale":
      return updatedAt
        ? lastSyncNotice(updatedAt, locale)
        : notice("firstSync", locale);
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
  locale: Locale = "en",
): string | null {
  if (!connection) {
    return notice("removed", locale);
  }
  const { state } = connection;
  if (state.health === "auth_failed") {
    return notice("authFailed", locale);
  }
  if (state.health === "needs_reauthorization") {
    return notice("needsReconnect", locale);
  }
  if (state.health === "outage") {
    return notice("outage", locale);
  }
  if (!state.lastSuccessAt) {
    return notice("firstSync", locale);
  }
  const age = now - new Date(state.lastSuccessAt).getTime();
  const limit = Math.max(
    STALE_AFTER_INTERVALS * state.pollIntervalSeconds * 1000,
    MIN_STALE_MS,
  );
  return age > limit ? lastSyncNotice(state.lastSuccessAt, locale) : null;
}
