"use client";

import { useEffect, useState } from "react";

import {
  CHECK_INTERVAL_MS,
  NOTICE_DELAY_MS,
  createDeployWatcher,
  healthCommit,
  isBuildAssetUrl,
  isChunkLoadError,
  isKioskPath,
  isRealCommit,
} from "@/lib/deploy-skew";

// Inlined at build time: the commit this bundle was built from.
const BUNDLE_COMMIT = process.env.NEXT_PUBLIC_GIT_SHA ?? "";

type Notice = null | "reloading" | "on-navigation";

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function fetchServerCommit(): Promise<string | null> {
  try {
    const response = await fetch("/healthz", {
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) {
      return null;
    }
    return healthCommit(await response.json());
  } catch {
    return null;
  }
}

function isEditable(element: Element | null): boolean {
  if (!element) {
    return false;
  }
  if (element instanceof HTMLTextAreaElement) {
    return !element.readOnly && !element.disabled;
  }
  if (element instanceof HTMLInputElement) {
    return (
      !element.readOnly &&
      !element.disabled &&
      !["button", "submit", "reset", "hidden", "image"].includes(element.type)
    );
  }
  if (element instanceof HTMLSelectElement) {
    return !element.disabled;
  }
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * Reloads the page once when a new deployment has replaced its build (#200);
 * lib/deploy-skew has the rules. Mounted once in the root layout.
 */
export function DeployWatcher() {
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    if (!isRealCommit(BUNDLE_COMMIT)) {
      return; // `next dev` and unconfigured builds: nothing to compare.
    }

    // Input typed since the page loaded or the last submit: a reload would
    // lose it, so the app waits for the next navigation instead.
    let typed = false;
    const onInput = (event: Event) => {
      if (isEditable(event.target as Element | null)) {
        typed = true;
      }
    };
    const onSubmit = () => {
      typed = false;
    };
    const isEditing = () => typed || isEditable(document.activeElement);

    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    let navigationArmed = false;

    // The next same-origin link becomes a full page load (onto the new
    // build); so does history navigation.
    const onLinkClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target) {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || anchor.download) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(url.href);
    };
    const onPopState = () => window.location.reload();

    const deferToNavigation = () => {
      setNotice("on-navigation");
      if (navigationArmed) {
        return;
      }
      navigationArmed = true;
      document.addEventListener("click", onLinkClick, true);
      window.addEventListener("popstate", onPopState);
    };

    const watcher = createDeployWatcher({
      bundleCommit: BUNDLE_COMMIT,
      fetchServerCommit,
      storage: sessionStore(),
      now: () => Date.now(),
      isKiosk: () => isKioskPath(window.location.pathname),
      isEditing,
      reload: () => window.location.reload(),
      reloadWithNotice: () => {
        setNotice("reloading");
        reloadTimer = setTimeout(() => {
          // Someone started typing during the notice: wait for them.
          if (isEditing()) {
            deferToNavigation();
          } else {
            window.location.reload();
          }
        }, NOTICE_DELAY_MS);
      },
      deferToNavigation,
    });

    const onError = (event: Event) => {
      const target = event.target;
      const url =
        target instanceof HTMLScriptElement
          ? target.src
          : target instanceof HTMLLinkElement
            ? target.href
            : null;
      if (url && isBuildAssetUrl(url, window.location.origin)) {
        void watcher.check();
      } else if (
        event instanceof ErrorEvent &&
        isChunkLoadError(event.error ?? event.message)
      ) {
        void watcher.check();
      }
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isChunkLoadError(event.reason)) {
        void watcher.check();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void watcher.maybeCheck();
      }
    };

    // Capture: resource load errors do not bubble.
    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("input", onInput, true);
    document.addEventListener("submit", onSubmit, true);
    const interval = setInterval(() => {
      void watcher.maybeCheck();
    }, CHECK_INTERVAL_MS);

    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("input", onInput, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("click", onLinkClick, true);
      window.removeEventListener("popstate", onPopState);
      clearInterval(interval);
      clearTimeout(reloadTimer);
    };
  }, []);

  if (!notice) {
    return null;
  }
  return (
    <div className="deploy-notice" role="status" aria-live="polite">
      {notice === "reloading"
        ? "netrics was updated — reloading…"
        : "netrics was updated — the page reloads when you move on."}
    </div>
  );
}
