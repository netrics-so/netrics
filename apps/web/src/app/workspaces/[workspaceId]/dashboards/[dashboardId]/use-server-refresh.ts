"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** How long the reachability probe may take before it counts as offline. */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether the web app answers right now: the browser reports a network and
 * `/healthz` (no dependencies, never cached) responds. `navigator.onLine`
 * alone is not enough: it stays true when the network behind the router is
 * down (#681).
 */
export async function webReachable(
  fetcher: typeof fetch = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false)
    return false;
  try {
    const response = await fetcher("/healthz", {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Re-renders the page's server components on an interval while the tab is
 * visible, so connection health (stale markers) and, on a TV, the
 * dashboard's tiles stay current. Client state (an open editor) is kept.
 *
 * Only when the web app answers: a refresh whose server request fails makes
 * Next.js fall back to a full browser navigation, which on a wall screen
 * that lost its network replaces the dashboard with the browser's error
 * page (#681). So each refresh is preceded by a cheap probe, and skipped
 * while it fails; the dashboard stays as it is, with its last data.
 *
 * Returns whether the last probe reached the web app (true until one fails).
 */
export function useServerRefresh(intervalMs = 60_000): boolean {
  const router = useRouter();
  const [reachable, setReachable] = useState(true);
  useEffect(() => {
    let alive = true;
    let running = false;
    const tick = () => {
      if (document.visibilityState !== "visible" || running) return;
      running = true;
      void webReachable()
        .then((ok) => {
          if (!alive) return;
          setReachable(ok);
          if (ok) router.refresh();
        })
        .finally(() => {
          running = false;
        });
    };
    const timer = setInterval(tick, intervalMs);
    // Back on the network: catch up at once instead of within a minute.
    window.addEventListener("online", tick);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("online", tick);
    };
  }, [router, intervalMs]);
  return reachable;
}
