import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import type { ImageRow } from "./images.js";
import * as schema from "./schema.js";

// Custom API item images (milestone 13, issue #809), as netrics_app inside
// withWorkspace: the lookup from an item image URL (its SHA-256) to the
// stored image, and the last outcome per stream. Every query names the
// workspace explicitly on top of RLS. Pruning runs as the scheduler.

/** Lookup rows unseen this long are deleted with their unreferenced images. */
export const CUSTOM_API_IMAGE_GRACE_DAYS = 7;

/** An item image URL that resolved to a stored image. */
export interface ItemImageRef {
  urlSha256: string;
  imageId: string;
  sha256: string;
  width: number;
  height: number;
  bytes: number;
  contentType: string;
}

/** The stored images of those of `urlSha256s` the workspace has seen. */
export async function findItemImages(
  tx: Transaction,
  workspaceId: string,
  urlSha256s: readonly string[],
): Promise<Map<string, ItemImageRef>> {
  if (urlSha256s.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({
      urlSha256: schema.customApiItemImages.urlSha256,
      imageId: schema.workspaceImages.id,
      sha256: schema.workspaceImages.sha256,
      width: schema.workspaceImages.width,
      height: schema.workspaceImages.height,
      bytes: schema.workspaceImages.bytes,
      contentType: schema.workspaceImages.contentType,
    })
    .from(schema.customApiItemImages)
    .innerJoin(
      schema.workspaceImages,
      and(
        eq(schema.workspaceImages.workspaceId, workspaceId),
        eq(schema.workspaceImages.id, schema.customApiItemImages.imageId),
      ),
    )
    .where(
      and(
        eq(schema.customApiItemImages.workspaceId, workspaceId),
        inArray(schema.customApiItemImages.urlSha256, [...urlSha256s]),
      ),
    );
  return new Map(rows.map((row) => [row.urlSha256, row]));
}

/** Marks the lookups as still among a stream's newest items. */
export async function touchItemImages(
  tx: Transaction,
  workspaceId: string,
  urlSha256s: readonly string[],
  now: Date,
): Promise<void> {
  if (urlSha256s.length === 0) {
    return;
  }
  await tx
    .update(schema.customApiItemImages)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(schema.customApiItemImages.workspaceId, workspaceId),
        inArray(schema.customApiItemImages.urlSha256, [...urlSha256s]),
      ),
    );
}

/**
 * Insert-or-update on (workspace_id, url_sha256): the last writer's image
 * wins and last_seen_at becomes `now`. Two concurrent upserts of one URL
 * leave one row; the losing image is unreferenced and pruned later.
 */
export async function upsertItemImage(
  tx: Transaction,
  workspaceId: string,
  input: { urlSha256: string; imageId: string; now: Date },
): Promise<void> {
  await tx
    .insert(schema.customApiItemImages)
    .values({
      workspaceId,
      urlSha256: input.urlSha256,
      imageId: input.imageId,
      createdAt: input.now,
      lastSeenAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        schema.customApiItemImages.workspaceId,
        schema.customApiItemImages.urlSha256,
      ],
      set: { imageId: input.imageId, lastSeenAt: input.now },
    });
}

/** A stored item image with these bytes (content SHA-256), if any. */
export async function findCustomApiImageBySha256(
  tx: Transaction,
  workspaceId: string,
  sha256: string,
): Promise<ImageRow | null> {
  const [row] = await tx
    .select({
      id: schema.workspaceImages.id,
      workspaceId: schema.workspaceImages.workspaceId,
      name: schema.workspaceImages.name,
      contentType: schema.workspaceImages.contentType,
      bytes: schema.workspaceImages.bytes,
      width: schema.workspaceImages.width,
      height: schema.workspaceImages.height,
      sha256: schema.workspaceImages.sha256,
      origin: schema.workspaceImages.origin,
      connectionId: schema.workspaceImages.connectionId,
      resourceId: schema.workspaceImages.resourceId,
      createdByUserId: schema.workspaceImages.createdByUserId,
      createdAt: schema.workspaceImages.createdAt,
    })
    .from(schema.workspaceImages)
    .where(
      and(
        eq(schema.workspaceImages.workspaceId, workspaceId),
        eq(schema.workspaceImages.origin, "custom_api"),
        eq(schema.workspaceImages.sha256, sha256),
      ),
    )
    .orderBy(schema.workspaceImages.createdAt, schema.workspaceImages.id)
    .limit(1);
  return row ?? null;
}

export interface StreamImagesRecord {
  streamKey: string;
  checkedAt: Date;
  stored: number;
  unchanged: number;
  skipped: number;
  skippedReasons: Record<string, number>;
}

