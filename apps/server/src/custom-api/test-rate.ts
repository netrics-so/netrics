// The custom API builder's test requests per workspace (milestone 13,
// #806): at most 30 per minute in a fixed window, counted in the database
// (custom_api_test_rate, migration 0087) so the limit holds across API
// replicas. One atomic upsert per test: concurrent requests serialize on
// the workspace's row.

import { sql } from "drizzle-orm";

import type { Transaction } from "@netrics/database";

export const CUSTOM_API_TEST_RATE = {
  perMinute: 30,
  windowSeconds: 60,
} as const;

/**
 * One atomic upsert on custom_api_test_rate (fixed window per workspace): a
 * window older than 60 s restarts at 1, otherwise count + 1. Over 30 → not
 * ok with the seconds until the window ends (≥ 1).
 */
export async function takeCustomApiTestSlot(
  tx: Transaction,
  workspaceId: string,
  now: Date,
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const at = now.toISOString();
  const window = `${CUSTOM_API_TEST_RATE.windowSeconds} seconds`;
  const [row] = await tx.execute<{ window_ms: string; count: number }>(
    sql`insert into custom_api_test_rate as rate (workspace_id, window_start, count)
        values (${workspaceId}, ${at}::timestamptz, 1)
        on conflict (workspace_id) do update set
          window_start = case
            when rate.window_start <= ${at}::timestamptz - ${window}::interval
            then ${at}::timestamptz else rate.window_start end,
          count = case
            when rate.window_start <= ${at}::timestamptz - ${window}::interval
            then 1 else rate.count + 1 end
        where rate.workspace_id = ${workspaceId}
        returning (extract(epoch from rate.window_start) * 1000)::bigint::text
          as window_ms, rate.count`,
  );
  if (!row || row.count <= CUSTOM_API_TEST_RATE.perMinute) return { ok: true };
  const ends =
    Number(row.window_ms) + CUSTOM_API_TEST_RATE.windowSeconds * 1000;
  const seconds = Math.ceil((ends - now.getTime()) / 1000);
  return {
    ok: false,
    retryAfterSeconds: Math.min(
      CUSTOM_API_TEST_RATE.windowSeconds,
      Math.max(1, seconds),
    ),
  };
}
