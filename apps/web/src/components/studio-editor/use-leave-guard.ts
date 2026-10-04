"use client";

import { useEffect, useRef } from "react";

export const LEAVE_MESSAGE =
  "This dashboard has unsaved changes. Leave and lose them?";

/**
 * Whether a click on `anchor` leaves the page in this tab: same-origin
 * links to another page (not a new tab, a download or an in-page anchor).
 */
export function leavesPage(
  anchor: { href: string; target: string; hasAttribute(name: string): boolean },
  event: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  location: { href: string; origin: string },
): boolean {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    (anchor.target && anchor.target !== "_self") ||
    anchor.hasAttribute("download")
  ) {
    return false;
  }
  const url = new URL(anchor.href, location.href);
  const here = new URL(location.href);
  if (url.origin !== location.origin) {
    // Another site still unloads this page; beforeunload asks then.
    return false;
  }
  return url.pathname !== here.pathname || url.search !== here.search;
}

/**
 * Asks before unsaved changes are lost (ADR 0015: explicit Save, no
 * autosave): on reload, closing the tab and leaving by a link in the app.
 */
export function useLeaveGuard(dirty: boolean) {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    function onClick(event: MouseEvent) {
      if (!dirtyRef.current || event.defaultPrevented) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!leavesPage(anchor, event, window.location)) return;
      if (!window.confirm(LEAVE_MESSAGE)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    // Capture: runs before Next's Link handler navigates client-side.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
}
