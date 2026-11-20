import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import type { Transaction } from "./context.js";
import { projectFilterSql, type ProjectFilter } from "./project-filter.js";
import * as schema from "./schema.js";

// Custom API definitions (milestone 13, #803), as netrics_app inside
// withWorkspace. Every query names the workspace explicitly on top of RLS.
// Documents are validated by the caller (connector SDK); here they are
// opaque JSON. Versions are immutable: a change inserts the next version.

export type CustomApiDefinitionRow =
  typeof schema.customApiDefinitions.$inferSelect;
export type CustomApiDefinitionVersionRow =
  typeof schema.customApiDefinitionVersions.$inferSelect;

export interface CustomApiDefinitionWithVersion {
  definition: CustomApiDefinitionRow;
  /** The definition's current version. */
  version: CustomApiDefinitionVersionRow;
  /** The workspace's connections pinned to any version of the definition. */
  connectionCount: number;
}

export interface CustomApiVersionContent {
  createdBy: string | null;
  document: Record<string, unknown>;
  documentSha256: string;
  schemaVersion: number;
  datasetVersions: Record<string, number>;
}

export interface NewCustomApiDefinition extends CustomApiVersionContent {
  id: string;
  projectId: string | null;
  name: string;
}

export interface NewCustomApiDefinitionVersion extends CustomApiVersionContent {
  /** The version the change was made from; must still be current. */
  baseVersion: number;
  name: string;
}

const definitions = schema.customApiDefinitions;
const versions = schema.customApiDefinitionVersions;
const connections = schema.connections;

function definitionScope(workspaceId: string, definitionId: string) {
  return and(
    eq(definitions.workspaceId, workspaceId),
    eq(definitions.id, definitionId),
  );
}

/** Connections pinned to any version of each definition, by definition id. */
async function connectionCounts(
  tx: Transaction,
  workspaceId: string,
  definitionIds: string[],
): Promise<Map<string, number>> {
  if (definitionIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ definitionId: versions.definitionId, count: count() })
    .from(connections)
    .innerJoin(
      versions,
      and(
        eq(versions.id, connections.customApiDefinitionVersionId),
        eq(versions.workspaceId, connections.workspaceId),
      ),
    )
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(versions.workspaceId, workspaceId),
        inArray(versions.definitionId, definitionIds),
      ),
    )
    .groupBy(versions.definitionId);
  return new Map(rows.map((row) => [row.definitionId, Number(row.count)]));
}

async function withCurrentVersions(
  tx: Transaction,
  workspaceId: string,
  rows: Array<{
    definition: CustomApiDefinitionRow;
    version: CustomApiDefinitionVersionRow;
  }>,
): Promise<CustomApiDefinitionWithVersion[]> {
  const counts = await connectionCounts(
    tx,
    workspaceId,
    rows.map((row) => row.definition.id),
  );
  return rows.map((row) => ({
    ...row,
    connectionCount: counts.get(row.definition.id) ?? 0,
  }));
}

function selectWithCurrentVersion(tx: Transaction, workspaceId: string) {
  return tx
    .select({ definition: definitions, version: versions })
    .from(definitions)
    .innerJoin(
      versions,
      and(
        eq(versions.definitionId, definitions.id),
        eq(versions.workspaceId, workspaceId),
        eq(versions.version, definitions.currentVersion),
      ),
    );
}

/** Inserts the definition with its version 1. */
export async function insertCustomApiDefinition(
  tx: Transaction,
  workspaceId: string,
  input: NewCustomApiDefinition,
): Promise<CustomApiDefinitionWithVersion> {
  const [definition] = await tx
    .insert(definitions)
    .values({
      id: input.id,
      workspaceId,
      projectId: input.projectId,
      name: input.name,
      currentVersion: 1,
      createdBy: input.createdBy,
    })
    .returning();
  if (!definition) {
    throw new Error("custom API definition insert returned no row");
  }
  const [version] = await tx
    .insert(versions)
    .values({
      workspaceId,
      definitionId: input.id,
      version: 1,
      schemaVersion: input.schemaVersion,
      document: input.document,
      documentSha256: input.documentSha256,
      datasetVersions: input.datasetVersions,
      createdBy: input.createdBy,
    })
    .returning();
  if (!version) {
    throw new Error("custom API definition version insert returned no row");
  }
  return { definition, version, connectionCount: 0 };
}

/**
 * Inserts the next version and makes it current. Locks the definition row,
 * so of two concurrent changes from the same base exactly one wins and the
 * other answers "stale". Null when the definition is not in the workspace.
 * Archived definitions are the caller's to refuse.
 */
