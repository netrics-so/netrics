import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import {
  datasetRecordSchema,
  validateDatasetPage,
  type DatasetPage,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import { exceedsDataPolicy, type DataPolicy } from "@netrics/domain";

import type { Transaction } from "./context.js";
import { connectorStagingWorkspaceBytes } from "./data-usage.js";
import { resolveDataPolicy } from "./data-policy.js";
import {
  connectionDatasetRetentionDays,
  lockWorkspaceIngestion,
  lockWorkspaceStaging,
} from "./connection-retention.js";
import { DatasetStoreError } from "./datasets.js";
import {
  connections,
  dataConnectorStages,
  dataConnectorStagePages,
} from "./schema.js";

const DAY = 86_400_000;
/** Stored bytes of one stage: compressed pages, metadata and overhead. */
const MAX_STAGE_BYTES = 128 * 1024 * 1024;
/** A draft lives within one connector call; this bounds an abandoned one. */
export const CONNECTOR_STAGE_DRAFT_TTL_MS = 15 * 60_000;
/** Accounting overhead per stored page and per stage header. */
const PAGE_OVERHEAD = 512;
const HEADER_OVERHEAD = 512;
/** JSON text of one stored page (the 0058 payload check, now before compression). */
const MAX_PAGE_TEXT = 2_097_152;
const KEY = /^[a-zA-Z0-9:_-]{1,200}$/;

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
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Header digest over metadata and page digests, ordered without the database collation. */
const contentDigest = (metadata: unknown, pages: Array<[string, string]>) =>
  digest([metadata, [...pages].sort(([a], [b]) => byKey(a, b))]);
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
function validMetadata(metadata: unknown): boolean {
  return (
    datasetRecordSchema.safeParse({ values: { metadata } }).success &&
    Buffer.byteLength(JSON.stringify(metadata)) <= 1_048_576
  );
}
/** A committed, unexpired stage; drafts are never visible here. */
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
        isNotNull(dataConnectorStages.committedAt),
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
  if (!KEY.test(key)) return fail("dataset_stage_key_invalid");
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
    );
  if (expired(row, scope)) return null;
  if (
    contentDigest(
      row.metadata,
      pages.map((p) => [p.key, p.digest]),
    ) !== row.digest
  )
    return fail("dataset_stage_integrity");
  return { id: row.id, key: row.key, metadata: row.metadata };
}

/** A stored page: compressed JSON text since 0067, JSONB before. */
function storedPage(row: {
  payload: unknown;
  payloadGzip: Buffer | null;
}): unknown {
  if (!row.payloadGzip) return row.payload;
  try {
    return JSON.parse(
      gunzipSync(row.payloadGzip, { maxOutputLength: MAX_PAGE_TEXT }).toString(
        "utf8",
      ),
    );
  } catch {
    return fail("dataset_stage_integrity");
  }
}

export async function readConnectorStagePage(
  tx: Transaction,
  scope: ConnectorStageScope,
  id: string,
  pageKey: string,
) {
  if (!z.uuid().safeParse(id).success || !KEY.test(pageKey))
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
  const page = storedPage(row);
  if (digest(page) !== row.digest) return fail("dataset_stage_integrity");
  return page as DatasetPage;
}

/** Digest of one stored page, independent of its storage encoding. */
export const connectorStagePageDigest = (page: DatasetPage) => digest(page);

/** Content digest of a complete page set, as commit would compute it. */
export function connectorStageDigest(
  metadata: unknown,
  pages: DatasetPage[],
): string {
  return contentDigest(
    metadata,
    pages.map((page) => [page.pageKey, digest(page)]),
  );
}

/**
 * The committed live stage under `key` if it holds exactly this content, null
 * if there is none; different content is a conflict. Lets `put` return an
 * admitted stage without writing (or needing budget for) a new draft.
 */
