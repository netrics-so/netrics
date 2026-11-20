import { createHash } from "node:crypto";

import {
  CUSTOM_API_IMAGE_MAX_BYTES,
  CUSTOM_API_IMAGE_NEWEST_DEFAULT,
  type CustomApiImageSkipReason,
} from "@netrics/contracts";
import { executeTrustedCall } from "@netrics/connector-runtime";
import type { CustomApiStream } from "@netrics/connector-sdk/custom-api";
import {
  fetchItemImages,
  type CustomApiCredentials,
  type ItemImageFetch,
} from "@netrics/connectors/custom-api";
import {
  findCustomApiImageBySha256,
  findItemImages,
  insertImageWithinQuota,
  latestDatasetValues,
  recordStreamImages,
  touchItemImages,
  upsertItemImage,
  withWorkspace,
  type Database,
  type ImageQuota,
} from "@netrics/database";

import type { ResolvedConnector } from "../custom-api/connectors.js";
import { sanitizeImage, sniffImageType } from "./format.js";
import type { ConnectorCall } from "./resource-icons.js";

/**
 * Custom API item images (milestone 13, issue #809; spec section 8): after a
 * succeeded sync, the images of each image stream's newest items are copied
 * into the workspace as images of origin "custom_api". The custom-api
 * connector downloads them through the egress guard (same-host redirects,
 * 2 MiB, 15 s per request), with the connection's credentials only on the
 * environment host. The bytes go through the upload validation (magic
 * bytes, strict parse, metadata stripped) and count against their own
 * quota. Stored images are keyed by workspace and URL hash, and reused by
 * content hash, so a URL is downloaded once and an expiring signed URL does
 * not store the same bytes again. Nothing here fails the sync: every image
 * that is not stored is counted by reason on its stream.
 */

/** The whole step's time budget per run. */
export const CUSTOM_API_IMAGE_BUDGET_MS = 120_000;
/** Per image request. */
export const CUSTOM_API_IMAGE_REQUEST_TIMEOUT_MS = 15_000;

/** sha256 hex of the exact UTF-8 URL string: the lookup key of an item image. */
export function itemImageUrlHash(url: string): string {
  return createHash("sha256").update(url, "utf8").digest("hex");
}

export interface IngestCustomApiImagesInput {
  db: Database;
  workspaceId: string;
  connectionId: string;
  /** connectorFor(...) of this run; its customApi is set. */
  resolved: ResolvedConnector;
  /** callConnector of the sync run (credentials, OAuth refresh). */
  run: ConnectorCall;
  /** The custom_api quota. */
  quota: ImageQuota;
  now: Date;
  /** Counts only: never a URL, host or image byte. */
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** Whole step; default CUSTOM_API_IMAGE_BUDGET_MS. */
  budgetMs?: number;
  /** Tests: the clock the budget is measured with. */
  clock?: () => number;
}

export interface StreamImageOutcome {
  streamKey: string;
  stored: number;
  unchanged: number;
  skipped: number;
  skippedReasons: Partial<Record<CustomApiImageSkipReason, number>>;
}

/** The first image field of each stream that has one, in definition order. */
function imageStreams(
  streams: readonly CustomApiStream[],
): Array<{ stream: CustomApiStream; field: string; orderField: string }> {
  return streams.flatMap((stream) => {
    const field = stream.fields.find((entry) => entry.role === "image");
    // The definition schema requires a reporting field next to an image
    // field; without one there is no "newest".
    return field && stream.reportingField
      ? [{ stream, field: field.id, orderField: stream.reportingField }]
      : [];
  });
}

/** Validates fetched bytes; the sanitized image or the reason it is skipped. */
function validate(fetched: Extract<ItemImageFetch, { ok: true }>):
  | {
      ok: true;
      contentType: string;
      width: number;
      height: number;
      content: Buffer;
    }
  | { ok: false; reason: CustomApiImageSkipReason } {
  // The declared Content-Type is never trusted: the magic bytes decide.
  const type = sniffImageType(fetched.bytes);
  if (!type) return { ok: false, reason: "unsupported_type" };
  const sanitized = sanitizeImage(
    type,
    fetched.bytes,
    CUSTOM_API_IMAGE_MAX_BYTES,
  );
  if (!sanitized.ok)
    return {
      ok: false,
      reason:
        sanitized.error === "image_too_large" ? "too_large" : "invalid_image",
    };
  return {
    ok: true,
    contentType: sanitized.contentType,
    width: sanitized.width,
    height: sanitized.height,
    content: sanitized.content,
  };
}

/**
 * Copies the newest items' images of every image stream of the connection
 * and records each stream's outcome. Throws only for database failures; the
 * engine logs those and keeps the run's status.
 */
