import { createHash } from "node:crypto";

import {
  IMAGE_NAME_MAX_LENGTH,
  type ImageContentType,
  type ImageUsage,
  type WorkspaceImage,
} from "@netrics/contracts";
import {
  findDeviceImage,
  findImageUsers,
  hasSqlstate,
  insertAuditEvent,
  withWorkspace,
  type Database,
  type ImageQuota,
  type ImageRow,
} from "@netrics/database";

import { sanitizeImage, type ImageRejection } from "./format.js";
import { postgresImageStore, type ImageStore } from "./store.js";

/**
 * Workspace image use cases (ADR 0015, section 5; #217). Uploads are
 * validated and stripped of metadata by ./format before they are stored.
 * Neither the bytes nor the display name ever reach a log line or an audit
 * event; audit events carry the id, type, size and dimensions only.
 */

export interface Actor {
  workspaceId: string;
  callerId: string;
}

export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: 400 | 401 | 404 | 409 | 413;
      error: string;
      /** With 409 image_in_use: the dashboards that use the image. */
      dashboards?: Array<{ id: string; name: string }>;
    };

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(
  status: 400 | 401 | 404 | 409 | 413,
  error: string,
): Result<T> {
  return { ok: false, status, error };
}

const NOT_FOUND = "image_not_found";

const REJECTION_STATUS: Record<ImageRejection, 400 | 413> = {
  image_type_mismatch: 400,
  image_invalid: 400,
  image_animated: 400,
  image_dimensions_too_large: 400,
  image_too_large: 413,
};

/**
 * A display name from the upload header: percent-decoded, without path,
 * control or bidirectional formatting characters, whitespace collapsed,
 * at most IMAGE_NAME_MAX_LENGTH characters. Falls back to "image".
 */
export function sanitizeImageName(raw: string | undefined): string {
  if (!raw) {
    return "image";
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "image";
  }
  const base = decoded.normalize("NFC").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim();
  const limited = Array.from(cleaned)
    .slice(0, IMAGE_NAME_MAX_LENGTH)
    .join("")
    .trim();
  return limited.length > 0 ? limited : "image";
}

export function imageContentUrl(
  workspaceId: string,
  image: Pick<ImageRow, "id" | "sha256">,
): string {
  return `/v1/workspaces/${workspaceId}/images/${image.id}/content?v=${image.sha256}`;
}

export function presentImage(image: ImageRow): WorkspaceImage {
  return {
    id: image.id,
    name: image.name,
    contentType: image.contentType as ImageContentType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    sha256: image.sha256,
    origin: image.origin as WorkspaceImage["origin"],
    connectionId: image.connectionId,
    resourceId: image.resourceId,
    createdAt: image.createdAt.toISOString(),
    url: imageContentUrl(image.workspaceId, image),
  };
}

/**
 * A failed image write, with only the SQLSTATE: the driver's error repeats
 * the query's bound values (the image bytes, its name), and an error that
 * reaches the request log must not carry them.
 */
export class ImageStoreError extends Error {
  readonly code: string | undefined;

  constructor(code: string | undefined) {
    super(`image store failed${code ? ` (SQLSTATE ${code})` : ""}`);
    this.name = "ImageStoreError";
    this.code = code;
  }
}

function sqlstateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}

async function withoutQueryValues<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ImageStoreError(sqlstateOf(error));
  }
}

export interface ImageServiceDeps {
  db: Database;
  quota: ImageQuota;
  store?: ImageStore;
}