export async function matchConnectorStage(
  tx: Transaction,
  scope: ConnectorStageScope,
  input: { key: string; metadata: unknown; pages: DatasetPage[] },
  definition: SourceDatasetDefinition,
) {
  if (!KEY.test(input.key)) return fail("dataset_stage_invalid");
  const existing = await live(tx, scope, undefined, input.key);
  if (!existing) return null;
  if (
    existing.digest !== connectorStageDigest(input.metadata, input.pages) ||
    existing.datasetKey !== definition.key ||
    existing.schemaVersion !== definition.version
  )
    return fail("dataset_stage_conflict");
  return { id: existing.id, key: existing.key, metadata: existing.metadata };
}

/**
 * Starts a draft (ADR 0024). It fixes the collection time and deadlines under
 * the ingestion lock (440), as retention changes do, and holds no bytes yet.
 * The draft expires CONNECTOR_STAGE_DRAFT_TTL_MS after begin unless committed.
 */
export async function beginConnectorStage(
  tx: Transaction,
  scope: ConnectorStageScope,
  input: { key: string },
  definition: SourceDatasetDefinition,
): Promise<{ id: string }> {
  if (!KEY.test(input.key)) return fail("dataset_stage_invalid");
  await lockWorkspaceIngestion(tx, scope.workspaceId);
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
  // A lower cache budget never invalidates admitted continuations. Only new
  // stages consume capacity; zero disables allocation without evicting readers.
  if (policy.maxConnectorStagingBytes === 0) return fail("dataset_stage_quota");
  const requested = await connectionDatasetRetentionDays(
    tx,
    scope.workspaceId,
    scope.connectionId,
    definition,
  );
  const sourceExpiresAt = minimum(
    expiry(now, requested),
    expiry(now, policy.maxRetentionDays),
  );
  const expiresAt = minimum(
    new Date(now.getTime() + CONNECTOR_STAGE_DRAFT_TTL_MS),
    sourceExpiresAt,
  )!;
  if (expiresAt <= now) return unavailable();
  const [stage] = await tx
    .insert(dataConnectorStages)
    .values({
      workspaceId: scope.workspaceId,
      connectionId: scope.connectionId,
      connectorId: scope.connectorId,
      key: input.key,
      datasetKey: definition.key,
      schemaVersion: definition.version,
      metadata: {},
      digest: "",
      byteSize: 0,
      sourceCollectedAt: now,
      sourceExpiresAt,
      expiresAt,
    })
    .returning({ id: dataConnectorStages.id });
  return { id: stage!.id };
}

/** Validated, compressed pages ready to store; done before any lock is taken. */
export function prepareConnectorStagePages(
  pages: DatasetPage[],
  definition: SourceDatasetDefinition,
) {
  if (!pages.length) return fail("dataset_stage_invalid");
  const prepared = pages.map((input) => {
    if (!KEY.test(input.pageKey) || input.stagingId || input.stagingPageKey)
      return fail("dataset_stage_invalid");
    let page: DatasetPage;
    try {
      page = validateDatasetPage(definition, input);
    } catch {
      return fail("dataset_stage_invalid");
    }
    const text = Buffer.from(JSON.stringify(page), "utf8");
    if (text.byteLength > MAX_PAGE_TEXT) return fail("dataset_stage_invalid");
    return {
      pageKey: page.pageKey,
      payloadGzip: gzipSync(text),
      digest: digest(page),
    };
  });
  if (new Set(prepared.map((p) => p.pageKey)).size !== prepared.length)
    return fail("dataset_stage_invalid");
  return prepared;
}
export type PreparedConnectorStagePages = ReturnType<
  typeof prepareConnectorStagePages
>;

/**
 * Stores pages in a draft and accounts their compressed bytes. Takes only the
 * workspace staging lock (441), never the ingestion lock. The draft and all
 * live stages of the workspace, drafts included, must stay within the stage
 * limit and maxConnectorStagingBytes; otherwise nothing of this call is kept.
 */
