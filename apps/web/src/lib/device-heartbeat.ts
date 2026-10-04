import type { Device } from "@netrics/contracts";
import type { Locale } from "@netrics/domain";

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
 * "web <version>" and the Apple TV app "tvos <version>"; the latter is shown
 * as "tvOS <version>". Anything else is shown as reported.
 */
export function describeAppVersion(appVersion: string): string {
  const version = appVersion.trim();
  const tvos = /^tvos(?=\s|$)/i.exec(version);
  if (tvos) {
    return `tvOS${version.slice(tvos[0].length)}`;
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
  locale: Locale,
): HeartbeatSummary | null {
  if (!heartbeat) {
    return null;
  }
  const full = heartbeat.lastError?.trim() ? heartbeat.lastError : null;
  return {
    version: describeAppVersion(heartbeat.appVersion),
    at: relativeTime(heartbeat.at, locale),
    lastError: full === null ? null : shortenError(full),
    lastErrorFull: full,
  };
}

/**
 * Whether the device is the Apple TV app, by its reported version. It shows
 * Screen view only (ADR 0017 section 7), so the TV list offers no mode.
 */
export function isAppleTv(heartbeat: Device["heartbeat"]): boolean {
  return heartbeat !== null && /^tvos(?=\s|$)/i.test(heartbeat.appVersion);
}

/** The orientation message key of a rotation ("r90"). */
export function rotationKey(
  rotation: Device["rotation"],
): `r${Device["rotation"]}` {
  return `r${rotation}`;
}

export interface ScreenSummary {
  /** Unformatted sides, so a 4K width never reads "3,840" or "3.840". */
  width: string;
  height: string;
  /** "16:9" for the format key "16x9"; null when the device sent none. */
  format: string | null;
  mode: Device["displayMode"];
}

/** The screen a device last reported, ready for the TV list (#276). */
export function summarizeScreen(
  screen: Device["screen"],
): ScreenSummary | null {
  if (!screen) {
    return null;
  }
  return {
    width: String(screen.width),
    height: String(screen.height),
    format: screen.format ? screen.format.replace("x", ":") : null,
    mode: screen.mode,
  };
}
