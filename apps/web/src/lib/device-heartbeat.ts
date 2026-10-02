import type { Device } from "@netrics/contracts";

import { relativeTime } from "./relative-time";

/** Longer reported errors are cut to this many characters in the TV list. */
export const MAX_ERROR_DISPLAY_LENGTH = 140;

export interface HeartbeatSummary {
  /** "web 0.1.0" for a browser kiosk, "tvOS 0.1.0" for the Apple TV app. */
  version: string;
  /** "2 minutes ago", relative to now. */
  at: string;
  /** The reported error, on one line and shortened; null when none. */
  lastError: string | null;
  /** The whole reported error, for a tooltip; null when none. */
  lastErrorFull: string | null;
}

/**
 * The app version as the TV list shows it (#125). Browser kiosks report
 * "web <version>"; the Apple TV app reports its bare marketing version
 * ("0.1.0", or "tvos" without one), labelled here so the two can be told
 * apart. Anything else is shown as reported.
 */
export function describeAppVersion(appVersion: string): string {
  const version = appVersion.trim();
  if (/^tvos$/i.test(version)) {
    return "tvOS";
  }
  if (/^\d/.test(version)) {
    return `tvOS ${version}`;
  }
  return version;
}

/**
 * A device-reported error made safe to show in one muted line: control
 * characters and runs of whitespace collapse to single spaces, and long
 * values are cut (by code point) with an ellipsis. It is rendered as text.
 */
export function shortenError(
  text: string,
  max: number = MAX_ERROR_DISPLAY_LENGTH,
): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = text.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim();
  const characters = Array.from(oneLine);
  if (characters.length <= max) {
    return oneLine;
  }
  return `${characters
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

export function summarizeHeartbeat(
  heartbeat: Device["heartbeat"],
): HeartbeatSummary | null {
  if (!heartbeat) {
    return null;
  }
  const full = heartbeat.lastError?.trim() ? heartbeat.lastError : null;
  return {
    version: describeAppVersion(heartbeat.appVersion),
    at: relativeTime(heartbeat.at),
    lastError: full === null ? null : shortenError(full),
    lastErrorFull: full,
  };
}
