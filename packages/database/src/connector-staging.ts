import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import {
  datasetRecordSchema,
  datasetRetentionDays,
  validateDatasetPage,
  type DatasetPage,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import { exceedsDataPolicy, type DataPolicy } from "@netrics/domain";

import type { Transaction } from "./context.js";
import { connectorStagingWorkspaceBytes } from "./data-usage.js";
import { resolveDataPolicy } from "./data-policy.js";
import { DatasetStoreError } from "./datasets.js";
import {
  connections,
  dataConnectorStages,
  dataConnectorStagePages,
} from "./schema.js";

const DAY = 86_400_000;
const MAX_STAGE_BYTES = 128 * 1024 * 1024;
export interface ConnectorStageScope {
  workspaceId: string;
  connectionId: string;
  connectorId: string;
  now?: Date;
  /** Host clock: deadlines are checked after database waits, never frozen at run start. */
  clock?: () => Date;
  policyDefaults?: DataPolicy;
}
/** Disposable staging disappeared or expired; a fresh attempt can rebuild it. */
export class DatasetStageUnavailableError extends DatasetStoreError {
  constructor() {
    super("dataset_stage_unavailable");
    this.name = "DatasetStageUnavailableError";
  }
}
const unavailable = (): never => {
  throw new DatasetStageUnavailableError();
};
const currentTime = (scope: ConnectorStageScope) =>
  scope.clock?.() ?? scope.now ?? new Date();
const expired = (
  row: { expiresAt: Date; sourceExpiresAt: Date | null },
  scope: ConnectorStageScope,
) => {
  const now = currentTime(scope);
  return (
    row.expiresAt <= now ||
    (row.sourceExpiresAt !== null && row.sourceExpiresAt <= now)
  );
};
const fail = (code: string): never => {
  throw new DatasetStoreError(code);
};
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const digest = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
function expiry(at: Date, days: number | null) {
  if (days === null) return null;
  const millis = at.getTime() + days * DAY;
  return millis <= 253402300799000 ? new Date(millis) : null;
}
function minimum(a: Date | null, b: Date | null): Date | null {
  return a === null ? b : b === null ? a : a < b ? a : b;
}
function scopeWhere(scope: ConnectorStageScope) {
  return and(
    eq(dataConnectorStages.workspaceId, scope.workspaceId),
    eq(dataConnectorStages.connectionId, scope.connectionId),
    eq(dataConnectorStages.connectorId, scope.connectorId),
  );
}
async function live(
  tx: Transaction,
  scope: ConnectorStageScope,
  id?: string,
  key?: string,
) {
  const [row] = await tx
    .select()
    .from(dataConnectorStages)
    .where(
      and(
        scopeWhere(scope),
        id ? eq(dataConnectorStages.id, id) : undefined,
        key ? eq(dataConnectorStages.key, key) : undefined,
      ),
    );
  if (!row) return null;
  const { policy } = await resolveDataPolicy(
    tx,
    scope.workspaceId,
    scope.policyDefaults,
  );
  const policyExpiry = expiry(row.sourceCollectedAt, policy.maxRetentionDays);
  const available = {
    ...row,
    sourceExpiresAt: minimum(row.sourceExpiresAt, policyExpiry),
  };
  return expired(available, scope) ? null : available;
}

export async function findConnectorStage(
  tx: Transaction,
  scope: ConnectorStageScope,
  key: string,
) {
  if (!/^[a-zA-Z0-9:_-]{1,200}$/.test(key))
    return fail("dataset_stage_key_invalid");
  const row = await live(tx, scope, undefined, key);
  if (!row) return null;
  const pages = await tx
    .select({
      key: dataConnectorStagePages.pageKey,
      digest: dataConnectorStagePages.digest,
    })
    .from(dataConnectorStagePages)
    .where(
      and(
        eq(dataConnectorStagePages.workspaceId, scope.workspaceId),
        eq(dataConnectorStagePages.stageId, row.id),
      ),
    )
    .orderBy(dataConnectorStagePages.pageKey);
  if (expired(row, scope)) return null;
  if (
    digest([
      row.metadata,
      pages
        .map((p) => [p.key, p.digest])
        .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)),
    ]) !== row.digest
  )
    return fail("dataset_stage_integrity");
  return { id: row.id, key: row.key, metadata: row.metadata };
}

export async function readConnectorStagePage(
  tx: Transaction,
  scope: ConnectorStageScope,
  id: string,
  pageKey: string,
) {
  if (
    !z.uuid().safeParse(id).success ||
    !/^[a-zA-Z0-9:_-]{1,200}$/.test(pageKey)
  )
    return fail("dataset_stage_reference_invalid");
  const stage = await live(tx, scope, id);
  if (!stage) return unavailable();
  const [row] = await tx
    .select()
    .from(dataConnectorStagePages)
    .where(
      and(
        eq(dataConnectorStagePages.workspaceId, scope.workspaceId),
        eq(dataConnectorStagePages.stageId, id),
        eq(dataConnectorStagePages.pageKey, pageKey),
      ),
    );
  if (expired(stage, scope)) return unavailable();
  if (!row) {
    if (!(await live(tx, scope, id))) return unavailable();
    return fail("dataset_stage_reference_invalid");
  }
  if (digest(row.payload) !== row.digest)
    return fail("dataset_stage_integrity");
  return row.payload as DatasetPage;
}

