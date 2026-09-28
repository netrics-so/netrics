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
  // Client-supplied forwarding headers are replaced; see clientIp().
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
]);
const DROPPED_RESPONSE_HEADERS = new Set([
  ...DROPPED_REQUEST_HEADERS,
  "content-encoding",
  "set-cookie", // re-added one by one below
]);

export function apiBaseUrl(): string {
  return process.env.NETRICS_API_URL ?? "http://localhost:3001";
}

/**
 * How many proxies stand in front of the web server (Caddy in the Compose
 * install, the platform edge on Railway). Each appends the address it
 * received the request from to X-Forwarded-For. Next.js fills the header from
 * the socket when it is absent.
 */
export function trustedProxyHops(): number {
  const value = Number(process.env.NETRICS_TRUSTED_PROXY_HOPS ?? "1");
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

/**
 * Optional header in which the proxy in front of the web server states the
 * client address as one value (for example x-real-ip), for platforms whose
 * X-Forwarded-For chain is not a fixed number of hops. Unset: use
 * X-Forwarded-For and NETRICS_TRUSTED_PROXY_HOPS.
 */
export function clientIpHeader(): string | null {
  const name = process.env.NETRICS_CLIENT_IP_HEADER?.trim().toLowerCase();
  return name ? name : null;
}

/**
 * The client address as seen by the outermost trusted proxy: the entry that
 * many hops from the right of X-Forwarded-For. Entries further left were
 * written by the client and are ignored.
 */
export function clientIp(
  incoming: Headers,
  hops: number,
  header: string | null = null,
): string | null {
  if (header) {
    return incoming.get(header)?.trim() || null;
  }
  const chain = (incoming.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return chain[Math.max(chain.length - hops, 0)] ?? null;
}

export function proxyRequestHeaders(
  incoming: Headers,
  hops: number = trustedProxyHops(),
  ipHeader: string | null = clientIpHeader(),
): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    if (!DROPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  // The API trusts this hop (NETRICS_TRUSTED_PROXIES) and rate-limits auth
  // by the one address it forwards.
  const ip = clientIp(incoming, hops, ipHeader);
  if (ip) {
    headers.set("x-forwarded-for", ip);
    headers.set("x-real-ip", ip);
  }
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
