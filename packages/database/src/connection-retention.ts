import { and, eq, sql } from "drizzle-orm";
import {
  chosenRetentionDays,
  connectionRetentionBasisSchema,
  connectionRetentionChoiceSchema,
  connectionRetentionFallbackSchema,
  type ConnectionRetentionBasis,
  type ConnectionRetentionChoice,
  type ConnectionRetentionFallback,
  type SourceDatasetDefinition,
} from "@netrics/contracts";

import type { Transaction } from "./context.js";
import { connections, users } from "./schema.js";

// Per-connection dataset retention (#492). Runs as netrics_app inside
// withWorkspace; every query also names the workspace explicitly.

export interface ConnectionRetentionRecord {
  choice: ConnectionRetentionChoice;
  fallback: ConnectionRetentionFallback;
  basis: ConnectionRetentionBasis;
  chosenAt: Date | null;
  chosenBy: { id: string; name: string } | null;
}

export async function findConnectionRetention(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionRetentionRecord | null> {
  const [row] = await tx
    .select({
      choice: connections.retentionChoice,
      fallback: connections.retentionFallback,
      basis: connections.retentionBasis,
      chosenAt: connections.retentionChosenAt,
      chosenById: connections.retentionChosenBy,
      chosenByName: users.displayName,
    })
    .from(connections)
    .leftJoin(users, eq(users.id, connections.retentionChosenBy))
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.id, connectionId),
      ),
    );
  if (!row) return null;
  // Malformed stored choices fall back to the preset rather than failing a sync.
  const choice = connectionRetentionChoiceSchema.safeParse(row.choice);
  const fallback = connectionRetentionFallbackSchema.safeParse(row.fallback);
  const basis = connectionRetentionBasisSchema.safeParse(row.basis);
  return {
    choice: choice.success ? choice.data : {},
    fallback: fallback.success ? fallback.data : "preset",
    basis: basis.success ? basis.data : "preset",
    chosenAt: row.chosenAt,
    chosenBy:
      row.chosenById && row.chosenByName
        ? { id: row.chosenById, name: row.chosenByName }
        : null,
  };
}

/**
 * The retention a source dataset of this connection asks for, before the
 * workspace maximum. Used by ingestion and connector staging.
 */
export async function connectionDatasetRetentionDays(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  definition: SourceDatasetDefinition,
): Promise<number | null> {
  const record = await findConnectionRetention(tx, workspaceId, connectionId);
  return chosenRetentionDays(
    definition,
    record ?? { choice: {}, fallback: "preset" },
  ).days;
}

/**
 * The workspace ingestion lock (440) for this transaction. Dataset ingestion,
 * connector staging, connection retention and admin_set_data_policy take it
 * before reading or applying retention, so they serialize. Take it before
 * any connection row lock.
 */
export async function lockWorkspaceIngestion(
  tx: Transaction,
  workspaceId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::uuid::text, 440))`,
  );
}

export interface SetConnectionRetentionInput {
  workspaceId: string;
  connectionId: string;
  /** The new explicit choice; it replaces the stored one. */
  choice: ConnectionRetentionChoice;
  chosenBy: string | null;
  /**
   * Dataset key → days after the workspace maximum, for every dataset of the
   * connector. Stored deadlines follow these values immediately.
   */
  effective: Record<string, number | null>;
  now?: Date;
}

/**
 * Records the choice on the connection and applies it to stored deadlines
 * (apply_connection_retention): shorter periods take effect at once and
 * clear derived caches; longer ones only extend data that has not expired.
 */
export async function setConnectionRetention(
  tx: Transaction,
  input: SetConnectionRetentionInput,
): Promise<boolean> {
  // Serialize with dataset ingestion and connector staging, which read the
  // choice under this workspace lock (440): an in-flight page either commits
  // before this and is then shortened below, or waits and reads the new
  // choice. Lock order is always this lock, then the connection row; sync
  // pages ingest datasets before taking their review row lock (sync/engine.ts).
  await lockWorkspaceIngestion(tx, input.workspaceId);
  const now = input.now ?? new Date();
  const updated = await tx
    .update(connections)
    .set({
      retentionChoice: input.choice,
      retentionBasis: "chosen",
      retentionChosenBy: input.chosenBy,
      retentionChosenAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(connections.workspaceId, input.workspaceId),
        eq(connections.id, input.connectionId),
      ),
    )
    .returning({ id: connections.id });
  if (updated.length === 0) return false;
  const [applied] = await tx.execute<{ applied: boolean }>(
    sql`select apply_connection_retention(${input.workspaceId}::uuid, ${input.connectionId}::uuid, ${JSON.stringify(input.effective)}::jsonb, ${now.toISOString()}::timestamptz) as applied`,
  );
  return applied?.applied === true;
}
