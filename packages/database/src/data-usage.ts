import { sql } from "drizzle-orm";
import type { Transaction } from "./context.js";

/** Same advisory lock as ingestion: raw records and disposable staging share quota. */
export async function datasetWorkspaceBytes(
  tx: Transaction,
  workspaceId: string,
): Promise<number> {
  const [usage] = await tx.execute<{ bytes: string }>(sql`select (
    coalesce((select sum(octet_length(payload::text) + 256) from data_pages where workspace_id=${workspaceId}),0)
    + coalesce((select sum(octet_length("values"::text) + octet_length(record_key) + 128) from data_records where workspace_id=${workspaceId}),0)
    + coalesce((select sum(byte_size) from data_connector_stages where workspace_id=${workspaceId}),0)
  )::text as bytes`);
  return Number(usage?.bytes ?? 0);
}
