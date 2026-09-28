import { and, desc, eq, gte, lte } from "drizzle-orm";

import type { Transaction } from "./context.js";
import * as schema from "./schema.js";

// Connection persistence for the API (netrics_app, inside withWorkspace).
// Every query names the workspace explicitly in addition to the RLS context
// (defense in depth): isolation must not depend on the database role being
// unprivileged.

export type ConnectionRow = typeof schema.connections.$inferSelect;
export type ConnectionStateRow = typeof schema.connectionState.$inferSelect;
export type SyncRunRow = typeof schema.syncRuns.$inferSelect;

export interface ConnectionWithState {
  row: ConnectionRow;
  state: ConnectionStateRow | null;
}

function connectionScope(workspaceId: string, connectionId: string) {
  return and(
    eq(schema.connections.workspaceId, workspaceId),
    eq(schema.connections.id, connectionId),
  );
}

function stateScope(workspaceId: string, connectionId: string) {
  return and(
    eq(schema.connectionState.workspaceId, workspaceId),
    eq(schema.connectionState.connectionId, connectionId),
  );
}

export async function findConnection(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionWithState | null> {
  const [row] = await tx
    .select()
    .from(schema.connections)
    .where(connectionScope(workspaceId, connectionId))
    .limit(1);
  if (!row) {
    return null;
  }
  const [state] = await tx
    .select()
    .from(schema.connectionState)
    .where(stateScope(workspaceId, connectionId))
    .limit(1);
  return { row, state: state ?? null };
}

export async function listConnections(
  tx: Transaction,
  workspaceId: string,
): Promise<ConnectionWithState[]> {
  const rows = await tx
    .select({ row: schema.connections, state: schema.connectionState })
    .from(schema.connections)
    .leftJoin(
      schema.connectionState,
      and(
        eq(schema.connectionState.connectionId, schema.connections.id),
        eq(schema.connectionState.workspaceId, workspaceId),
      ),
    )
    .where(eq(schema.connections.workspaceId, workspaceId))
    .orderBy(schema.connections.createdAt);
  return rows;
}

export interface NewConnection {
  id: string;
  workspaceId: string;
  connectorId: string;
  name: string;
  config: Record<string, unknown>;
  credentialsEncrypted: Buffer | null;
  projectId: string | null;
  /** Initial poll interval (the connector's minimum refresh interval). */
  pollIntervalSeconds: number;
}

/** Inserts the connection and its state row, due immediately. */
export async function insertConnection(
  tx: Transaction,
  input: NewConnection,
): Promise<ConnectionWithState> {
  const [row] = await tx
    .insert(schema.connections)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      connectorId: input.connectorId,
      name: input.name,
      config: input.config,
      credentialsEncrypted: input.credentialsEncrypted,
      projectId: input.projectId,
    })
    .returning();
  if (!row) {
    throw new Error("connection insert returned no row");
  }
  const [state] = await tx
    .insert(schema.connectionState)
    .values({
      connectionId: input.id,
      workspaceId: input.workspaceId,
      nextDueAt: new Date(),
      pollIntervalSeconds: input.pollIntervalSeconds,
    })
    .returning();
  return { row, state: state ?? null };
}

export interface ConnectionChanges {
  name?: string;
  config?: Record<string, unknown>;
  credentialsEncrypted?: Buffer;
  projectId?: string | null;
}

/** Applies the given changes; returns null when the connection is gone. */
export async function updateConnection(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  changes: ConnectionChanges,
): Promise<ConnectionRow | null> {
  const [row] = await tx
    .update(schema.connections)
    .set({ ...changes, updatedAt: new Date() })
    .where(connectionScope(workspaceId, connectionId))
    .returning();
  return row ?? null;
}

/**
 * Recovery after new credentials: the connection is healthy again, due
 * immediately, and its failure streak starts over.
 */
export async function resetConnectionAuth(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionStateRow | null> {
  const [state] = await tx
    .update(schema.connectionState)
    .set({ authState: "ok", consecutiveFailures: 0, nextDueAt: new Date() })
    .where(stateScope(workspaceId, connectionId))
    .returning();
  return state ?? null;
}

/**
 * Deletes the connection (state, observations and sync runs cascade). Its
 * pending jobs are cancelled first so no worker claims work for it; the app
 * role cannot delete jobs, and they stay as detached history (migration
 * 0016).
 */
export async function deleteConnection(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  await tx
    .update(schema.jobs)
    .set({ status: "failed", lastError: "connection deleted" })
    .where(
      and(
        eq(schema.jobs.workspaceId, workspaceId),
        eq(schema.jobs.connectionId, connectionId),
        eq(schema.jobs.status, "pending"),
      ),
    );
  await tx
    .delete(schema.connections)
    .where(connectionScope(workspaceId, connectionId));
}

export async function listRecentSyncRuns(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  limit: number,
): Promise<SyncRunRow[]> {
  return tx
    .select()
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.workspaceId, workspaceId),
        eq(schema.syncRuns.connectionId, connectionId),
      ),
    )
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(limit);
}

export interface ObservationFilter {
  metricKey?: string;
  from?: Date;
  to?: Date;
  limit: number;
}

export interface ObservationRow {
  metricKey: string;
  seriesKey: string;
  sourceTimestamp: Date;
  value: number;
  dimensions: unknown;
  ingestedAt: Date;
}

/** Newest first, joined with the metric key. */
export async function listObservations(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  filter: ObservationFilter,
): Promise<ObservationRow[]> {
  return tx
    .select({
      metricKey: schema.metricDefinitions.key,
      seriesKey: schema.observations.seriesKey,
      sourceTimestamp: schema.observations.sourceTimestamp,
      value: schema.observations.value,
      dimensions: schema.observations.dimensions,
      ingestedAt: schema.observations.ingestedAt,
    })
    .from(schema.observations)
    .innerJoin(
      schema.metricDefinitions,
      eq(schema.observations.metricDefinitionId, schema.metricDefinitions.id),
    )
    .where(
      and(
        eq(schema.observations.workspaceId, workspaceId),
        eq(schema.observations.connectionId, connectionId),
        filter.metricKey
          ? eq(schema.metricDefinitions.key, filter.metricKey)
          : undefined,
        filter.from
          ? gte(schema.observations.sourceTimestamp, filter.from)
          : undefined,
        filter.to
          ? lte(schema.observations.sourceTimestamp, filter.to)
          : undefined,
      ),
    )
    .orderBy(desc(schema.observations.sourceTimestamp))
    .limit(filter.limit);
}
