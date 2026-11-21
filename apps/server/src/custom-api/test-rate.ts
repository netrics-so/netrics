// The custom API builder's test requests (milestone 13, #806, #828).
//
// Rate: at most 30 per workspace per minute in a fixed window, counted in
// the database (custom_api_test_rate, migration 0087) so the limit holds
// across API replicas. One atomic upsert per test: concurrent requests
// serialize on the workspace's row. The window is read on the database's
// clock, so replicas with skewed clocks share one window.
//
// Lease: one running test per draft, across API replicas, held in the
// draft's connection_state.custom_api_test_until (migration 0090).

import { sql } from "drizzle-orm";

import type { Transaction } from "@netrics/database";

import { CUSTOM_API_TEST_LIMITS } from "./preview.js";

export const CUSTOM_API_TEST_RATE = {
  perMinute: 30,
  windowSeconds: 60,
} as const;

/**
 * How long a test holds its draft: the test's own time limit plus room for
 * the token request and the answer. A process that dies mid-test leaves a
 * lease that expires after this.
 */
export const CUSTOM_API_TEST_LEASE_SECONDS =
  CUSTOM_API_TEST_LIMITS.totalMs / 1000 + 60;

/**
 * One atomic upsert on custom_api_test_rate (fixed window per workspace, on
 * the database clock): a window older than 60 s restarts at 1, otherwise
 * count + 1. Over 30 → not ok with the seconds until the window ends (≥ 1).
 */
export async function takeCustomApiTestSlot(
  tx: Transaction,
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const window = `${CUSTOM_API_TEST_RATE.windowSeconds} seconds`;
  const [row] = await tx.execute<{ count: number; retry_after: number }>(
    sql`insert into custom_api_test_rate as rate (workspace_id, window_start, count)
        values (${workspaceId}, now(), 1)
        on conflict (workspace_id) do update set
          window_start = case
            when rate.window_start <= now() - ${window}::interval
            then now() else rate.window_start end,
          count = case
            when rate.window_start <= now() - ${window}::interval
            then 1 else rate.count + 1 end
        where rate.workspace_id = ${workspaceId}
        returning rate.count,
          ceil(extract(epoch from
            rate.window_start + ${window}::interval - now()))::integer
            as retry_after`,
  );
  if (!row || row.count <= CUSTOM_API_TEST_RATE.perMinute) return { ok: true };
  return {
    ok: false,
    retryAfterSeconds: Math.min(
      CUSTOM_API_TEST_RATE.windowSeconds,
      Math.max(1, Number(row.retry_after)),
    ),
  };
}

/**
 * Takes the draft's test lease when no test of it runs (none, or an
 * expired lease). False while another test of the draft runs, in this
 * process or another.
 */
export async function takeCustomApiTestLease(
  tx: Transaction,
  workspaceId: string,
  draftId: string,
): Promise<boolean> {
  const lease = `${CUSTOM_API_TEST_LEASE_SECONDS} seconds`;
  const rows = await tx.execute(
    sql`update connection_state
        set custom_api_test_until = now() + ${lease}::interval
        where workspace_id = ${workspaceId}
          and connection_id = ${draftId}
          and (custom_api_test_until is null
            or custom_api_test_until <= now())
        returning connection_id`,
  );
  return rows.length === 1;
}

/** Ends the draft's test lease. */
export async function releaseCustomApiTestLease(
  tx: Transaction,
  workspaceId: string,
  draftId: string,
): Promise<void> {
  await tx.execute(
    sql`update connection_state set custom_api_test_until = null
        where workspace_id = ${workspaceId} and connection_id = ${draftId}`,
  );
}
