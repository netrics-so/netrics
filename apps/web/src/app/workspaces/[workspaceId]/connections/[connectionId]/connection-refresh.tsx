"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import type { ConnectionHealth, SyncRun } from "@netrics/contracts";

const INTERVAL_MS = 5_000;
/** Stops after 10 minutes: a reload shows the state from then on. */
const MAX_REFRESHES = 120;

/**
 * Whether the page waits for a sync it should show by itself (#834): a new
 * connection's first run, a queued or running backfill, or a running run.
 * Not while setup or a login is missing: nothing syncs then.
 */
export function waitsForSync(input: {
  setupPending: boolean;
  loginMissing: boolean;
  health: ConnectionHealth;
  backfill: "idle" | "queued" | "running";
  runs: readonly Pick<SyncRun, "status">[];
}): boolean {
  if (input.setupPending || input.loginMissing) return false;
  return (
    input.health === "pending" ||
    input.backfill !== "idle" ||
    input.runs.some((run) => run.status === "running")
  );
}

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
