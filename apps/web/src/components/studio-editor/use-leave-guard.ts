"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { useConfirmation, type Question } from "@/components/confirm-dialog";
import { useT } from "@/lib/i18n/client";

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
 * autosave). Leaving by a link in the app asks in the app's own dialog
 * (#798) and follows the link on "Leave"; a reload or closing the tab can
 * only be asked by the browser (beforeunload). Render the returned dialog.
 */
export function useLeaveGuard(
  dirty: boolean,
  overrideMessage?: string,
): ReactNode {
  const t = useT("studio.editor");
  const common = useT("common");
  const { ask, dialog } = useConfirmation();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const askRef = useRef<() => Promise<boolean>>(null);
  askRef.current = () => {
    const question: Question = {
      title: overrideMessage ?? t("leaveConfirm"),
      confirm: common("leave"),
      cancel: common("stay"),
      destructive: true,
    };
    return ask(question);
  };

  useEffect(() => {
    // The link whose click was confirmed and is being repeated.
    let confirmed: HTMLAnchorElement | null = null;
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
      if (anchor === confirmed) return;
      if (!leavesPage(anchor, event, window.location)) return;
      event.preventDefault();
      event.stopPropagation();
      void askRef.current?.().then((leave) => {
        if (!leave) return;
        // After the dialog is gone: the same click again, so the link
        // navigates the way it would have (Next's Link on the client).
        setTimeout(() => {
          if (!anchor.isConnected) {
            window.location.assign(anchor.href);
            return;
          }
          confirmed = anchor;
          try {
            anchor.click();
          } finally {
            confirmed = null;
          }
        }, 0);
      });
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    // Capture: runs before Next's Link handler navigates client-side.
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
  return dialog;
}
