"use client";

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

import { usableSize, type ScreenSize } from "./screen-view";

// The real screen for screen view (ADR 0017, sections 7 and 11): the size of
// an element as laid out (ResizeObserver: a window resize, a tablet that
// turns, a monitor rotated by its operating system), the viewport, and
// keeping the screen awake. Platform APIs only; where one is missing the
// renderer keeps its 16:9 default and nothing fails.

function sameSize(a: ScreenSize | null, b: ScreenSize | null): boolean {
  return (
    a === b || (!!a && !!b && a.width === b.width && a.height === b.height)
  );
}

/**
 * The element's layout size in CSS pixels (untransformed, so a kiosk
 * rotated by CSS reports its rotated sides), live; null until measured or
 * when it has no size.
 */
export function useElementSize(
  ref: RefObject<HTMLElement | null>,
): ScreenSize | null {
  const [size, setSize] = useState<ScreenSize | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (next: ScreenSize) => {
      const value = usableSize(next) ? next : null;
      setSize((current) => (sameSize(current, value) ? current : value));
    };
    // Whole pixels at once, before paint; the observer refines them.
    update({ width: element.offsetWidth, height: element.offsetHeight });
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect) update({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** The window's viewport in CSS pixels, live; null before mount. */
export function useViewportSize(): ScreenSize | null {
  const [size, setSize] = useState<ScreenSize | null>(null);
  useEffect(() => {
    const update = () => {
      const next = { width: window.innerWidth, height: window.innerHeight };
      setSize((current) =>
        sameSize(current, next) ? current : usableSize(next) ? next : null,
      );
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
  return size;
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

/**
 * Keeps the screen awake while `active` (Wake Lock API, ADR 0017 section
 * 5), taken again when the page becomes visible (the browser releases it
 * when hidden). Unsupported or refused: ignored.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined") return;
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLockLike })
      .wakeLock;
    if (!wakeLock) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let stopped = false;
    const acquire = () => {
      if (stopped || document.visibilityState !== "visible") return;
      wakeLock
        .request("screen")
        .then((next) => {
          if (stopped) {
            void next.release().catch(() => undefined);
          } else {
            sentinel = next;
          }
        })
        .catch(() => undefined);
    };
    acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}

/** True while `ref`'s element is the full-screen element. */
export function useFullscreen(ref: RefObject<HTMLElement | null>): {
  supported: boolean;
  active: boolean;
  toggle: () => void;
} {
  const [supported, setSupported] = useState(false);
  const [active, setActive] = useState(false);
  useEffect(() => {
    setSupported(
      typeof document !== "undefined" &&
        document.fullscreenEnabled === true &&
        typeof ref.current?.requestFullscreen === "function",
    );
    const onChange = () =>
      setActive(
        ref.current !== null && document.fullscreenElement === ref.current,
      );
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [ref]);
  const toggle = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void ref.current?.requestFullscreen().catch(() => undefined);
    }
  };
  return { supported, active, toggle };
}
