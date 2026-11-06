"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the page's server components on an interval while the tab is
 * visible, so connection health (stale markers) and, on a TV, the
 * dashboard's tiles stay current. Client state (an open editor) is kept.
 */
export function useServerRefresh(intervalMs = 60_000): void {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
}
