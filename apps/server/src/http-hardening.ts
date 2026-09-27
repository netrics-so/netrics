import { randomUUID } from "node:crypto";

import type { FastifyError, FastifyInstance, FastifyRequest } from "fastify";

import { errorResponseSchema } from "@netrics/contracts";

import type { Config } from "./env.js";

// Accepted client request ids: short, log-safe tokens (UUIDs, trace ids).
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Uses a client-supplied X-Request-Id only when it is a short, log-safe
 * token; anything else (newlines, JSON fragments, huge values) is replaced so
 * it cannot forge or corrupt log lines.
 */
export function requestIdFromHeader(request: {
  headers: Record<string, string | string[] | undefined>;
}): string {
  const header = request.headers["x-request-id"];
  return typeof header === "string" && REQUEST_ID_PATTERN.test(header)
    ? header
    : randomUUID();
}

const CLIENT_ERROR_CODES: Record<number, string> = {
  400: "invalid_request",
  404: "not_found",
  405: "method_not_allowed",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "too_many_requests",
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isCrossOriginMutation(request: FastifyRequest, webOrigin: string) {
  if (SAFE_METHODS.has(request.method) || !request.url.startsWith("/v1/")) {
    return false;
  }
  // Browsers send Sec-Fetch-Site and Origin on every non-GET request; their
  // absence means a non-browser client, which cannot ride a victim's cookie.
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return true;
  }
  const origin = request.headers.origin;
  return typeof origin === "string" && origin !== webOrigin;
}

/**
 * Cross-cutting HTTP protections for the API:
 * - error responses never carry internal messages (database errors etc.)
 * - security headers on every response
 * - mutating /v1 requests from a foreign browser origin are rejected, in
 *   addition to SameSite session cookies (CSRF defense in depth)
 */
export function registerHttpHardening(
  app: FastifyInstance,
  config: Config,
): void {
  const webOrigin = new URL(config.webOrigin).origin;
  const https = new URL(config.betterAuthUrl).protocol === "https:";

  app.addHook("onRequest", async (request, reply) => {
    if (isCrossOriginMutation(request, webOrigin)) {
      return reply
        .code(403)
        .send(errorResponseSchema.parse({ error: "forbidden_origin" }));
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    if (https) {
      reply.header("strict-transport-security", "max-age=31536000");
    }
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: error }, "unhandled error");
      return reply
        .code(500)
        .send(errorResponseSchema.parse({ error: "internal_error" }));
    }
    request.log.info({ err: error }, "request rejected");
    return reply.code(status).send(
      errorResponseSchema.parse({
        error: CLIENT_ERROR_CODES[status] ?? "request_failed",
      }),
    );
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send(errorResponseSchema.parse({ error: "not_found" })),
  );
}