export function createImageService(deps: ImageServiceDeps) {
  const { db, quota } = deps;
  const store = deps.store ?? postgresImageStore;

  function inWorkspace<T>(
    actor: Actor,
    fn: Parameters<typeof withWorkspace<T>>[2],
  ): Promise<T> {
    return withWorkspace(
      db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      fn,
    );
  }

  return {
    async list(
      actor: Actor,
    ): Promise<{ images: WorkspaceImage[]; usage: ImageUsage }> {
      return inWorkspace(actor, async (tx) => {
        const [images, usage] = [
          await store.list(tx, actor.workspaceId),
          await store.usage(tx, actor.workspaceId),
        ];
        return {
          images: images.map(presentImage),
          usage: { ...usage, ...quota },
        };
      });
    },

    async upload(
      actor: Actor,
      contentType: ImageContentType,
      body: Buffer,
      rawName: string | undefined,
    ): Promise<Result<WorkspaceImage>> {
      const checked = sanitizeImage(contentType, body);
      if (!checked.ok) {
        return fail(REJECTION_STATUS[checked.error], checked.error);
      }
      const sha256 = createHash("sha256").update(checked.content).digest("hex");
      return withoutQueryValues(() =>
        inWorkspace(actor, async (tx) => {
          const result = await store.insert(
            tx,
            actor.workspaceId,
            {
              name: sanitizeImageName(rawName),
              contentType: checked.contentType,
              width: checked.width,
              height: checked.height,
              sha256,
              content: checked.content,
              createdByUserId: actor.callerId,
            },
            quota,
          );
          if (result.status === "quota_exceeded") {
            return fail(409, "image_quota_exceeded");
          }
          await insertAuditEvent(tx, {
            workspaceId: actor.workspaceId,
            actorUserId: actor.callerId,
            action: "image.uploaded",
            target: result.image.id,
            metadata: {
              contentType: result.image.contentType,
              bytes: result.image.bytes,
              width: result.image.width,
              height: result.image.height,
            },
          });
          return ok(presentImage(result.image));
        }),
      );
    },

    /** Metadata of one image, or 404 when `version` is not its SHA-256. */
    async find(
      actor: Actor,
      imageId: string,
      version: string | undefined,
    ): Promise<Result<ImageRow>> {
      const image = await inWorkspace(actor, (tx) =>
        store.find(tx, actor.workspaceId, imageId),
      );
      if (!image || (version !== undefined && version !== image.sha256)) {
        return fail(404, NOT_FOUND);
      }
      return ok(image);
    },

    async read(actor: Actor, image: ImageRow): Promise<Result<Buffer>> {
      const content = await inWorkspace(actor, (tx) =>
        store.read(tx, actor.workspaceId, image.id),
      );
      return content ? ok(content) : fail(404, NOT_FOUND);
    },

    async remove(actor: Actor, imageId: string): Promise<Result<void>> {
      return inWorkspace(actor, async (tx) => {
        const inUse = async (): Promise<Result<void>> => ({
          ok: false,
          status: 409,
          error: "image_in_use",
          dashboards: await findImageUsers(tx, actor.workspaceId, imageId),
        });
        if ((await findImageUsers(tx, actor.workspaceId, imageId)).length) {
          return inUse();
        }
        let removed: boolean;
        try {
          // A savepoint: a dashboard saved meanwhile with this image makes
          // the foreign key refuse the delete, and the answer is still 409.
          removed = await tx.transaction((savepoint) =>
            store.remove(savepoint, actor.workspaceId, imageId),
          );
        } catch (error) {
          if (hasSqlstate(error, "23503")) {
            return inUse();
          }
          throw error;
        }
        if (!removed) {
          return fail(404, NOT_FOUND);
        }
        await insertAuditEvent(tx, {
          workspaceId: actor.workspaceId,
          actorUserId: actor.callerId,
          action: "image.deleted",
          target: imageId,
        });
        return ok(undefined);
      });
    },
  };
}

export type ImageService = ReturnType<typeof createImageService>;

export interface DevicePrincipal {
  workspaceId: string;
  deviceId: string;
}

/**
 * Images for paired screens (ADR 0015, section 5): only those the device's
 * assigned dashboard shows. Everything else, including any image of
 * another workspace, is 404; a revoked device is 401.
 */
export function createDeviceImageService(deps: {
  db: Database;
  store?: ImageStore;
}) {
  const store = deps.store ?? postgresImageStore;
  return {
    async read(
      device: DevicePrincipal,
      imageId: string,
      version: string | undefined,
    ): Promise<Result<ImageRow>> {
      const image = await withWorkspace(
        deps.db,
        { workspaceId: device.workspaceId },
        (tx) =>
          findDeviceImage(tx, device.workspaceId, device.deviceId, imageId),
      );
      if (!image || (version !== undefined && version !== image.sha256)) {
        return fail(404, NOT_FOUND);
      }
      return ok(image);
    },

    async content(
      device: DevicePrincipal,
      image: ImageRow,
    ): Promise<Result<Buffer>> {
      const content = await withWorkspace(
        deps.db,
        { workspaceId: device.workspaceId },
        (tx) => store.read(tx, device.workspaceId, image.id),
      );
      return content ? ok(content) : fail(404, NOT_FOUND);
    },
  };
}
