import type { Device, DevicePlatform } from "@netrics/contracts";

// The device platform in the web app (#406, ADR 0021).

/**
 * A pairing code once it is complete: upper case without spaces and dashes,
 * eight characters, as the server compares it; null before.
 */
export function completePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z0-9]{8}$/.test(code) ? code : null;
}

/**
 * iPads and iPhones know their orientation: the rotation setting applies
 * to Apple TVs and browser kiosks (and devices that report no platform).
 */
export function hasRotationSetting(platform: DevicePlatform | null): boolean {
  return platform !== "ios" && platform !== "ipados";
}

/**
 * Phones and tablets are not expected to be on all the time: the screens
 * list says when they were last opened instead of flagging them offline.
 */
export function isHandheld(platform: Device["platform"]): boolean {
  return platform === "ios" || platform === "ipados";
}