/** Replaces the stream's last outcome. */
export async function recordStreamImages(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    streamKey: string;
    checkedAt: Date;
    stored: number;
    unchanged: number;
    skipped: number;
    skippedReasons: Partial<Record<string, number>>;
  },
): Promise<void> {
  const values = {
    checkedAt: input.checkedAt,
    stored: input.stored,
    unchanged: input.unchanged,
    skipped: input.skipped,
    skippedReasons: input.skippedReasons,
  };
  await tx
    .insert(schema.customApiStreamImages)
    .values({
      workspaceId: input.workspaceId,
      connectionId: input.connectionId,
      streamKey: input.streamKey,
      ...values,
    })
    .onConflictDoUpdate({
      target: [
        schema.customApiStreamImages.connectionId,
        schema.customApiStreamImages.streamKey,
      ],
      set: values,
      // The connection belongs to one workspace; never touch another's row.
      setWhere: eq(schema.customApiStreamImages.workspaceId, input.workspaceId),
    });
}

/** The last outcome of each image stream of the connection, by stream key. */
export async function listStreamImages(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<StreamImagesRecord[]> {
  const rows = await tx
    .select({
      streamKey: schema.customApiStreamImages.streamKey,
      checkedAt: schema.customApiStreamImages.checkedAt,
      stored: schema.customApiStreamImages.stored,
      unchanged: schema.customApiStreamImages.unchanged,
      skipped: schema.customApiStreamImages.skipped,
      skippedReasons: schema.customApiStreamImages.skippedReasons,
    })
    .from(schema.customApiStreamImages)
    .where(
      and(
        eq(schema.customApiStreamImages.workspaceId, workspaceId),
        eq(schema.customApiStreamImages.connectionId, connectionId),
      ),
    )
    .orderBy(schema.customApiStreamImages.streamKey);
  return rows.map((row) => ({
    ...row,
    skippedReasons: (row.skippedReasons ?? {}) as Record<string, number>,
  }));
}

/** Longest URL considered; longer values are not image links worth a fetch. */
const MAX_VALUE_LENGTH = 2048;

/**
 * The newest `limit` non-null string values of `valueField`, by `orderField`
 * descending, from the dataset's latest unexpired generation; distinct, in
 * that order. Reads like `previewDataset`. ISO dates and timestamps order
 * correctly as text.
 */
export async function latestDatasetValues(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    datasetKey: string;
    valueField: string;
    orderField: string;
    limit: number;
    now: Date;
  },
): Promise<string[]> {
  if (input.limit < 1) {
    return [];
  }
  const now = input.now.toISOString();
  const rows = await tx.execute<{ value: string }>(sql`
    with generation as (
      select g.id, g.expires_at from data_generations g
      join data_datasets d
        on d.workspace_id = ${input.workspaceId} and d.id = g.dataset_id
      where g.workspace_id = ${input.workspaceId}
        and d.connection_id = ${input.connectionId}
        and d.key = ${input.datasetKey}
      order by g.sequence desc
      limit 1
    ),
    ranked as (
      select r.values ->> ${input.valueField} as value,
             r.values ->> ${input.orderField} as ordered,
             r.record_key
      from data_records r
      join generation g on g.id = r.generation_id
      where r.workspace_id = ${input.workspaceId}
        and (g.expires_at is null or g.expires_at > ${now}::timestamptz)
        and (r.expires_at is null or r.expires_at > ${now}::timestamptz)
        and jsonb_typeof(r.values -> ${input.valueField}) = 'string'
        and char_length(r.values ->> ${input.valueField}) <= ${MAX_VALUE_LENGTH}
    ),
    firsts as (
      select distinct on (value) value, ordered, record_key from ranked
      order by value, ordered desc nulls last, record_key
    )
    select value from firsts
    order by ordered desc nulls last, record_key
    limit ${input.limit}`);
  return rows.map((row) => row.value);
}

/** Bounds of one prune run: passes and wall time. */
export interface PruneLimits {
  /** Default 50. */
  maxPasses?: number;
  /** Default 60 s; checked between passes. */
  maxMs?: number;
}

/**
 * Deletes lookups unseen for `graceDays` as of `now`, then custom_api images
 * no lookup refers to (older than an hour, and named by no dashboard), in
 * passes of at most `batch` of each (scheduler role;
 * prune_custom_api_item_images is SECURITY DEFINER). Passes repeat while a
 * pass fills a batch, so expiring signed URLs cannot outgrow the hourly
 * maintenance, up to `limits`. Returns the rows deleted.
 */
export async function pruneCustomApiItemImages(
  schedulerDb: Db | Transaction,
  now: Date,
  graceDays: number = CUSTOM_API_IMAGE_GRACE_DAYS,
  batch = 10_000,
  limits: PruneLimits = {},
): Promise<number> {
  const maxPasses = limits.maxPasses ?? 50;
  const deadline = Date.now() + (limits.maxMs ?? 60_000);
  let deleted = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const [row] = await schedulerDb.execute<{
      lookups: number;
      images: number;
    }>(
      sql`select lookups, images from prune_custom_api_item_images(
            ${now.toISOString()}::timestamptz,
            make_interval(days => ${graceDays}),
            ${batch}
          )`,
    );
    const lookups = row?.lookups ?? 0;
    const images = row?.images ?? 0;
    deleted += lookups + images;
    if ((lookups < batch && images < batch) || Date.now() >= deadline) break;
  }
  return deleted;
}
