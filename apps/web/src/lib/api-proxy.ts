/**
 * Same-origin proxy from the web app to the API. The browser only ever talks
 * to the web origin, so the session cookie stays first-party and no CORS is
 * involved. Requests reach the API through apiFetch (lib/api-fetch), which
 * reads NETRICS_API_URL on every request and forwards the client address.
 */

import type { ErrorResponse } from "@netrics/contracts";

import { apiFetch } from "./api-fetch";

// Same as the API's Fastify default bodyLimit, so the proxy rejects no less.
export const MAX_PROXY_BODY_BYTES = 1_048_576;

// Hop-by-hop headers (RFC 9110 §7.6.1) never cross a proxy, and fetch
// decompresses bodies, so the upstream length/encoding no longer apply.
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // Client-supplied forwarding headers are replaced by apiFetch.
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  ...DROPPED_REQUEST_HEADERS,
  "content-encoding",
  "set-cookie", // re-added one by one below
]);

/** The browser's end-to-end headers; apiFetch adds the client address. */
export function proxyRequestHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    if (!DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  return headers;
}

export function proxyResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, key) => {
    if (!DROPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  for (const cookie of upstream.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  return headers;
}

function errorResponse(error: string, status: number): Response {
  return Response.json({ error } satisfies ErrorResponse, { status });
}

/**
 * The request body as one buffer, or null once it exceeds `limit` bytes; the
 * rest of the stream is then cancelled, never read.
 */
export async function readBodyWithin(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > limit) {
    return null;
  }
  if (!request.body) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function proxyToApi(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    // Buffered, not streamed: Node's fetch cannot replay a stream body and
    // fails outright when the API answers 401 to a streamed request (#118).
    // Buffering is capped so no client can make this process hold more.
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (hasBody) {
      const read = await readBodyWithin(request, MAX_PROXY_BODY_BYTES);
      if (read === null) {
        return errorResponse("payload_too_large", 413);
      }
      body = read;
    }
    upstream = await apiFetch(incoming.pathname + incoming.search, {
      method: request.method,
      headers: proxyRequestHeaders(request.headers),
      client: request.headers,
      body,
      redirect: "manual",
    });
  } catch {
    return errorResponse("api_unreachable", 502);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream.headers),
  });
}
