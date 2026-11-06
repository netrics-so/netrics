import { sql } from "drizzle-orm";
import type { Transaction } from "./context.js";

/** Retained raw data accounting, independent of disposable execution caches. */
export async function datasetWorkspaceBytes(
  tx: Transaction,
  workspaceId: string,
): Promise<number> {
  const [usage] = await tx.execute<{ bytes: string }>(sql`select (
    coalesce((select sum(octet_length(payload::text) + 256) from data_pages where workspace_id=${workspaceId}),0)
    + coalesce((select sum(octet_length("values"::text) + octet_length(record_key) + 128) from data_records where workspace_id=${workspaceId}),0)
  )::text as bytes`);
  return Number(usage?.bytes ?? 0);
}

/** Actual live cache bytes; callers serialize admission with workspace lock 440. */
export async function connectorStagingWorkspaceBytes(
  tx: Transaction,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const [usage] = await tx.execute<{ bytes: string }>(
    sql`select coalesce(sum(byte_size),0)::text as bytes from data_connector_stages where workspace_id=${workspaceId} and expires_at > ${now.toISOString()}::timestamptz`,
  );
  return Number(usage?.bytes ?? 0);
}
