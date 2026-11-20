import { sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";

/**
 * How long a custom API builder's draft connection lives after it was last
 * touched (milestone 13, #806). Every draft service call refreshes it.
 */
export const DRAFT_CONNECTION_TTL_HOURS = 24;

/**
 * Deletes draft connections untouched for `hours` as of `now`, with their
 * connection_state (scheduler role; prune_draft_connections is SECURITY
 * DEFINER, migration 0087). Only rows still `status = 'draft'` in the same
 * DELETE go, so a promoted connection is never deleted. A count equal to
 * `batch` means more remain.
 */
export async function pruneDraftConnections(
  schedulerDb: Db | Transaction,
  now: Date,
  hours: number = DRAFT_CONNECTION_TTL_HOURS,
  batch = 1_000,
): Promise<number> {
  const [row] = await schedulerDb.execute<{ deleted: number }>(
    sql`select prune_draft_connections(
          ${now.toISOString()}::timestamptz,
          make_interval(hours => ${hours}),
          ${batch}
        ) as deleted`,
  );
  return row?.deleted ?? 0;
}

/**
 * Queues one `custom_api.draft_expired` job per draft untouched for `hours`
 * that holds an OAuth grant (scheduler role; enqueue_expired_draft_grants
 * is SECURITY DEFINER, migration 0089). The worker revokes the grant at the
 * provider and then deletes the draft; pruneDraftConnections skips such
 * drafts until they are twice as old. Returns the number of jobs queued.
 */
export async function enqueueExpiredDraftGrants(
  schedulerDb: Db | Transaction,
  now: Date,
  hours: number = DRAFT_CONNECTION_TTL_HOURS,
  batch = 1_000,
): Promise<number> {
  const [row] = await schedulerDb.execute<{ queued: number }>(
    sql`select enqueue_expired_draft_grants(
          ${now.toISOString()}::timestamptz,
          make_interval(hours => ${hours}),
          ${batch}
        ) as queued`,
  );
  return row?.queued ?? 0;
}
