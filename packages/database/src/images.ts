import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

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
  origin?: "upload" | "resource_icon" | "custom_api";
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

/**
 * Which quota an image counts against. "library": uploads and resource
 * icons (ADR 0015); "custom_api": custom API item images (milestone 13),
 * a quota of their own that neither side's images count against.
 */
export type ImageQuotaScope = "library" | "custom_api";

function scopeOf(origin: ImageInput["origin"]): ImageQuotaScope {
  return origin === "custom_api" ? "custom_api" : "library";
}

function inScope(scope: ImageQuotaScope) {
  return scope === "custom_api"
    ? eq(schema.workspaceImages.origin, "custom_api")
    : ne(schema.workspaceImages.origin, "custom_api");
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

/** The workspace's image library: uploads and icons, never item images. */
export async function listImages(
  tx: Transaction,
  workspaceId: string,
): Promise<ImageRow[]> {
  return tx
    .select(metadata)
    .from(schema.workspaceImages)
    .where(
      and(
        eq(schema.workspaceImages.workspaceId, workspaceId),
        inScope("library"),
      ),
    )
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
  scope: ImageQuotaScope = "library",
): Promise<ImageUsage> {
  const [row] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      bytes: sql<number>`coalesce(sum(${schema.workspaceImages.bytes}), 0)::bigint`,
    })
    .from(schema.workspaceImages)
    .where(
      and(eq(schema.workspaceImages.workspaceId, workspaceId), inScope(scope)),
    );
  return { count: Number(row?.count ?? 0), bytes: Number(row?.bytes ?? 0) };
}

export type InsertImageResult =
  | { status: "ok"; image: ImageRow }
  | { status: "quota_exceeded"; usage: ImageUsage };

/**
 * Inserts an image if the workspace stays within the quota of the image's
 * scope (its origin). A transaction advisory lock per workspace and scope
 * serialises concurrent inserts, so two of them cannot both pass the check.
 */
export async function insertImageWithinQuota(
  tx: Transaction,
  workspaceId: string,
  input: ImageInput,
  quota: ImageQuota,
): Promise<InsertImageResult> {
  const scope = scopeOf(input.origin);
  // The library keeps its lock key from before item images existed.
  const lock =
    scope === "library"
      ? `workspace_images:${workspaceId}`
      : `workspace_images:${workspaceId}:${scope}`;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`,
  );
  const usage = await imageUsage(tx, workspaceId, scope);
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
  "dashboard_slides_logo_image_fk",
  "dashboard_widgets_image_fk",
].join(", ");

/**
 * Which of `imageIds` are library images of the workspace. Item images
 * (origin custom_api) are not: a dashboard cannot name one as a logo,
 * background or image widget, since garbage collection deletes them.
 */
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
        inScope("library"),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/** The metadata of those of `imageIds` that are images of the workspace. */
export async function findImages(
  tx: Transaction,
  workspaceId: string,
  imageIds: readonly string[],
): Promise<ImageRow[]> {
  if (imageIds.length === 0) {
    return [];
  }
  return tx
    .select(metadata)
    .from(schema.workspaceImages)
    .where(
      and(
        eq(schema.workspaceImages.workspaceId, workspaceId),
        inArray(schema.workspaceImages.id, [...imageIds]),
      ),
    );
}

/**
 * The dashboards that use an image: as logo, slide logo, slide background
 * or in an image widget, on any slide.
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
            and (s.background_image_id = ${imageId}
              or s.logo_image_id = ${imageId}))
        or exists (
          select 1 from dashboard_widgets w
          where w.workspace_id = ${workspaceId} and w.dashboard_id = d.id
            and w.image_id = ${imageId}))
    order by d.name, d.id`);
  return rows.map((row) => ({ id: row.id, name: row.name }));
}

