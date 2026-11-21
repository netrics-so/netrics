import { datasetPageSchema, DATASET_LIMITS } from "./datasets.js";
import { z } from "zod";

import { ERROR_CODE_MAX_LENGTH, ERROR_CODE_PATTERN } from "./errors.js";
import { freshnessEntrySchema, FRESHNESS_LIMITS } from "./freshness.js";

const opaqueRecordSchema = z.record(z.string(), z.unknown());

export const connectionContextSchema = z.object({
  connectionId: z.string().min(1),
  config: opaqueRecordSchema,
  credentials: opaqueRecordSchema,
});
export type ConnectionContext = z.infer<typeof connectionContextSchema>;

/** A reason code (SDK 0.2.18, #795): see ERROR_CODE_PATTERN. */
export const errorCodeSchema = z
  .string()
  .max(ERROR_CODE_MAX_LENGTH)
  .regex(ERROR_CODE_PATTERN);

export const checkResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().min(1).optional(),
  /**
   * Optional (SDK 0.2.18, #795): the stable reason of a failed check, next
   * to its English message. Clients that know the code show their own text
   * for it in the viewer's language; the message stays the fallback.
   */
  code: errorCodeSchema.optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const resourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  metadata: opaqueRecordSchema.optional(),
});
export type Resource = z.infer<typeof resourceSchema>;

export const syncModeSchema = z.enum(["backfill", "incremental"]);
export type SyncMode = z.infer<typeof syncModeSchema>;

export const syncRequestSchema = z
  .object({
    mode: syncModeSchema,
    from: z.iso.datetime({ offset: false }),
    to: z.iso.datetime({ offset: false }),
    /**
     * The `nextCursor` this connector returned earlier, exactly as returned.
     * The cursor is opaque to the host (#638): it stores the string and
     * hands it back unchanged, and never rewrites or migrates it. The
     * connector owns its shape and versioning, so a connector that changes
     * its cursor format must still read (or deliberately restart from) every
     * shape it ever returned, for example by prefixing a version tag.
     */
    cursor: z.string().min(1).optional(),
    resources: z.array(z.string().min(1)).optional(),
  })
  .refine((request) => request.from < request.to, {
    message: "from must be before to",
  });
export type SyncRequest = z.infer<typeof syncRequestSchema>;

/**
 * One value of one series at one time. Identity is (metricKey, dimensions,
 * sourceTimestamp): re-sending the same identity with a different value is a
 * revision (the provider corrected a recent day) and replaces the stored
 * value; re-sending an identical value is a no-op.
 */
export const observationSchema = z.object({
  metricKey: z.string().min(1),
  sourceTimestamp: z.iso.datetime({ offset: false }),
  value: z.number().finite(),
  dimensions: z.record(z.string(), z.string()),
});
export type Observation = z.infer<typeof observationSchema>;

/**
 * Stable identity string of an observation: metric, dimensions with keys in
 * sorted order, and timestamp. Two observations with equal keys are the same
 * data point.
 */
export function observationKey(observation: Observation): string {
  const dimensions = Object.keys(observation.dimensions)
    .sort()
    .map((key) => [key, observation.dimensions[key]]);
  return JSON.stringify([
    observation.metricKey,
    dimensions,
    new Date(observation.sourceTimestamp).toISOString(),
  ]);
}

// ─── Review text (optional, since SDK 0.2.8; ADR 0019 §11) ─────────────────

/**
 * One customer review of a resource (an app), for the latest-review widget.
 * Title, body and author are user content and personal data: the host
 * stores them in its own table with length caps and retention, never in
 * observations, logs or errors. Text longer than the host's caps (title 300,
 * body 4,000, author 100 characters) is cut on ingest.
 */
export const syncReviewSchema = z.object({
  /** The provider's review id; unique per connection. */
  id: z.string().min(1).max(200),
  /** The resource (app) the review belongs to. */
  resource: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  title: z.string().nullable(),
  body: z.string().nullable(),
  /** The reviewer's nickname as the provider shows it. */
  author: z.string().nullable(),
  /** ISO 3166-1 alpha-2, uppercase; null when unknown. */
  territory: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  createdAt: z.iso.datetime({ offset: false }),
});
export type SyncReview = z.infer<typeof syncReviewSchema>;

/**
 * A span of review creation times [from, to) of one resource that the
 * connector read completely. The host deletes stored reviews of that
 * resource created inside the span that the result did not return, so
 * edited and deleted reviews follow the provider.
 */