export async function storeConnectorStage(
  tx: Transaction,
  scope: ConnectorStageScope,
  input: {
    key: string;
    metadata: unknown;
    pages: DatasetPage[];
  },
  definition: SourceDatasetDefinition,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    !/^[a-zA-Z0-9:_-]{1,200}$/.test(input.key) ||
    !datasetRecordSchema.safeParse({ values: { metadata: input.metadata } })
      .success ||
    Buffer.byteLength(JSON.stringify(input.metadata)) > 1_048_576 ||
    !input.pages.length
  )
    return fail("dataset_stage_invalid");
  const pages = input.pages.map((page) => {
    if (
      !/^[a-zA-Z0-9:_-]{1,200}$/.test(page.pageKey) ||
      page.stagingId ||
      page.stagingPageKey
    )
      return fail("dataset_stage_invalid");
    try {
      return validateDatasetPage(definition, page);
    } catch {
      return fail("dataset_stage_invalid");
    }
  });
  if (new Set(pages.map((p) => p.pageKey)).size !== pages.length)
    return fail("dataset_stage_invalid");
  const hashes = pages
    .map((p) => [p.pageKey, digest(p)])
    .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
  const contentDigest = digest([input.metadata, hashes]);
  const byteSize =
    Buffer.byteLength(JSON.stringify(input.metadata)) +
    pages.reduce((n, p) => n + Buffer.byteLength(JSON.stringify(p)) + 512, 512);
  if (byteSize > MAX_STAGE_BYTES) return fail("dataset_stage_limit");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${scope.workspaceId}, 440))`,
  );
  const now = currentTime(scope);
  const { policy } = await resolveDataPolicy(
    tx,
    scope.workspaceId,
    scope.policyDefaults,
  );
  const [connection] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, scope.workspaceId),
        eq(connections.id, scope.connectionId),
        eq(connections.connectorId, scope.connectorId),
      ),
    )
    .for("share");
  if (!connection) return fail("dataset_connection_not_found");
  const existing = await live(tx, scope, undefined, input.key);
  if (existing) {
    if (
      existing.digest !== contentDigest ||
      existing.datasetKey !== definition.key ||
      existing.schemaVersion !== definition.version
    )
      return fail("dataset_stage_conflict");
    return { id: existing.id, key: existing.key, metadata: existing.metadata };
  }
  // A lower cache budget never invalidates admitted continuations. Only new
  // stages consume capacity; zero disables allocation without evicting readers.
  if (policy.maxConnectorStagingBytes === 0) return fail("dataset_stage_quota");
  await tx
    .delete(dataConnectorStages)
    .where(and(scopeWhere(scope), eq(dataConnectorStages.key, input.key)));
  const requested = datasetRetentionDays(definition);
  const sourceExpiresAt = minimum(
    expiry(now, requested),
    expiry(now, policy.maxRetentionDays),
  );
  const expiresAt = minimum(new Date(now.getTime() + DAY), sourceExpiresAt)!;
  const [stage] = await tx
    .insert(dataConnectorStages)
    .values({
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      connectorId: scope.connectorId,
      key: input.key,
      datasetKey: definition.key,
      schemaVersion: definition.version,
      metadata: input.metadata,
      digest: contentDigest,
      byteSize,
      sourceCollectedAt: now,
      sourceExpiresAt,
      expiresAt,
    })
    .returning();
  for (const page of pages) {
    signal?.throwIfAborted();
    await tx.insert(dataConnectorStagePages).values({
      workspaceId: scope.workspaceId,
      stageId: stage!.id,
      pageKey: page.pageKey,
      payload: page,
      digest: digest(page),
    });
  }
  // PostgreSQL JSONB includes spacing; account actual serialized bytes, including metadata.
  const [actual] = await tx.execute<{ bytes: string }>(
    sql`select (octet_length(metadata::text) + 512 + coalesce((select sum(octet_length(payload::text) + 512) from data_connector_stage_pages where stage_id=${stage!.id}::uuid and workspace_id=${scope.workspaceId}::uuid),0))::text as bytes from data_connector_stages where id=${stage!.id}::uuid and workspace_id=${scope.workspaceId}::uuid`,
  );
  const actualBytes = Number(actual?.bytes ?? 0);
  if (actualBytes > MAX_STAGE_BYTES) return fail("dataset_stage_limit");
  await tx
    .update(dataConnectorStages)
    .set({ byteSize: actualBytes })
    .where(and(scopeWhere(scope), eq(dataConnectorStages.id, stage!.id)));
  if (
    exceedsDataPolicy(
      await connectorStagingWorkspaceBytes(
        tx,
        scope.workspaceId,
        currentTime(scope),
      ),
      policy.maxConnectorStagingBytes,
    )
  )
    return fail("dataset_stage_quota");
  signal?.throwIfAborted();
  if (expired(stage!, scope)) return unavailable();
  return { id: stage!.id, key: input.key, metadata: input.metadata };
}

/** Verify the actual returned rows/window, rather than trusting an arbitrary stage ID. */
export async function connectorStageProvenance(
  tx: Transaction,
  scope: ConnectorStageScope,
  page: DatasetPage,
) {
  if (!page.stagingId || !page.stagingPageKey)
    return fail("dataset_stage_reference_invalid");
  const stage = await live(tx, scope, page.stagingId);
  if (!stage) return unavailable();
  if (
    stage.datasetKey !== page.datasetKey ||
    stage.schemaVersion !== page.schemaVersion
  )
    return fail("dataset_stage_reference_invalid");
  const stored = await readConnectorStagePage(
    tx,
    scope,
    page.stagingId,
    page.stagingPageKey,
  );
  const content = (p: DatasetPage) => [
    p.datasetKey,
    p.schemaVersion,
    p.records,
    p.window ?? null,
    p.complete,
  ];
  if (digest(content(stored)) !== digest(content(page)))
    return fail("dataset_stage_reference_invalid");
  if (expired(stage, scope)) return unavailable();
  return {
    collectedAt: stage.sourceCollectedAt,
    expiresAt: stage.sourceExpiresAt,
  };
}
