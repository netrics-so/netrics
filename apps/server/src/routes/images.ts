import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  IMAGE_CONTENT_TYPES,
  IMAGE_MAX_BYTES,
  IMAGE_NAME_HEADER,
  imageContentQuerySchema,
  imageContentTypeSchema,
  imageInUseResponseSchema,
  imageListResponseSchema,
  imageResponseSchema,
} from "@netrics/contracts";
import type { Database, ImageQuota, ImageRow } from "@netrics/database";
import { can, type WorkspaceAction } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import {
  createDeviceImageService,
  createImageService,
  type Result,
} from "../images/service.js";
import { resolveAccess, sendError, type WorkspaceAccess } from "./access.js";
import { matchesEtag } from "./devices.js";
import { routeSchema } from "./openapi.js";
import { createRequireDevice } from "./principal.js";
import { createRequireSession } from "./session.js";

// HTTP layer for workspace images (ADR 0015, section 5; #217). Uploads are
// the raw bytes with an image Content-Type (no multipart); the display name
// travels percent-encoded in a header, so it never appears in a URL and
// therefore never in a request log line.

export interface ImageRouteDeps {
  authService: AuthService;
  db: Database;
  quota: ImageQuota;
}

const imageParamsSchema = z.object({ imageId: z.uuid() });

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/**
 * Sends stored image bytes with the headers of ADR 0015: the stored type,
 * no sniffing, a sandboxing CSP, a generic file name, same-origin only, and
 * an immutable private cache keyed by the SHA-256 (304 on If-None-Match).
 * Returns true when the caller still has to send the content.
 */
export function imageHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  image: Pick<ImageRow, "contentType" | "sha256">,
): "not_modified" | "send" {
  const etag = `"${image.sha256}"`;
  void reply
    .header("etag", etag)
    .header("cache-control", "private, max-age=31536000, immutable")
    .header("x-content-type-options", "nosniff")
    .header(
      "content-security-policy",
      "default-src 'none'; sandbox; frame-ancestors 'none'",
    )
    .header(
      "content-disposition",
      `inline; filename="image.${EXTENSIONS[image.contentType] ?? "bin"}"`,
    )
    .header("cross-origin-resource-policy", "same-origin");
  if (matchesEtag(request.headers["if-none-match"], etag)) {
    return "not_modified";
  }
  void reply.header("content-type", image.contentType);
  return "send";
}

/** OpenAPI for a route that answers with image bytes. */
export function imageContentSchema(summary: string, device: boolean) {
  const schema = routeSchema({
    summary,
    tags: ["images"],
    querystring: imageContentQuerySchema,
    errors: device ? [404] : [403, 404],
    notModified: true,
    device,
  });
  const response: Record<number, z.ZodType> = { ...schema.response };
  delete response[204];
  // The bytes go out as a Buffer, which Fastify never serialises.
  response[200] = z
    .any()
    .describe(
      "The image bytes as stored; Content-Type image/png, image/jpeg or image/webp",
    );
  return { ...schema, response };
}

/** 409 carries the dashboards that use the image. */
function deleteImageSchema() {
  const schema = routeSchema({
    summary: "Delete an image (409 image_in_use while a dashboard uses it)",
    tags: ["images"],
    errors: [403, 404],
  });
  const response: Record<number, z.ZodType> = {
    ...schema.response,
    409: imageInUseResponseSchema.describe(
      "The image is in use: the dashboards that show it",
    ),
  };
  return { ...schema, response };
}

function unwrap<T>(result: Result<T>, reply: FastifyReply): T | null {
  if (!result.ok) {
    sendError(reply, result.status, result.error);
    return null;
  }
  return result.value;
}