export async function appendConnectorStagePages(
  tx: Transaction,
  scope: ConnectorStageScope,
  id: string,
  pages: PreparedConnectorStagePages,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!z.uuid().safeParse(id).success) return fail("dataset_stage_invalid");
  await lockWorkspaceStaging(tx, scope.workspaceId);
  const now = currentTime(scope);
  const added = pages.reduce(
    (n, page) => n + page.payloadGzip.byteLength + PAGE_OVERHEAD,
    0,
  );
  const [draft] = await tx
    .update(dataConnectorStages)
    .set({ byteSize: sql`${dataConnectorStages.byteSize} + ${added}` })
    .where(
      and(
        scopeWhere(scope),
        eq(dataConnectorStages.id, id),
        isNull(dataConnectorStages.committedAt),
        gt(dataConnectorStages.expiresAt, now),
        // Larger than a stage may be: refused below without a check violation.
        sql`${dataConnectorStages.byteSize} + ${added} <= ${MAX_STAGE_BYTES}`,
      ),
    )
    .returning({
      byteSize: dataConnectorStages.byteSize,
      sourceExpiresAt: dataConnectorStages.sourceExpiresAt,
    });
  if (!draft) {
    const [row] = await tx
      .select({ byteSize: dataConnectorStages.byteSize })
      .from(dataConnectorStages)
      .where(
        and(
          scopeWhere(scope),
          eq(dataConnectorStages.id, id),
          isNull(dataConnectorStages.committedAt),
          gt(dataConnectorStages.expiresAt, now),
        ),
      );
    return row ? fail("dataset_stage_limit") : unavailable();
  }
  if (draft.sourceExpiresAt !== null && draft.sourceExpiresAt <= now)
    return unavailable();
  if (draft.byteSize + HEADER_OVERHEAD > MAX_STAGE_BYTES)
    return fail("dataset_stage_limit");
  const { policy } = await resolveDataPolicy(
    tx,
    scope.workspaceId,
    scope.policyDefaults,
  );
  if (
    exceedsDataPolicy(
      await connectorStagingWorkspaceBytes(tx, scope.workspaceId, now),
      policy.maxConnectorStagingBytes,
    )
  )
    return fail("dataset_stage_quota");
  for (const page of pages) {
    signal?.throwIfAborted();
    try {
      await tx.insert(dataConnectorStagePages).values({
        workspaceId: scope.workspaceId,
        stageId: id,
        pageKey: page.pageKey,
        payloadGzip: page.payloadGzip,
        digest: page.digest,
      });
    } catch (error) {
      // A page key the draft already holds.
      if ((error as { code?: string }).code === "23505")
        return fail("dataset_stage_invalid");
      throw error;
    }
  }
  signal?.throwIfAborted();
}

/**
 * Publishes a draft. Under the ingestion lock (440, as retention changes) it
 * fixes the final deadline: one day after collection at most, and never past
 * the source deadline that policy and connection-retention changes have kept
 * up to date on the draft, nor past the current policy. An identical
 * committed stage under the same key is returned instead; different content
 * is a conflict. Either way the draft is removed.
 */
