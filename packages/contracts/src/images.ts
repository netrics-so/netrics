import { z } from "zod";

// Workspace images (ADR 0015, section 5): raster only, metadata stripped,
// stored in PostgreSQL. Listing never carries the bytes; they are served by
// the content routes with the image's SHA-256 as the cache key.

/** The only accepted upload types; the upload's Content-Type names one. */
export const IMAGE_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;
export const imageContentTypeSchema = z.enum(IMAGE_CONTENT_TYPES);
export type ImageContentType = z.infer<typeof imageContentTypeSchema>;

/** 1 MiB: also the API's body limit and the web proxy's cap (ADR 0013). */
export const IMAGE_MAX_BYTES = 1_048_576;
/** Per side, against decompression bombs on clients. */
export const IMAGE_MAX_SIDE = 4096;
/** 16.7 megapixels. */
export const IMAGE_MAX_PIXELS = 16_777_216;
/** Default workspace quota; the server's runtime settings may change it. */
export const IMAGE_QUOTA_DEFAULT_COUNT = 100;
export const IMAGE_QUOTA_DEFAULT_BYTES = 50 * 1_048_576;
/** Display names are sanitised to this length. */
export const IMAGE_NAME_MAX_LENGTH = 100;
/** The upload's display name travels in this header, percent-encoded. */
export const IMAGE_NAME_HEADER = "x-netrics-image-name";

export const imageOriginSchema = z.enum(["upload", "resource_icon"]);
export type ImageOrigin = z.infer<typeof imageOriginSchema>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const workspaceImageSchema = z.object({
  id: z.uuid(),
  name: z.string().max(IMAGE_NAME_MAX_LENGTH),
  contentType: imageContentTypeSchema,
  bytes: z.number().int().positive().max(IMAGE_MAX_BYTES),
  width: z.number().int().positive().max(IMAGE_MAX_SIDE),
  height: z.number().int().positive().max(IMAGE_MAX_SIDE),
  sha256: sha256Schema,
  origin: imageOriginSchema,
  connectionId: z.uuid().nullable(),
  resourceId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  /** Relative URL of the bytes for signed-in users. */
  url: z.string().min(1),
});
export type WorkspaceImage = z.infer<typeof workspaceImageSchema>;

export const imageUsageSchema = z.object({
  count: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  maxCount: z.number().int().nonnegative(),
  maxBytes: z.number().int().nonnegative(),
});
export type ImageUsage = z.infer<typeof imageUsageSchema>;

export const imageListResponseSchema = z.object({
  images: z.array(workspaceImageSchema),
  usage: imageUsageSchema,
});
export type ImageListResponse = z.infer<typeof imageListResponseSchema>;

export const imageResponseSchema = z.object({ image: workspaceImageSchema });
export type ImageResponse = z.infer<typeof imageResponseSchema>;

export const imageContentQuerySchema = z.object({
  v: z
    .string()
    .max(128)
    .optional()
    .describe("The image's SHA-256 (cache key); any other value answers 404"),
});

/** 409 when a dashboard still uses the image (logo, background, widget). */
export const imageInUseResponseSchema = z.object({
  error: z.literal("image_in_use"),
  dashboards: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type ImageInUseResponse = z.infer<typeof imageInUseResponseSchema>;
