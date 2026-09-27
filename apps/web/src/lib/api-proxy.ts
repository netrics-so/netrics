/**
 * Same-origin proxy from the web app to the API. The browser only ever talks
 * to the web origin, so the session cookie stays first-party and no CORS is
 * involved. The API location is read from NETRICS_API_URL on every request:
 * one published image works against any API address (SaaS and self-hosted).
 */

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
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  ...DROPPED_REQUEST_HEADERS,
  "content-encoding",
  "set-cookie", // re-added one by one below
]);

export function apiBaseUrl(): string {
  return process.env.NETRICS_API_URL ?? "http://localhost:3001";
}

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

export async function proxyToApi(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, apiBaseUrl());
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: proxyRequestHeaders(request.headers),
      ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      redirect: "manual",
      cache: "no-store",
    } as RequestInit);
  } catch {
    return Response.json({ error: "api_unreachable" }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: proxyResponseHeaders(upstream.headers),
  });
}