export async function ingestCustomApiImages(
  input: IngestCustomApiImagesInput,
): Promise<StreamImageOutcome[]> {
  const customApi = input.resolved.customApi;
  if (!customApi) return [];
  const { definition, pin } = customApi;
  const clock = input.clock ?? Date.now;
  const deadline = clock() + (input.budgetMs ?? CUSTOM_API_IMAGE_BUDGET_MS);
  const newest =
    definition.images?.newestItems ?? CUSTOM_API_IMAGE_NEWEST_DEFAULT;
  const inWorkspace = <T>(
    run: Parameters<typeof withWorkspace<T>>[2],
  ): Promise<T> =>
    withWorkspace(input.db, { workspaceId: input.workspaceId }, run);
  const outcomes: StreamImageOutcome[] = [];

  for (const { stream, field, orderField } of imageStreams(
    definition.streams,
  )) {
    const outcome: StreamImageOutcome = {
      streamKey: stream.key,
      stored: 0,
      unchanged: 0,
      skipped: 0,
      skippedReasons: {},
    };
    const skip = (reason: CustomApiImageSkipReason, count = 1) => {
      outcome.skipped += count;
      outcome.skippedReasons[reason] =
        (outcome.skippedReasons[reason] ?? 0) + count;
    };

    const urls = await inWorkspace((tx) =>
      latestDatasetValues(tx, {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        datasetKey: stream.key,
        valueField: field,
        orderField,
        limit: newest,
        now: input.now,
      }),
    );
    const hashes = new Map(urls.map((url) => [url, itemImageUrlHash(url)]));
    const known = await inWorkspace(async (tx) => {
      const found = await findItemImages(tx, input.workspaceId, [
        ...hashes.values(),
      ]);
      await touchItemImages(
        tx,
        input.workspaceId,
        [...found.keys()],
        input.now,
      );
      return found;
    });
    outcome.unchanged = known.size;
    const missing = urls.filter((url) => !known.has(hashes.get(url)!));

    let fetched: ItemImageFetch[] | null = null;
    const remaining = deadline - clock();
    if (missing.length > 0 && remaining > 0) {
      try {
        fetched = await input.run((context, options) =>
          executeTrustedCall(
            input.resolved.connector,
            context,
            {
              ...options,
              egress: {
                ...options.egress,
                redirects: "same-host",
                maxResponseBytes: CUSTOM_API_IMAGE_MAX_BYTES,
                maxDecompressedBytes: CUSTOM_API_IMAGE_MAX_BYTES,
                requestTimeoutMs: CUSTOM_API_IMAGE_REQUEST_TIMEOUT_MS,
              },
              timeoutMs: remaining,
            },
            (runtime) =>
              fetchItemImages({
                definition,
                environmentId: pin.environmentId,
                credentials: context.credentials as CustomApiCredentials,
                config: context.config,
                runtime,
                urls: missing,
                maxBytes: CUSTOM_API_IMAGE_MAX_BYTES,
                ...(options.egress?.allowInsecureHttp
                  ? { allowInsecureHttp: true }
                  : {}),
              }),
          ),
        );
      } catch {
        // The budget ran out or the call failed as a whole (an OAuth token
        // that cannot be refreshed): every image of the stream waits.
        fetched = null;
      }
    }
    if (fetched === null) {
      skip("fetch_failed", missing.length);
    } else {
      for (const result of fetched) {
        if (!result.ok) {
          skip(result.reason);
          continue;
        }
        const image = validate(result);
        if (!image.ok) {
          skip(image.reason);
          continue;
        }
        const sha256 = createHash("sha256").update(image.content).digest("hex");
        const stored = await inWorkspace(async (tx) => {
          const existing = await findCustomApiImageBySha256(
            tx,
            input.workspaceId,
            sha256,
          );
          let imageId = existing?.id;
          if (!imageId) {
            const inserted = await insertImageWithinQuota(
              tx,
              input.workspaceId,
              {
                name: "item",
                contentType: image.contentType,
                width: image.width,
                height: image.height,
                sha256,
                content: image.content,
                origin: "custom_api",
                createdByUserId: null,
              },
              input.quota,
            );
            if (inserted.status !== "ok") return false;
            imageId = inserted.image.id;
          }
          await upsertItemImage(tx, input.workspaceId, {
            urlSha256: hashes.get(result.url)!,
            imageId,
            now: input.now,
          });
          return true;
        });
        if (stored) outcome.stored += 1;
        else skip("quota_exceeded");
      }
    }

    await inWorkspace((tx) =>
      recordStreamImages(tx, {
        workspaceId: input.workspaceId,
        connectionId: input.connectionId,
        streamKey: stream.key,
        checkedAt: input.now,
        stored: outcome.stored,
        unchanged: outcome.unchanged,
        skipped: outcome.skipped,
        skippedReasons: outcome.skippedReasons,
      }),
    );
    if (outcome.stored > 0 || outcome.skipped > 0)
      input.log("item images checked", {
        stream: stream.key,
        stored: outcome.stored,
        unchanged: outcome.unchanged,
        skipped: outcome.skipped,
        skippedReasons: outcome.skippedReasons,
      });
    outcomes.push(outcome);
  }
  return outcomes;
}
