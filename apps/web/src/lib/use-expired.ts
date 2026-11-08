"use client";

import { useEffect, useState } from "react";

/**
 * Whether a retention deadline has passed, re-checked when it arrives: a
 * screen keeps showing its last payload while offline, and values over
 * retained data must disappear at their deadline all the same (#539). No
 * deadline never expires; an unreadable one counts as passed.
 */
export function useExpired(expiresAt: string | null | undefined): boolean {
  const deadline = expiresAt ? Date.parse(expiresAt) : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null || Number.isNaN(deadline)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      if (now < deadline) setNow(Date.now());
      return;
    }
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining + 1, 86_400_000),
    );
    return () => clearTimeout(timer);
  }, [deadline, now]);
  if (deadline === null) return false;
  return Number.isNaN(deadline) || deadline <= now;
}
