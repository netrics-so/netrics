import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import {
  DATASET_LIMITS,
  datasetRecordKey,
  datasetPartitionMatches,
  datasetRetentionDays,
  sourceDatasetSchema,
  validateDatasetPage,
  type DatasetPage,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import type { Db, Transaction } from "./context.js";
import {
  connections,
  dataDatasets,
  dataSchemaVersions,
  dataRefreshes,
  dataPages,
  dataGenerations,
  dataRecords,
} from "./schema.js";

export class DatasetStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DatasetStoreError";
  }
}
const fail = (code: string): never => {
  throw new DatasetStoreError(code);
};
const DAY = 86_400_000;
/** Canonical structural digest; never expose raw records through errors. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function compatible(
  before: SourceDatasetDefinition,
  after: SourceDatasetDefinition,
): boolean {
  if (
    before.retentionDays !== after.retentionDays ||
    before.fields.some((old) => {
      const next = after.fields.find((f) => f.id === old.id);
      return (
        next &&
        (old.classification !== next.classification ||
          old.retentionDays !== next.retentionDays)
      );
    })
  )
    return false;
  if (after.mode === "snapshot") return true;
  if (
    stable(before.keyFields) !== stable(after.keyFields) ||
    before.mode !== after.mode ||
    before.reportingField !== after.reportingField ||
    before.reportingTimeZone !== after.reportingTimeZone
  )
    return false;
  const next = new Map(after.fields.map((f) => [f.id, f]));
  if (
    !before.fields.every((field) => {
      const f = next.get(field.id);
      return (
        f &&
        f.type === field.type &&
        f.unit === field.unit &&
        f.scale === field.scale &&
        f.currencyField === field.currencyField &&
        (f.nullable || !field.nullable)
      );
    })
  )
    return false;
  return after.fields.every(
    (field) => before.fields.some((f) => f.id === field.id) || field.nullable,
  );
}

/** Register under the tenant transaction; serialize ingestion for this dataset. */
async function register(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  definition: SourceDatasetDefinition,
) {
  const [connection] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.workspaceId, workspaceId),
      ),
    );
  if (!connection) fail("dataset_connection_not_found");
  await tx
    .insert(dataDatasets)
    .values({
      workspaceId,
      connectionId,
      key: definition.key,
      name: definition.name,
    })
    .onConflictDoNothing();
  const [dataset] = await tx
    .select()
    .from(dataDatasets)
    .where(
      and(
        eq(dataDatasets.workspaceId, workspaceId),
        eq(dataDatasets.connectionId, connectionId),
        eq(dataDatasets.key, definition.key),
      ),
    )
    .for("update");
  if (!dataset) return fail("dataset_not_found");
  const [latest] = await tx
    .select()
    .from(dataSchemaVersions)
    .where(
      and(
        eq(dataSchemaVersions.workspaceId, workspaceId),
        eq(dataSchemaVersions.datasetId, dataset.id),
      ),
    )
    .orderBy(desc(dataSchemaVersions.version))
    .limit(1);
  const [existing] = await tx
    .select()
    .from(dataSchemaVersions)
    .where(
      and(
        eq(dataSchemaVersions.workspaceId, workspaceId),
        eq(dataSchemaVersions.datasetId, dataset.id),
        eq(dataSchemaVersions.version, definition.version),
      ),
    );
  if (existing && stable(existing.definition) !== stable(definition))
    fail("dataset_schema_version_conflict");
  if (!existing) {
    if (
      latest &&
      (definition.version <= latest.version ||
        !compatible(sourceDatasetSchema.parse(latest.definition), definition))
    )
      fail("dataset_schema_incompatible");
    await tx.insert(dataSchemaVersions).values({
      workspaceId,
      datasetId: dataset.id,
      version: definition.version,
      definition,
    });
  }
  return dataset;
}

