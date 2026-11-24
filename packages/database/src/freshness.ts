import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "./context.js";
import * as schema from "./schema.js";

// Data freshness per connection, stream and resource (ADR 0025 §4, #702).
// Runs as netrics_app inside withWorkspace; every statement also names the
// workspace (tenant isolation twice).

/** One entry of a succeeded run's done result, as the host stores it. */
export interface ConnectionFreshnessInput {
  stream: string;
  /** '' for the connection entry. */
  resource: string;
  /** YYYY-MM-DD, null for continuous streams. */
  dataThrough: string | null;
  /** The zone of dataThrough; null exactly when dataThrough is. */
  timeZone: string | null;
  expectedFrom: Date | null;
  nextExpectedAt: Date | null;
}

export type ConnectionFreshnessRow =
  typeof schema.connectionFreshness.$inferSelect;

const STATEMENT_ROWS = 1_000;

/**
 * Stores a succeeded run's freshness entries, in the run's final ingest
 * transaction. `checkedAt` is the run's start. data_through never moves
 * back: an earlier (or missing) date than the stored one only updates
 * checked_at. A later date updates every field and advanced_at; the same
 * date updates the zone and expected times. Rows the run did not report
 * are left as they are (a partial run).
 */
export async function recordConnectionFreshness(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    entries: readonly ConnectionFreshnessInput[];
    checkedAt: Date;
  },
): Promise<void> {
  const table = schema.connectionFreshness;
  const rows = input.entries.map((entry) => ({
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    stream: entry.stream,
    resource: entry.resource,
    dataThrough: entry.dataThrough,
    timeZone: entry.dataThrough === null ? null : entry.timeZone,
    expectedFrom: entry.expectedFrom,
    nextExpectedAt: entry.nextExpectedAt,
    checkedAt: input.checkedAt,
    advancedAt: entry.dataThrough === null ? null : input.checkedAt,
  }));
  // The stored date is kept when the report has none or an earlier one.
  const keep = sql`(${table.dataThrough} is not null and (excluded.data_through is null or excluded.data_through < ${table.dataThrough}))`;
  const stored = (column: string, current: unknown) =>
    sql`case when ${keep} then ${current} else excluded.${sql.raw(column)} end`;
  for (let start = 0; start < rows.length; start += STATEMENT_ROWS) {
    await tx
      .insert(table)
      .values(rows.slice(start, start + STATEMENT_ROWS))
      .onConflictDoUpdate({
        target: [table.connectionId, table.stream, table.resource],
        set: {
          checkedAt: sql`excluded.checked_at`,
          dataThrough: stored("data_through", table.dataThrough),
          timeZone: stored("time_zone", table.timeZone),
          expectedFrom: stored("expected_from", table.expectedFrom),
          nextExpectedAt: stored("next_expected_at", table.nextExpectedAt),
          advancedAt: sql`case when excluded.data_through is not null and excluded.data_through > coalesce(${table.dataThrough}, '-infinity'::date) then excluded.checked_at else ${table.advancedAt} end`,
        },
        setWhere: sql`${table.workspaceId} = ${input.workspaceId}`,
      });
  }
}

/**
 * Deletes the connection's per-resource freshness rows of resources it no
 * longer has (#874 review: a check removed from an HTTP check connection).
 * The connection's own rows (resource '') stay.
 */
export async function retireConnectionFreshness(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    keepResources: readonly string[];
  },
): Promise<void> {
  const table = schema.connectionFreshness;
  await tx
    .delete(table)
    .where(
      and(
        eq(table.workspaceId, input.workspaceId),
        eq(table.connectionId, input.connectionId),
        sql`${table.resource} <> ''`,
        input.keepResources.length > 0
          ? sql`not (${table.resource} = any(${sql.param([...input.keepResources])}::text[]))`
          : sql`true`,
      ),
    );
}

/** The connection's stored freshness rows, by stream and resource. */
export async function listConnectionFreshness(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionFreshnessRow[]> {
  const table = schema.connectionFreshness;
  return tx
    .select()
    .from(table)
    .where(
      and(
        eq(table.workspaceId, workspaceId),
        eq(table.connectionId, connectionId),
      ),
    )
    .orderBy(table.stream, table.resource);
}