export const reviewWindowSchema = z
  .object({
    resource: z.string().min(1),
    from: z.iso.datetime({ offset: false }),
    to: z.iso.datetime({ offset: false }),
  })
  .refine((window) => window.from < window.to, {
    message: "from must be before to",
  });
export type ReviewWindow = z.infer<typeof reviewWindowSchema>;

export const syncResultSchema = z.object({
  observations: z.array(observationSchema),
  datasetPages: z
    .array(datasetPageSchema)
    .max(DATASET_LIMITS.datasets)
    .optional(),
  /**
   * Optional (SDK 0.2.8): reviews read on this page. Connectors without
   * review text return neither this nor `reviewWindows`.
   */
  reviews: z.array(syncReviewSchema).optional(),
  /** Optional (SDK 0.2.8): the spans this page read completely. */
  reviewWindows: z.array(reviewWindowSchema).optional(),
  /**
   * Optional (SDK 0.2.12), on a done result only: keys of declared source
   * datasets this run checked completely, whether or not it found rows. One
   * that has never stored a generation then counts as received and empty
   * instead of pending: the host stores an empty first generation. Stored
   * rows are never replaced by it (#666).
   */
  receivedDatasets: z
    .array(z.string().min(1).max(200))
    .max(DATASET_LIMITS.datasets)
    .optional(),
  /**
   * Optional (SDK 0.2.13, ADR 0025), read from a done result only: one
   * entry per declared freshness stream (and resource) this run read
   * completely. A stream it did not read gets no entry. Ignored on a
   * result with done=false.
   */
  freshness: z
    .array(freshnessEntrySchema)
    .max(FRESHNESS_LIMITS.entries)
    .optional(),
  /**
   * Where the next request continues. The host commits each page with its
   * cursor as a checkpoint, so a cursor returned with done=false may come
   * back in a later run (after a failure) with a later `to`. Opaque to the
   * host: see SyncRequest.cursor. The host only compares it with the
   * request's cursor (an unchanged cursor on done=false is a contract
   * violation); it never reads a window from it (#758). A done result
   * without one clears the stored cursor.
   */
  nextCursor: z.string().min(1).optional(),
  /**
   * Optional (SDK 0.2.15, #758), read from a done result only: where the
   * next incremental window starts, its `from`. Without it the next window
   * starts at this request's `to`. A connector that re-reads recent days
   * (a lookback) returns the start of those days here; it may lie before
   * this request's `from` (by at most the manifest's backfillDays, or one
   * day without them), never after its `to`. The host stores it next to the
   * cursor, apart from it. It must be a well-formed instant on every page,
   * and is ignored on a result with done=false (a retry after a failed page
   * continues the same window).
   */
  nextFrom: z.iso.datetime({ offset: false }).optional(),
  done: z.boolean(),
});
export type SyncResult = z.infer<typeof syncResultSchema>;

// ─── Resource icons (optional capability, since SDK 0.2.5; #226) ──────────

/** Raster types an icon may have; the host validates the bytes strictly. */
export const RESOURCE_ICON_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
/** Largest icon a connector may return (the host's image limit, 1 MiB). */
export const RESOURCE_ICON_MAX_BYTES = 1_048_576;
/** Resources per resourceIcons call. */
export const RESOURCE_ICONS_MAX_RESOURCES = 50;

export const resourceIconsRequestSchema = z.object({
  resources: z
    .array(
      z.object({
        id: z.string().min(1),
        /**
         * Hints from the host: the territories (ISO 3166-1 alpha-2,
         * uppercase) the resource has the most data for, most first. A
         * store-based connector may look the resource up there when its
         * default storefront does not list it.
         */
        territories: z
          .array(z.string().regex(/^[A-Z]{2}$/))
          .max(5)
          .optional(),
      }),
    )
    .min(1)
    .max(RESOURCE_ICONS_MAX_RESOURCES),
});
export type ResourceIconsRequest = z.infer<typeof resourceIconsRequestSchema>;

export const resourceIconSchema = z.object({
  resourceId: z.string().min(1),
  contentType: z.enum(RESOURCE_ICON_CONTENT_TYPES),
  /** The image bytes, base64 (transport objects stay JSON). */
  data: z.base64().min(1),
});
export type ResourceIcon = z.infer<typeof resourceIconSchema>;

export const resourceIconsResultSchema = z.object({
  /** One icon per resource that has one; resources without are left out. */
  icons: z.array(resourceIconSchema),
});
export type ResourceIconsResult = z.infer<typeof resourceIconsResultSchema>;
