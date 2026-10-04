import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "./context.js";
import * as schema from "./schema.js";

// Workspace images (ADR 0015, section 5; #217), as netrics_app inside
// withWorkspace. Every query names the workspace explicitly on top of RLS.
// Metadata queries never select `content`.

export type ImageRow = Omit<
  typeof schema.workspaceImages.$inferSelect,
  "content"
>;

export interface ImageInput {
  name: string;
  contentType: string;
  width: number;
  height: number;
  sha256: string;
  content: Buffer;
  origin?: "upload" | "resource_icon";
  connectionId?: string | null;
  resourceId?: string | null;
  createdByUserId: string | null;
}

export interface ImageQuota {
  maxCount: number;
  maxBytes: number;
}

export interface ImageUsage {
  count: number;
  bytes: number;
}

const metadata = {
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
};

function imageScope(workspaceId: string, imageId: string) {
  return and(
    eq(schema.workspaceImages.workspaceId, workspaceId),
    eq(schema.workspaceImages.id, imageId),
  );
}

export async function listImages(
  tx: Transaction,
  workspaceId: string,
): Promise<ImageRow[]> {
  return tx
    .select(metadata)
    .from(schema.workspaceImages)
    .where(eq(schema.workspaceImages.workspaceId, workspaceId))
    .orderBy(desc(schema.workspaceImages.createdAt), schema.workspaceImages.id);
}

export async function findImage(
  tx: Transaction,
  workspaceId: string,
  imageId: string,
): Promise<ImageRow | null> {
  const [row] = await tx
    .select(metadata)
    .from(schema.workspaceImages)
    .where(imageScope(workspaceId, imageId))
    .limit(1);
  return row ?? null;
}

export async function readImageContent(
  tx: Transaction,
  workspaceId: string,
  imageId: string,
): Promise<Buffer | null> {
  const [row] = await tx
    .select({ content: schema.workspaceImages.content })
    .from(schema.workspaceImages)
    .where(imageScope(workspaceId, imageId))
    .limit(1);
  return row?.content ?? null;
}

export async function imageUsage(
  tx: Transaction,
  workspaceId: string,
): Promise<ImageUsage> {
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${schema.workspaceImages.bytes}), 0)::bigint`,
    })
    .from(schema.workspaceImages)
    .where(eq(schema.workspaceImages.workspaceId, workspaceId));
  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export type InsertImageResult =
  | { status: "ok"; image: ImageRow }
  | { status: "quota_exceeded"; usage: ImageUsage };

/**
 * Inserts an image if the workspace stays within its quota. A transaction
 * advisory lock per workspace serialises concurrent uploads, so two of them
 * cannot both pass the check.
 */
export async function insertImageWithinQuota(
  tx: Transaction,
  workspaceId: string,
  input: ImageInput,
  quota: ImageQuota,
): Promise<InsertImageResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`workspace_images:${workspaceId}`}, 0))`,
  );
  const usage = await imageUsage(tx, workspaceId);
  if (
    usage.count + 1 > quota.maxCount ||
    usage.bytes + input.content.length > quota.maxBytes
  ) {
    return { status: "quota_exceeded", usage };
  }
  const [row] = await tx
    .insert(schema.workspaceImages)
    .values({
      workspaceId,
      name: input.name,
      contentType: input.contentType,
      bytes: input.content.length,
      width: input.width,
      height: input.height,
      sha256: input.sha256,
      content: input.content,
      origin: input.origin ?? "upload",
      connectionId: input.connectionId ?? null,
      resourceId: input.resourceId ?? null,
      createdByUserId: input.createdByUserId,
    })
    .returning(metadata);
  if (!row) {
    throw new Error("image insert returned no row");
  }
  return { status: "ok", image: row };
}

export async function deleteImage(
  tx: Transaction,
  workspaceId: string,
  imageId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(schema.workspaceImages)
    .where(imageScope(workspaceId, imageId))
    .returning({ id: schema.workspaceImages.id });
  // The references are deferred (migration 0035); check them now, so a
  // dashboard that uses the image refuses the delete here (SQLSTATE 23503)
  // and not at commit.
  await tx.execute(sql`set constraints ${sql.raw(IMAGE_REFERENCES)} immediate`);
  await tx.execute(sql`set constraints ${sql.raw(IMAGE_REFERENCES)} deferred`);
  return rows.length === 1;
}

const IMAGE_REFERENCES = [
  "dashboards_logo_image_fk",
  "dashboard_slides_background_image_fk",
  "dashboard_widgets_image_fk",
].join(", ");

/** Which of `imageIds` are images of the workspace. */
export async function findImageIds(
  tx: Transaction,
  workspaceId: string,
  imageIds: readonly string[],
): Promise<Set<string>> {
  if (imageIds.length === 0) {
    return new Set();
  }
  const rows = await tx
    .select({ id: schema.workspaceImages.id })
    .from(schema.workspaceImages)
    .where(
      and(
        eq(schema.workspaceImages.workspaceId, workspaceId),
        inArray(schema.workspaceImages.id, [...imageIds]),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * The dashboards that use an image: as logo, slide background or in an
 * image widget, on any slide.
 */
export async function findImageUsers(
  tx: Transaction,
  workspaceId: string,
  imageId: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await tx.execute<{ id: string; name: string }>(sql`
    select d.id, d.name from dashboards d
    where d.workspace_id = ${workspaceId}
      and (
        d.logo_image_id = ${imageId}
        or exists (
          select 1 from dashboard_slides s
          where s.workspace_id = ${workspaceId} and s.dashboard_id = d.id
            and s.background_image_id = ${imageId})
        or exists (
          select 1 from dashboard_widgets w
          where w.workspace_id = ${workspaceId} and w.dashboard_id = d.id
            and w.image_id = ${imageId}))
    order by d.name, d.id`);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/**
 * The image, if the device's assigned dashboard shows it: as logo, as the
 * background of an enabled slide or in an image widget on one. Anything
 * else is null, so a device credential cannot read other images.
 */
export async function findDeviceImage(
  tx: Transaction,
  workspaceId: string,
  deviceId: string,
  imageId: string,
): Promise<ImageRow | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    select i.id from workspace_images i
    join devices dv
      on dv.workspace_id = ${workspaceId} and dv.id = ${deviceId}
         and dv.revoked_at is null and dv.dashboard_id is not null
    join dashboards d
      on d.workspace_id = ${workspaceId} and d.id = dv.dashboard_id
    where i.workspace_id = ${workspaceId} and i.id = ${imageId}
      and (
        d.logo_image_id = i.id
        or exists (
          select 1 from dashboard_slides s
          where s.workspace_id = ${workspaceId} and s.dashboard_id = d.id
            and s.enabled and s.background_image_id = i.id)
        or exists (
          select 1 from dashboard_widgets w
          join dashboard_slides s
            on s.workspace_id = ${workspaceId} and s.id = w.slide_id
          where w.workspace_id = ${workspaceId} and w.dashboard_id = d.id
            and s.enabled and w.image_id = i.id))
    limit 1`);
  return rows.length === 1 ? findImage(tx, workspaceId, imageId) : null;
}
