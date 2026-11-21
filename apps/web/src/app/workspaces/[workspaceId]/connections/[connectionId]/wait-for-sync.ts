// Server and client: whether a connection page waits for a sync (#834).

import type { ConnectionHealth, SyncRun } from "@netrics/contracts";

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