export async function commitConnectorStage(
  tx: Transaction,
  scope: ConnectorStageScope,
  id: string,
  metadata: unknown,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!z.uuid().safeParse(id).success || !validMetadata(metadata))
    return fail("dataset_stage_invalid");
  await lockWorkspaceIngestion(tx, scope.workspaceId);
  await lockWorkspaceStaging(tx, scope.workspaceId);
  const now = currentTime(scope);
  const { policy } = await resolveDataPolicy(
    tx,
    scope.workspaceId,
    scope.policyDefaults,
  );
  const [draft] = await tx
    .select()
    .from(dataConnectorStages)
    .where(
      and(
        scopeWhere(scope),
        eq(dataConnectorStages.id, id),
        isNull(dataConnectorStages.committedAt),
      ),
    )
    .for("update");
  if (!draft) return unavailable();
  const sourceExpiresAt = minimum(
    draft.sourceExpiresAt,
    expiry(draft.sourceCollectedAt, policy.maxRetentionDays),
  );
  const expiresAt = minimum(
    new Date(draft.sourceCollectedAt.getTime() + DAY),
    sourceExpiresAt,
  )!;
  if (
    expired(draft, scope) ||
    expiresAt <= now ||
    (sourceExpiresAt !== null && sourceExpiresAt <= now)
  )
    return unavailable();
  const pages = await tx
    .select({
      key: dataConnectorStagePages.pageKey,
      digest: dataConnectorStagePages.digest,
    })
    .from(dataConnectorStagePages)
    .where(
      and(
        eq(dataConnectorStagePages.workspaceId, scope.workspaceId),
        eq(dataConnectorStagePages.stageId, id),
      ),
    );
  if (!pages.length) return fail("dataset_stage_invalid");
  const content = contentDigest(
    metadata,
    pages.map((p) => [p.key, p.digest]),
  );
  const discard = () =>
    tx
      .delete(dataConnectorStages)
      .where(and(scopeWhere(scope), eq(dataConnectorStages.id, id)));
  const existing = await live(tx, scope, undefined, draft.key);
  if (existing) {
    await discard();
    if (
      existing.digest !== content ||
      existing.datasetKey !== draft.datasetKey ||
      existing.schemaVersion !== draft.schemaVersion
    )
      return fail("dataset_stage_conflict");
    return { id: existing.id, key: existing.key, metadata: existing.metadata };
  }
  // An expired committed stage still holds the key until pruned.
  await tx
    .delete(dataConnectorStages)
    .where(
      and(
        scopeWhere(scope),
        eq(dataConnectorStages.key, draft.key),
        isNotNull(dataConnectorStages.committedAt),
      ),
    );
  const [stage] = await tx
    .update(dataConnectorStages)
    .set({
      metadata,
      digest: content,
      committedAt: now,
      expiresAt,
      byteSize: sql`${dataConnectorStages.byteSize} + ${HEADER_OVERHEAD} + octet_length(${JSON.stringify(metadata)}::jsonb::text)`,
    })
    .where(
      and(
        scopeWhere(scope),
        eq(dataConnectorStages.id, id),
        isNull(dataConnectorStages.committedAt),
        sql`${dataConnectorStages.byteSize} + ${HEADER_OVERHEAD} + octet_length(${JSON.stringify(metadata)}::jsonb::text) <= ${MAX_STAGE_BYTES}`,
      ),
    )
    .returning({ byteSize: dataConnectorStages.byteSize });
  if (!stage) return fail("dataset_stage_limit");
  // Other writers' drafts do not count here: they are checked on their own
  // appends and commit, so one of several racing stages can always finish.
  if (
    exceedsDataPolicy(
      await connectorStagingWorkspaceBytes(tx, scope.workspaceId, now, {
        committedOnly: true,
      }),
      policy.maxConnectorStagingBytes,
    )
  )
    return fail("dataset_stage_quota");
  signal?.throwIfAborted();
  return { id, key: draft.key, metadata };
}

/** Removes a draft and its pages; a committed stage is never touched. */
export async function abortConnectorStage(
  tx: Transaction,
  scope: ConnectorStageScope,
  id: string,
): Promise<void> {
  if (!z.uuid().safeParse(id).success) return;
  await tx
    .delete(dataConnectorStages)
    .where(
      and(
        scopeWhere(scope),
        eq(dataConnectorStages.id, id),
        isNull(dataConnectorStages.committedAt),
      ),
    );
}

/**
 * A complete stage in one transaction: begin, append and commit. The host's
 * `put` writes through the same steps in separate transactions.
 */
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
  if (!KEY.test(input.key) || !validMetadata(input.metadata))
    return fail("dataset_stage_invalid");
  const pages = prepareConnectorStagePages(input.pages, definition);
  const existing = await matchConnectorStage(tx, scope, input, definition);
  if (existing) return existing;
  const { id } = await beginConnectorStage(tx, scope, input, definition);
  await appendConnectorStagePages(tx, scope, id, pages, signal);
  return commitConnectorStage(tx, scope, id, input.metadata, signal);
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