export function registerImageRoutes(
  app: FastifyInstance,
  deps: ImageRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);
  const images = createImageService({ db: deps.db, quota: deps.quota });
  const deviceImages = createDeviceImageService({ db: deps.db });
  const requireDevice = createRequireDevice({ db: deps.db });

  async function authorize(
    request: FastifyRequest,
    reply: FastifyReply,
    action: WorkspaceAction,
  ): Promise<WorkspaceAccess | null> {
    const access = await resolveAccess(deps.db, request, reply);
    if (!access) {
      return null;
    }
    if (!can(access.role, action)) {
      sendError(reply, 403, "forbidden");
      return null;
    }
    return access;
  }

  function imageId(request: FastifyRequest, reply: FastifyReply) {
    const params = imageParamsSchema.safeParse(request.params);
    if (!params.success) {
      sendError(reply, 404, "image_not_found");
      return null;
    }
    return params.data.imageId;
  }

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireSession);
      // Raw image bodies, only in this scope; the limit is the image limit
      // (Fastify answers 413 above it, 415 for any other type).
      scope.addContentTypeParser(
        [...IMAGE_CONTENT_TYPES],
        { parseAs: "buffer", bodyLimit: IMAGE_MAX_BYTES },
        (_request, body, done) => done(null, body),
      );

      scope.get(
        "/workspaces/:workspaceId/images",
        {
          schema: routeSchema({
            summary: "List the workspace's images (metadata, never bytes)",
            tags: ["images"],
            response: imageListResponseSchema,
            errors: [403, 404],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          if (!access) {
            return;
          }
          return imageListResponseSchema.parse(await images.list(access));
        },
      );

      scope.post(
        "/workspaces/:workspaceId/images",
        {
          schema: routeSchema({
            summary:
              "Upload an image: the raw bytes with Content-Type image/png, " +
              "image/jpeg or image/webp (at most 1 MiB, 4096 px per side), " +
              `the display name percent-encoded in ${IMAGE_NAME_HEADER}. ` +
              "Metadata is removed; SVG and animated images are refused.",
            tags: ["images"],
            response: imageResponseSchema,
            errors: [400, 403, 404, 409, 413, 415],
          }),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          if (!access) {
            return;
          }
          const declared = imageContentTypeSchema.safeParse(
            (request.headers["content-type"] ?? "")
              .split(";")[0]!
              .trim()
              .toLowerCase(),
          );
          if (!declared.success) {
            return sendError(reply, 415, "unsupported_media_type");
          }
          // An empty body is not parsed at all; it is refused like any
          // other file that is not an image.
          const body = Buffer.isBuffer(request.body)
            ? request.body
            : Buffer.alloc(0);
          const header = request.headers[IMAGE_NAME_HEADER];
          const image = unwrap(
            await images.upload(
              access,
              declared.data,
              body,
              typeof header === "string" ? header : undefined,
            ),
            reply,
          );
          if (!image) {
            return;
          }
          return imageResponseSchema.parse({ image });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/images/:imageId/content",
        {
          schema: imageContentSchema(
            "An image's bytes; cache it under ?v=<sha256>",
            false,
          ),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:view");
          const id = access && imageId(request, reply);
          if (!access || !id) {
            return;
          }
          const query = imageContentQuerySchema.parse(request.query);
          const image = unwrap(await images.find(access, id, query.v), reply);
          if (!image) {
            return;
          }
          if (imageHeaders(request, reply, image) === "not_modified") {
            return reply.code(304).send();
          }
          const content = unwrap(await images.read(access, image), reply);
          if (!content) {
            return;
          }
          return reply.send(content);
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/images/:imageId",
        {
          schema: deleteImageSchema(),
        },
        async (request, reply) => {
          const access = await authorize(request, reply, "dashboards:update");
          const id = access && imageId(request, reply);
          if (!access || !id) {
            return;
          }
          const result = await images.remove(access, id);
          if (!result.ok) {
            if (result.error === "image_in_use") {
              return reply.code(409).send(
                imageInUseResponseSchema.parse({
                  error: "image_in_use",
                  dashboards: result.dashboards ?? [],
                }),
              );
            }
            return sendError(reply, result.status, result.error);
          }
          return reply.code(204).send();
        },
      );

      done();
    },
    { prefix: "/v1" },
  );

  // Device API (ADR 0011): a device token reads only the images its
  // assigned dashboard shows; anything else is 404.
  void app.register(
    (scope, _opts, done) => {
      scope.addHook("onRequest", requireDevice);

      scope.get(
        "/images/:imageId",
        {
          schema: imageContentSchema(
            "An image the device's dashboard shows; cache it under ?v=<sha256>",
            true,
          ),
        },
        async (request, reply) => {
          const id = imageId(request, reply);
          if (!id) {
            return;
          }
          const query = imageContentQuerySchema.parse(request.query);
          const image = unwrap(
            await deviceImages.read(request.device!, id, query.v),
            reply,
          );
          if (!image) {
            return;
          }
          if (imageHeaders(request, reply, image) === "not_modified") {
            return reply.code(304).send();
          }
          const content = unwrap(
            await deviceImages.content(request.device!, image),
            reply,
          );
          if (!content) {
            return;
          }
          return reply.send(content);
        },
      );

      done();
    },
    { prefix: "/v1/device" },
  );
}
