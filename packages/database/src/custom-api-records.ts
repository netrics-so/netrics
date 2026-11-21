import { and, eq } from "drizzle-orm";

import * as schema from "./schema.js";
import type { Transaction } from "./context.js";

// The last run's skipped records per stream of a custom API connection, a
// failed run included as far as it committed pages
// (#834 review, migration 0091): a count and the fields that skipped them,
// by path. Paths and counts only, never values.

export interface StreamRecordsSummary {
  streamKey: string;
  checkedAt: Date;
  skipped: number;
  skippedFields: Record<string, number>;
}

/**
 * Replaces the stream's summary, or with `add` (a continued run's next
 * job) adds to it. `maxFields` keeps the most frequent paths.
 */
export async function recordStreamRecords(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    streamKey: string;
    checkedAt: Date;
    skipped: number;
    skippedFields: Readonly<Record<string, number>>;
    add?: boolean;
    maxFields: number;
  },
): Promise<void> {
  let skipped = input.skipped;
  const fields = new Map(Object.entries(input.skippedFields));
  if (input.add) {
    const [before] = await tx
      .select({
        skipped: schema.customApiStreamRecords.skipped,
        skippedFields: schema.customApiStreamRecords.skippedFields,
      })
      .from(schema.customApiStreamRecords)
      .where(
        and(
          eq(schema.customApiStreamRecords.workspaceId, input.workspaceId),
          eq(schema.customApiStreamRecords.connectionId, input.connectionId),
          eq(schema.customApiStreamRecords.streamKey, input.streamKey),
        ),
      );
    if (before) {
      skipped += before.skipped;
      for (const [path, count] of Object.entries(before.skippedFields))
        fields.set(path, (fields.get(path) ?? 0) + count);
    }
  }
  const values = {
    checkedAt: input.checkedAt,
    skipped,
    skippedFields: Object.fromEntries(
      [...fields]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, input.maxFields),
    ),
  };
  await tx
    .insert(schema.customApiStreamRecords)
    .values({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      streamKey: input.streamKey,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        schema.customApiStreamRecords.connectionId,
        schema.customApiStreamRecords.streamKey,
      ],
      set: values,
      // The connection belongs to one workspace; never touch another's row.
      setWhere: eq(
        schema.customApiStreamRecords.workspaceId,
        input.workspaceId,
      ),
    });
}

/** The last run's summary of each stream of the connection, by stream key. */
export async function listStreamRecords(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<StreamRecordsSummary[]> {
  return tx
    .select({
      streamKey: schema.customApiStreamRecords.streamKey,
      checkedAt: schema.customApiStreamRecords.checkedAt,
      skipped: schema.customApiStreamRecords.skipped,
      skippedFields: schema.customApiStreamRecords.skippedFields,
    })
    .from(schema.customApiStreamRecords)
    .where(
      and(
        eq(schema.customApiStreamRecords.workspaceId, workspaceId),
        eq(schema.customApiStreamRecords.connectionId, connectionId),
      ),
    )
    .orderBy(schema.customApiStreamRecords.streamKey);
}