export async function insertCustomApiDefinitionVersion(
  tx: Transaction,
  workspaceId: string,
  definitionId: string,
  input: NewCustomApiDefinitionVersion,
): Promise<CustomApiDefinitionWithVersion | "stale" | null> {
  const [locked] = await tx
    .select()
    .from(definitions)
    .where(definitionScope(workspaceId, definitionId))
    .for("update");
  if (!locked) {
    return null;
  }
  if (locked.currentVersion !== input.baseVersion) {
    return "stale";
  }
  const next = locked.currentVersion + 1;
  const [version] = await tx
    .insert(versions)
    .values({
      workspaceId,
      definitionId,
      version: next,
      schemaVersion: input.schemaVersion,
      document: input.document,
      documentSha256: input.documentSha256,
      datasetVersions: input.datasetVersions,
      createdBy: input.createdBy,
    })
    .returning();
  if (!version) {
    throw new Error("custom API definition version insert returned no row");
  }
  const [definition] = await tx
    .update(definitions)
    .set({ currentVersion: next, name: input.name, updatedAt: sql`now()` })
    .where(definitionScope(workspaceId, definitionId))
    .returning();
  if (!definition) {
    throw new Error("custom API definition update returned no row");
  }
  const counts = await connectionCounts(tx, workspaceId, [definitionId]);
  return {
    definition,
    version,
    connectionCount: counts.get(definitionId) ?? 0,
  };
}

/** The workspace's definitions with their current versions, by name. */
export async function listCustomApiDefinitions(
  tx: Transaction,
  workspaceId: string,
  options: { includeArchived: boolean } & ProjectFilter,
): Promise<CustomApiDefinitionWithVersion[]> {
  const rows = await selectWithCurrentVersion(tx, workspaceId)
    .where(
      and(
        eq(definitions.workspaceId, workspaceId),
        options.includeArchived ? undefined : isNull(definitions.archivedAt),
        projectFilterSql(definitions.projectId, workspaceId, options),
      ),
    )
    .orderBy(asc(sql`lower(${definitions.name})`), asc(definitions.createdAt));
  return withCurrentVersions(tx, workspaceId, rows);
}

export async function findCustomApiDefinition(
  tx: Transaction,
  workspaceId: string,
  definitionId: string,
): Promise<CustomApiDefinitionWithVersion | null> {
  const rows = await selectWithCurrentVersion(tx, workspaceId)
    .where(definitionScope(workspaceId, definitionId))
    .limit(1);
  const [found] = await withCurrentVersions(tx, workspaceId, rows);
  return found ?? null;
}

export async function findCustomApiDefinitionVersion(
  tx: Transaction,
  workspaceId: string,
  definitionId: string,
  version: number,
): Promise<CustomApiDefinitionVersionRow | null> {
  const [row] = await tx
    .select()
    .from(versions)
    .where(
      and(
        eq(versions.workspaceId, workspaceId),
        eq(versions.definitionId, definitionId),
        eq(versions.version, version),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Stream key → the highest dataset version any version of the definition
 * gave it, removed streams included (dataset versions are monotonic per key
 * for the life of a definition).
 */
export async function customApiDatasetVersionHighWater(
  tx: Transaction,
  workspaceId: string,
  definitionId: string,
): Promise<Record<string, number>> {
  const rows = await tx.execute<{ key: string; version: number }>(sql`
    select entry.key as key, max((entry.value)::integer) as version
    from ${versions},
      jsonb_each_text(${versions.datasetVersions}) as entry
    where ${versions.workspaceId} = ${workspaceId}
      and ${versions.definitionId} = ${definitionId}
    group by entry.key`);
  return Object.fromEntries(
    [...rows].map((row) => [row.key, Number(row.version)]),
  );
}

/** Moves the definition to another project or archives it. */
export async function updateCustomApiDefinition(
  tx: Transaction,
  workspaceId: string,
  definitionId: string,
  changes: { projectId?: string | null; archivedAt?: Date },
): Promise<CustomApiDefinitionRow | null> {
  const [row] = await tx
    .update(definitions)
    .set({
      ...(changes.projectId !== undefined
        ? { projectId: changes.projectId }
        : {}),
      ...(changes.archivedAt !== undefined
        ? { archivedAt: changes.archivedAt }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(definitionScope(workspaceId, definitionId))
    .returning();
  return row ?? null;
}

/** The workspace's definitions that are not archived. */
export async function countCustomApiDefinitions(
  tx: Transaction,
  workspaceId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(definitions)
    .where(
      and(
        eq(definitions.workspaceId, workspaceId),
        isNull(definitions.archivedAt),
      ),
    );
  return Number(row?.count ?? 0);
}

/** The workspace's custom-api connections, drafts not counted. */
export async function countCustomApiConnections(
  tx: Transaction,
  workspaceId: string,
): Promise<number> {
  const [row] = await tx
    .select({ count: count() })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.connectorId, "custom-api"),
        // Drafts of the builder are not connections yet (#806).
        ne(connections.status, "draft"),
      ),
    );
  return Number(row?.count ?? 0);
}
