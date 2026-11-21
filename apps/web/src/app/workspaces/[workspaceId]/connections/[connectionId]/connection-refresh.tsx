"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const INTERVAL_MS = 5_000;
/** Stops after 10 minutes: a reload shows the state from then on. */
const MAX_REFRESHES = 120;

/** Refreshes the connection page every 5 s while it waits for a sync. */
export function ConnectionRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    let count = 0;
    const timer = window.setInterval(() => {
      count += 1;
      if (count > MAX_REFRESHES) {
        window.clearInterval(timer);
        return;
      }
      if (document.visibilityState === "visible") router.refresh();
    }, INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [active, router]);
  return null;
}
