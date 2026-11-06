import {
  defaultDisplayMode,
  isDisplayMode,
  sizeClassFor,
  type DisplayMode,
} from "@netrics/domain";

// The dashboard page's display mode (ADR 0017, section 5): scroll view or
// screen view, chosen by the domain's default for a signed-in browser and
// overridden by the viewer's switch, which this browser remembers.

/** Local storage key of the viewer's choice (one per browser). */
export const DISPLAY_MODE_STORAGE_KEY = "netrics.displayMode";

/** The part of `Storage` the choice needs; null when there is none. */
export type ModeStorage = Pick<Storage, "getItem" | "setItem"> | null;

/**
 * The remembered mode, or null. Storage can be missing or throw (a private
 * window, blocked site data); the page then falls back to the default.
 */
export function readDisplayMode(storage: ModeStorage): DisplayMode | null {
  try {
    const value = storage?.getItem(DISPLAY_MODE_STORAGE_KEY) ?? null;
    return isDisplayMode(value) ? value : null;
  } catch {
    return null;
  }
}

/** Remembers the viewer's choice; a storage that throws is ignored. */
export function writeDisplayMode(storage: ModeStorage, mode: DisplayMode) {
  try {
    storage?.setItem(DISPLAY_MODE_STORAGE_KEY, mode);
  } catch {
    // Not remembered; the switch still works for this page.
  }
}

/**
 * The mode a signed-in browser starts in: the remembered choice, else the
 * domain's default (scroll view for compact and regular screens with a
 * coarse pointer, i.e. phones and tablets; screen view on a desktop).
 */
export function initialDisplayMode(screen: {
  stored: DisplayMode | null;
  width: number;
  height: number;
  coarsePointer: boolean;
}): DisplayMode {
  return (
    screen.stored ??
    defaultDisplayMode({
      kind: "browser",
      sizeClass: sizeClassFor(screen.width, screen.height),
      coarsePointer: screen.coarsePointer,
    })
  );
}

/** The browser's local storage, or null where it cannot be reached. */
export function browserStorage(): ModeStorage {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