/**
 * The image, if the device's assigned dashboard shows it: as logo, as the
 * logo or background of an enabled slide or in an image widget on one. Anything
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
      and i.origin <> 'custom_api'
      and (
        d.logo_image_id = i.id
        or exists (
          select 1 from dashboard_slides s
          where s.workspace_id = ${workspaceId} and s.dashboard_id = d.id
            and s.enabled
            and (s.background_image_id = i.id or s.logo_image_id = i.id))
        or exists (
          select 1 from dashboard_widgets w
          join dashboard_slides s
            on s.workspace_id = ${workspaceId} and s.id = w.slide_id
          where w.workspace_id = ${workspaceId} and w.dashboard_id = d.id
            and s.enabled and w.image_id = i.id))
    limit 1`);
  return rows.length === 1 ? findImage(tx, workspaceId, imageId) : null;
}

// ─── Resource icons (#226) ─────────────────────────────────────────────────

/** The newest stored icon of a connection's resource, if any. */
export async function findResourceIcon(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
  resourceId: string,
): Promise<ImageRow | null> {
  const [row] = await tx
    .select(metadata)
    .from(schema.workspaceImages)
    .where(
      and(
        eq(schema.workspaceImages.workspaceId, workspaceId),
        eq(schema.workspaceImages.origin, "resource_icon"),
        eq(schema.workspaceImages.connectionId, connectionId),
        eq(schema.workspaceImages.resourceId, resourceId),
      ),
    )
    .orderBy(desc(schema.workspaceImages.createdAt), schema.workspaceImages.id)
    .limit(1);
  return row ?? null;
}

/** Every stored icon of the connection's resources (refreshed daily). */
export async function listResourceIcons(
  tx: Transaction,
  workspaceId: string,
  connectionId?: string,
): Promise<ImageRow[]> {
  return tx
    .select(metadata)
    .from(schema.workspaceImages)
    .where(
      and(
        eq(schema.workspaceImages.workspaceId, workspaceId),
        eq(schema.workspaceImages.origin, "resource_icon"),
        ...(connectionId
          ? [eq(schema.workspaceImages.connectionId, connectionId)]
          : []),
      ),
    )
    .orderBy(desc(schema.workspaceImages.createdAt), schema.workspaceImages.id);
}

/**
 * Points every use of one image (dashboard and slide logos, slide
 * backgrounds, image widgets, template dashboard baselines) at another image
 * of the same workspace: a refreshed icon replaces the old one where it is
 * shown. Dashboard versions are left alone, so an open studio keeps its
 * draft.
 */
export async function replaceImageReferences(
  tx: Transaction,
  workspaceId: string,
  fromImageId: string,
  toImageId: string,
): Promise<void> {
  await tx
    .update(schema.dashboards)
    .set({ logoImageId: toImageId })
    .where(
      and(
        eq(schema.dashboards.workspaceId, workspaceId),
        eq(schema.dashboards.logoImageId, fromImageId),
      ),
    );
  await tx
    .update(schema.dashboardSlides)
    .set({ backgroundImageId: toImageId })
    .where(
      and(
        eq(schema.dashboardSlides.workspaceId, workspaceId),
        eq(schema.dashboardSlides.backgroundImageId, fromImageId),
      ),
    );
  await tx
    .update(schema.dashboardSlides)
    .set({ logoImageId: toImageId })
    .where(
      and(
        eq(schema.dashboardSlides.workspaceId, workspaceId),
        eq(schema.dashboardSlides.logoImageId, fromImageId),
      ),
    );
  await tx
    .update(schema.dashboardWidgets)
    .set({ imageId: toImageId })
    .where(
      and(
        eq(schema.dashboardWidgets.workspaceId, workspaceId),
        eq(schema.dashboardWidgets.imageId, fromImageId),
      ),
    );
  // A template dashboard's baseline (what the template built, and the apps
  // it was built from) follows too, so an update compares the refreshed
  // icon of the same resource, not an image that is gone (#734). Image ids
  // are JSON strings there; the quotes match whole values only.
  const from = JSON.stringify(fromImageId),
    to = JSON.stringify(toImageId);
  await tx
    .update(schema.dataTemplateRecords)
    .set({
      original: sql`replace(${schema.dataTemplateRecords.original}::text, ${from}, ${to})::jsonb`,
    })
    .where(
      and(
        eq(schema.dataTemplateRecords.workspaceId, workspaceId),
        eq(schema.dataTemplateRecords.kind, "dashboard"),
        sql`strpos(${schema.dataTemplateRecords.original}::text, ${from}) > 0`,
      ),
    );
}
