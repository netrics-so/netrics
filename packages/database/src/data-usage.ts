import { sql } from "drizzle-orm";
import type { Transaction } from "./context.js";

/**
 * Retained raw data accounting, independent of disposable execution caches.
 * Superseded generations that no unexpired query snapshot or page session
 * pins, and the raw pages of superseded or no-longer-publishable refreshes,
 * are not counted: no new read can reach them and scheduler maintenance
 * reclaims them (`prune_dataset_history`).
 */
export async function datasetWorkspaceBytes(
  tx: Transaction,
  workspaceId: string,
  now: Date = new Date(),
): Promise<number> {
  const at = now.toISOString();
  const [usage] = await tx.execute<{
    bytes: string;
  }>(sql`with retained as materialized (
      select g.id from data_generations g where g.workspace_id=${workspaceId}
      and not data_generation_releasable(g.workspace_id,g.dataset_id,g.id,g.sequence,${at}::timestamptz,interval '0')
    ), live_refreshes as materialized (
      select r.id from data_refreshes r where r.workspace_id=${workspaceId}
      and not data_refresh_releasable(r.workspace_id,r.dataset_id,r.refresh_key,r.complete,r.created_at,${at}::timestamptz,interval '0')
    ) select (
    coalesce((select sum(octet_length(payload::text) + 256) from data_pages where workspace_id=${workspaceId} and refresh_id in (select id from live_refreshes)),0)
    + coalesce((select sum(octet_length("values"::text) + octet_length(record_key) + 128) from data_records where workspace_id=${workspaceId} and generation_id in (select id from retained)),0)
  )::text as bytes`);
  return Number(usage?.bytes ?? 0);
}

/**
 * Stored bytes of live connector stages (compressed pages plus accounting
 * overhead, ADR 0024): committed stages and unexpired drafts, or only
 * committed ones. Callers serialize admission with the workspace staging
 * lock (lockWorkspaceStaging).
 */
export async function connectorStagingWorkspaceBytes(
  tx: Transaction,
  workspaceId: string,
  now: Date,
  options: { committedOnly?: boolean } = {},
): Promise<number> {
  const [usage] = await tx.execute<{ bytes: string }>(
    sql`select coalesce(sum(byte_size),0)::text as bytes from data_connector_stages where workspace_id=${workspaceId} and expires_at > ${now.toISOString()}::timestamptz${options.committedOnly ? sql` and committed_at is not null` : sql``}`,
  );
  return Number(usage?.bytes ?? 0);
}
