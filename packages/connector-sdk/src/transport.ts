import { z } from "zod";

const opaqueRecordSchema = z.record(z.string(), z.unknown());

export const connectionContextSchema = z.object({
  connectionId: z.string().min(1),
  config: opaqueRecordSchema,
  credentials: opaqueRecordSchema,
});
export type ConnectionContext = z.infer<typeof connectionContextSchema>;

export const checkResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().min(1).optional(),
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

export const syncResultSchema = z.object({
  observations: z.array(observationSchema),
  /**
   * Where the next request continues. The host commits each page with its
   * cursor as a checkpoint, so a cursor returned with done=false may come
   * back in a later run (after a failure) with a later `to`.
   */
  nextCursor: z.string().min(1).optional(),
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