export interface IngestDatasetPageInput {
  workspaceId: string;
  connectionId: string;
  definition: SourceDatasetDefinition;
  page: DatasetPage;
  now?: Date;
  /** Host-only replay provenance; never extend a retained source deadline. */
  retainedSource?: { collectedAt: Date; expiresAt: Date };
  /** Host operational policy may lower the hard transport/storage ceiling. */
  maxWorkspaceBytes?: number;
}

/** Page + checkpoint callers share one transaction. No generation until complete. */
async function ingestPage(
  tx: Transaction,
  input: IngestDatasetPageInput,
): Promise<{
  datasetId: string;
  generationId: string | null;
  replayed: boolean;
}> {
  const quota = input.maxWorkspaceBytes ?? DATASET_LIMITS.workspaceBytes;
  if (
    !Number.isSafeInteger(quota) ||
    quota < 1 ||
    quota > DATASET_LIMITS.workspaceBytes
  )
    return fail("dataset_quota_invalid");
  const definitionResult = sourceDatasetSchema.safeParse(input.definition);
  if (!definitionResult.success) return fail("dataset_schema_invalid");
  const definition = definitionResult.data;
  let page: DatasetPage;
  try {
    page = validateDatasetPage(definition, input.page);
  } catch {
    return fail("dataset_page_invalid");
  }
  const { workspaceId, connectionId } = input;
  const now = input.now ?? new Date();
  const retentionDays = datasetRetentionDays(definition);
  const sourceCollectedAt = input.retainedSource?.collectedAt ?? now;
  const expiresAt = new Date(
    Math.min(
      sourceCollectedAt.getTime() + retentionDays * DAY,
      input.retainedSource?.expiresAt.getTime() ?? Infinity,
    ),
  );
  if (expiresAt <= now || sourceCollectedAt > now)
    return fail("dataset_replay_unavailable");
  await tx.execute(sql`set local statement_timeout = '15s'`);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 440))`,
  );
  const dataset = await register(tx, workspaceId, connectionId, definition);
  await tx
    .insert(dataRefreshes)
    .values({
      workspaceId,
      datasetId: dataset.id,
      schemaVersion: definition.version,
      refreshKey: page.refreshKey,
      replacementWindow: page.window ?? null,
      sourceCollectedAt,
      expiresAt,
      createdAt: now,
    })
    .onConflictDoNothing();
  const [refresh] = await tx
    .select()
    .from(dataRefreshes)
    .where(
      and(
        eq(dataRefreshes.workspaceId, workspaceId),
        eq(dataRefreshes.datasetId, dataset.id),
        eq(dataRefreshes.refreshKey, page.refreshKey),
      ),
    )
    .for("update");
  if (!refresh) return fail("dataset_refresh_not_found");
  if (refresh.expiresAt <= now) fail("dataset_refresh_expired");
  if (
    refresh.schemaVersion !== definition.version ||
    stable(refresh.replacementWindow) !== stable(page.window ?? null)
  )
    fail("dataset_refresh_conflict");
  const digest = createHash("sha256").update(stable(page)).digest("hex");
  const [existing] = await tx
    .select()
    .from(dataPages)
    .where(
      and(
        eq(dataPages.workspaceId, workspaceId),
        eq(dataPages.refreshId, refresh.id),
        eq(dataPages.pageKey, page.pageKey),
      ),
    );
  if (existing) {
    if (existing.digest !== digest) fail("dataset_page_conflict");
    const [generation] = await tx
      .select({ id: dataGenerations.id })
      .from(dataGenerations)
      .where(
        and(
          eq(dataGenerations.workspaceId, workspaceId),
          eq(dataGenerations.datasetId, dataset.id),
          eq(dataGenerations.refreshKey, page.refreshKey),
        ),
      );
    return {
      datasetId: dataset.id,
      generationId: generation?.id ?? null,
      replayed: true,
    };
  }
  if (refresh.complete) fail("dataset_refresh_already_complete");
  if (refresh.lastPageKey !== page.previousPageKey)
    fail("dataset_page_out_of_order");
  if (
    refresh.pageCount >= DATASET_LIMITS.pages ||
    refresh.rowCount + page.records.length > DATASET_LIMITS.rows
  )
    fail("dataset_refresh_limit");
  await tx.insert(dataPages).values({
    workspaceId,
    refreshId: refresh.id,
    pageKey: page.pageKey,
    sequence: refresh.pageCount + 1,
    digest,
    payload: page,
  });
  await tx
    .update(dataRefreshes)
    .set({
      lastPageKey: page.pageKey,
      pageCount: refresh.pageCount + 1,
      rowCount: refresh.rowCount + page.records.length,
      complete: page.complete,
    })
    .where(
      and(
        eq(dataRefreshes.id, refresh.id),
        eq(dataRefreshes.workspaceId, workspaceId),
      ),
    );
  if (!page.complete) {
    const [usage] = await tx.execute<{ bytes: string }>(
      sql`select (coalesce((select sum(octet_length(payload::text) + 256) from data_pages where workspace_id = ${workspaceId}),0) + coalesce((select sum(octet_length("values"::text) + octet_length(record_key) + 128) from data_records where workspace_id = ${workspaceId}),0))::text as bytes`,
    );
    if (Number(usage?.bytes ?? 0) > quota) fail("dataset_workspace_quota");
    return { datasetId: dataset.id, generationId: null, replayed: false };
  }

  const [previous] = await tx
    .select()
    .from(dataGenerations)
    .where(
      and(
        eq(dataGenerations.workspaceId, workspaceId),
        eq(dataGenerations.datasetId, dataset.id),
      ),
    )
    .orderBy(desc(dataGenerations.sequence))
    .limit(1);
  if (
    previous &&
    (previous.sourceStartedAt > refresh.createdAt ||
      previous.schemaVersion > definition.version)
  )
    fail("dataset_refresh_superseded");
  type Row = {
    values: Record<string, unknown>;
    collectedAt: Date;
    expiresAt: Date;
  };
  const rows = new Map<string, Row>();
  if (previous && definition.mode !== "snapshot") {
    const old = await tx
      .select()
      .from(dataRecords)
      .where(
        and(
          eq(dataRecords.workspaceId, workspaceId),
          eq(dataRecords.generationId, previous.id),
          gt(dataRecords.expiresAt, now),
        ),
      )
      .limit(DATASET_LIMITS.rows + 1);
    if (old.length > DATASET_LIMITS.rows) fail("dataset_generation_limit");
    for (const row of old) {
      const values = { ...(row.values as Record<string, unknown>) };
      for (const field of definition.fields)
        if (!Object.hasOwn(values, field.id) && field.nullable)
          values[field.id] = null;
      const expiry = new Date(
        Math.min(
          row.expiresAt.getTime(),
          row.collectedAt.getTime() + retentionDays * DAY,
        ),
      );
      if (expiry <= now) continue;
      if (page.window) {
        const time = values[definition.reportingField!] as string;
        const instant =
          definition.fields.find(
            (field) => field.id === definition.reportingField,
          )?.type === "timestamp";
        if (
          (instant
            ? Date.parse(time) >= Date.parse(page.window.from)
            : time >= page.window.from) &&
          (instant
            ? Date.parse(time) < Date.parse(page.window.toExclusive)
            : time < page.window.toExclusive) &&
          datasetPartitionMatches(definition, values, page.window.partition)
        )
          continue;
      }
      rows.set(row.recordKey, {
        values,
        collectedAt: row.collectedAt,
        expiresAt: expiry,
      });
    }
  }
  const pages = await tx
    .select()
    .from(dataPages)
    .where(
      and(
        eq(dataPages.workspaceId, workspaceId),
        eq(dataPages.refreshId, refresh.id),
      ),
    )
    .orderBy(asc(dataPages.sequence))
    .limit(DATASET_LIMITS.pages);
  if (
    pages.length !== refresh.pageCount + 1 ||
    pages.some((entry, index) => entry.sequence !== index + 1)
  )
    fail("dataset_refresh_incomplete");
  const seen = new Map<string, string>();
  for (const staged of pages) {
    const payload = staged.payload as DatasetPage;
    for (const record of payload.records) {
      const key = datasetRecordKey(definition, record.values);
      const signature = stable(record);
      if (seen.has(key) && seen.get(key) !== signature)
        fail("dataset_record_identity_conflict");
      seen.set(key, signature);
      if (record.deleted) {
        rows.delete(key);
        continue;
      }
      const old = rows.get(key);
      if (
        definition.mode === "append" &&
        old &&
        stable(old.values) !== stable(record.values)
      )
        fail("dataset_append_identity_conflict");
      if (definition.mode === "append" && old) continue;
      rows.set(key, {
        values: record.values,
        collectedAt: refresh.sourceCollectedAt,
        expiresAt: refresh.expiresAt,
      });
    }
  }
  if (rows.size > DATASET_LIMITS.rows) fail("dataset_generation_limit");
  let bytes = 0;
  let generationExpiresAt = expiresAt;
  for (const row of rows.values()) {
    bytes += Buffer.byteLength(JSON.stringify(row.values));
    if (row.expiresAt > generationExpiresAt)
      generationExpiresAt = row.expiresAt;
  }
  if (bytes > DATASET_LIMITS.generationBytes) fail("dataset_generation_limit");
  const [generation] = await tx
    .insert(dataGenerations)
    .values({
      workspaceId,
      datasetId: dataset.id,
      schemaVersion: definition.version,
      refreshKey: page.refreshKey,
      sequence: (previous?.sequence ?? 0) + 1,
      rowCount: rows.size,
      expiresAt: generationExpiresAt,
      createdAt: now,
      sourceStartedAt: refresh.createdAt,
    })
    .returning();
  if (!generation) return fail("dataset_generation_not_created");
  const entries = [...rows].map(([recordKey, row]) => ({
    generationId: generation.id,
    workspaceId,
    recordKey,
    ...row,
  }));
  for (let offset = 0; offset < entries.length; offset += 1000)
    await tx.insert(dataRecords).values(entries.slice(offset, offset + 1000));
  const [usage] = await tx.execute<{ bytes: string }>(
    sql`select (coalesce((select sum(octet_length(payload::text) + 256) from data_pages where workspace_id = ${workspaceId}),0) + coalesce((select sum(octet_length("values"::text) + octet_length(record_key) + 128) from data_records where workspace_id = ${workspaceId}),0))::text as bytes`,
  );
  if (Number(usage?.bytes ?? 0) > quota) fail("dataset_workspace_quota");
  return {
    datasetId: dataset.id,
    generationId: generation.id,
    replayed: false,
  };
}

/** Bounded authorized preview. A requested generation never falls back to latest. */
export async function previewDataset(
  tx: Transaction,
  input: {
    workspaceId: string;
    datasetId: string;
    generationId?: string;
    limit?: number;
    now?: Date;
  },
) {
  const limit = input.limit ?? DATASET_LIMITS.previewRows;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > DATASET_LIMITS.previewRows
  )
    return fail("dataset_preview_limit");
  const now = input.now ?? new Date();
  const [generation] = await tx
    .select()
    .from(dataGenerations)
    .where(
      and(
        eq(dataGenerations.workspaceId, input.workspaceId),
        eq(dataGenerations.datasetId, input.datasetId),
        ...(input.generationId
          ? [eq(dataGenerations.id, input.generationId)]
          : []),
      ),
    )
    .orderBy(desc(dataGenerations.sequence))
    .limit(1);
  if (!generation || generation.expiresAt <= now) return null;
  const rows = await tx
    .select({ values: dataRecords.values })
    .from(dataRecords)
    .where(
      and(
        eq(dataRecords.workspaceId, input.workspaceId),
        eq(dataRecords.generationId, generation.id),
        gt(dataRecords.expiresAt, now),
      ),
    )
    .orderBy(asc(dataRecords.recordKey))
    .limit(limit);
  return {
    generation,
    rows: rows.map((row) => row.values as Record<string, unknown>),
  };
}

/** Hide driver SQL/parameters from worker logs and API error paths. */
export async function ingestDatasetPage(
  tx: Transaction,
  input: IngestDatasetPageInput,
) {
  try {
    return await ingestPage(tx, input);
  } catch (error) {
    if (error instanceof DatasetStoreError) throw error;
    throw new DatasetStoreError("dataset_storage_failed");
  }
}

/** Scheduler-only bounded maintenance; no raw records are returned to its role. */
export async function pruneDatasetHistory(
  db: Db | Transaction,
  now = new Date(),
  batch = 10_000,
): Promise<number> {
  if (!Number.isInteger(batch) || batch < 1 || batch > 10_000)
    return fail("dataset_prune_limit");
  const [row] = await db.execute<{ deleted: number }>(
    sql`select prune_dataset_history(${now.toISOString()}::timestamptz, ${batch}) as deleted`,
  );
  return row?.deleted ?? 0;
}

/** Legacy values remain aggregated facts; no fabricated raw events or loss of dimensions. */
export async function listObservationDatasets(
  tx: Transaction,
  workspaceId: string,
) {
  const rows = await tx.execute<{
    connection_id: string;
    metric_id: string;
    key: string;
    name: string;
    kind: string;
    unit: string;
    granularity: string;
    dimensions: string[];
  }>(sql`select c.id as connection_id,m.id as metric_id,m.key,m.name,m.kind,m.unit,m.granularity,m.dimensions
    from connections c join metric_definitions m on m.connector_id=c.connector_id
    where c.workspace_id=${workspaceId} order by c.id,m.key limit 1001`);
  if (rows.length > 1000) return fail("dataset_catalog_limit");
  return rows.map((row) => ({
    id: `observation:${row.connection_id}:${row.metric_id}`,
    connectionId: row.connection_id,
    metricDefinitionId: row.metric_id,
    aggregated: true as const,
    retentionManagedBy: "legacy-observations" as const,
    kind: row.kind,
    unit: row.unit,
    granularity: row.granularity,
    definition: sourceDatasetSchema.parse({
      key: `observation.${row.metric_id}`,
      name: row.name,
      version: 1,
      grain: `one ${row.granularity} ${row.kind} observation per dimension combination`,
      mode: "upsert",
      keyFields: ["time", "series"],
      reportingField: "time",
      ...(row.granularity === "day" ? {} : { reportingTimeZone: "UTC" }),
      fields: [
        {
          id: "series",
          name: "Series identity",
          type: "string",
          nullable: false,
          classification: "internal",
        },
        {
          id: "time",
          name: "Reporting time",
          type: row.granularity === "day" ? "date" : "timestamp",
          nullable: false,
          classification: "internal",
        },
        {
          id: "value",
          name: row.name,
          type: "number",
          nullable: false,
          classification: "internal",
        },
        ...row.dimensions.map((d) => ({
          id: "dimension." + createHash("sha256").update(d).digest("hex"),
          name: d,
          type: "string",
          nullable: true,
          classification: "internal",
        })),
      ],
    }),
  }));
}

/** Rebuild a retained refresh without another network call. Bounded and tenant scoped. */
export async function replayDatasetRefresh(
  tx: Transaction,
  input: {
    workspaceId: string;
    datasetId: string;
    sourceRefreshKey: string;
    newRefreshKey: string;
    now?: Date;
  },
) {
  if (input.sourceRefreshKey === input.newRefreshKey)
    return fail("dataset_replay_key_conflict");
  const now = input.now ?? new Date();
  const [source] = await tx
    .select({
      refresh: dataRefreshes,
      dataset: dataDatasets,
      version: dataSchemaVersions,
    })
    .from(dataRefreshes)
    .innerJoin(
      dataDatasets,
      and(
        eq(dataDatasets.id, dataRefreshes.datasetId),
        eq(dataDatasets.workspaceId, dataRefreshes.workspaceId),
      ),
    )
    .innerJoin(
      dataSchemaVersions,
      and(
        eq(dataSchemaVersions.datasetId, dataRefreshes.datasetId),
        eq(dataSchemaVersions.workspaceId, dataRefreshes.workspaceId),
        eq(dataSchemaVersions.version, dataRefreshes.schemaVersion),
      ),
    )
    .where(
      and(
        eq(dataRefreshes.workspaceId, input.workspaceId),
        eq(dataRefreshes.datasetId, input.datasetId),
        eq(dataRefreshes.refreshKey, input.sourceRefreshKey),
      ),
    )
    .for("update", { of: dataRefreshes });
  if (!source || !source.refresh.complete || source.refresh.expiresAt <= now)
    return fail("dataset_replay_unavailable");
  const pages = await tx
    .select()
    .from(dataPages)
    .where(
      and(
        eq(dataPages.workspaceId, input.workspaceId),
        eq(dataPages.refreshId, source.refresh.id),
      ),
    )
    .orderBy(asc(dataPages.sequence))
    .limit(DATASET_LIMITS.pages);
  if (pages.length !== source.refresh.pageCount)
    return fail("dataset_replay_unavailable");
  let result: {
    datasetId: string;
    generationId: string | null;
    replayed: boolean;
  } | null = null;
  for (const p of pages)
    result = await ingestDatasetPage(tx, {
      workspaceId: input.workspaceId,
      connectionId: source.dataset.connectionId,
      definition: sourceDatasetSchema.parse(source.version.definition),
      page: { ...(p.payload as DatasetPage), refreshKey: input.newRefreshKey },
      now,
      retainedSource: {
        collectedAt: source.refresh.sourceCollectedAt,
        expiresAt: source.refresh.expiresAt,
      },
    });
  return result;
}

/** Read existing observation facts through the dataset shape, without re-ingestion. */
export async function readObservationDataset(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    metricDefinitionId: string;
    from: Date;
    toExclusive: Date;
    limit?: number;
  },
) {
  const limit = input.limit ?? DATASET_LIMITS.previewRows;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > DATASET_LIMITS.rows ||
    !Number.isFinite(input.from.getTime()) ||
    !Number.isFinite(input.toExclusive.getTime()) ||
    input.from >= input.toExclusive ||
    input.toExclusive.getTime() - input.from.getTime() > 3660 * DAY
  )
    return fail("dataset_observation_query_invalid");
  const dataset = (await listObservationDatasets(tx, input.workspaceId)).find(
    (d) =>
      d.connectionId === input.connectionId &&
      d.metricDefinitionId === input.metricDefinitionId,
  );
  if (!dataset) return null;
  const found = await tx.execute<{
    value: number;
    dimensions: Record<string, string>;
    source_timestamp: Date;
    series_key: string;
  }>(
    sql`select value,dimensions,source_timestamp,series_key from observations where workspace_id=${input.workspaceId} and connection_id=${input.connectionId} and metric_definition_id=${input.metricDefinitionId} and source_timestamp >= ${input.from.toISOString()}::timestamptz and source_timestamp < ${input.toExclusive.toISOString()}::timestamptz order by source_timestamp,series_key limit ${limit + 1}`,
  );
  return {
    dataset,
    truncated: found.length > limit,
    rows: found.slice(0, limit).map((row) => {
      const at = new Date(row.source_timestamp).toISOString();
      const values: Record<string, unknown> = {
        time: dataset.granularity === "day" ? at.slice(0, 10) : at,
        series: row.series_key,
        value: row.value,
      };
      for (const field of dataset.definition.fields)
        if (field.id.startsWith("dimension."))
          values[field.id] = row.dimensions[field.name] ?? null;
      return values;
    }),
  };
}
