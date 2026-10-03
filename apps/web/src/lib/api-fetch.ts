/**
 * The one way the web server reaches the API (ADR 0013, #155). Every
 * web→API request goes through apiFetch: the same-origin proxy for /v1/* and
 * /api/auth/* (and with it the TV and kiosk device calls), the server
 * components' fetchers, the /status health checks, the session check and the
 * OAuth callback. Headers every outbound call must carry are set in
 * outboundHeaders() and nowhere else; a lint rule (eslint.config.mjs) rejects
 * calls that build an API URL and fetch it directly.
 *
 * Configuration is read per call, never at module scope: one build works
 * against any API address (SaaS and self-hosted, ADR 0013 "one source, same
 * commit").
 */

/** Marks a request as coming from this frontend (ADR 0013, #156). */
export const PROXY_SECRET_HEADER = "x-netrics-proxy-secret";
/** The client address, believed by the API only next to a valid secret. */
export const CLIENT_IP_HEADER = "x-netrics-client-ip";

// Forwarding headers are only ever set by outboundHeaders(), from the client
// address it resolves itself; a value a caller copied over (for example the
// browser's own headers in the proxy) is dropped.
const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
  PROXY_SECRET_HEADER,
  CLIENT_IP_HEADER,
];

function apiBaseUrl(): string {
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

/**
 * NETRICS_PROXY_SECRET, shared with the API: with it set, every call carries
 * the secret, so the API believes the forwarded client address and accepts
 * session cookies (ADR 0013). The API accepts two comma-separated values
 * during a rotation; the web app sends the first. Unset: nothing is sent.
 */
export function proxySecret(): string | null {
  const first = process.env.NETRICS_PROXY_SECRET?.split(",")[0]?.trim();
  return first ? first : null;
}

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Whether `value` is one IPv4 or IPv6 address and nothing else: no list, no
 * port, no zone. (No node:net here, so this module stays runtime-neutral.)
 */
export function isSingleIp(value: string): boolean {
  if (IPV4.test(value)) {
    return true;
  }
  if (!value.includes(":") || /[^0-9a-fA-F:.]/.test(value)) {
    return false;
  }
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

export interface ApiFetchInit extends Omit<RequestInit, "cache"> {
  /**
   * The headers of the browser request this call is made for. When given,
   * the client address is resolved from them and forwarded; the API trusts
   * this hop (NETRICS_TRUSTED_PROXIES) and rate-limits auth by that address.
   */
  client?: Headers;
}

/**
 * The headers of a call to the API: the caller's headers, minus any
 * forwarding headers, plus the client address when `client` is given, plus
 * the proxy secret when one is configured (then also the client address in
 * x-netrics-client-ip, if it is a single valid IP). This is the single place
 * for headers every web→API request carries.
 */
export function outboundHeaders(
  init: HeadersInit | undefined,
  client: Headers | undefined,
): Headers {
  const headers = new Headers(init);
  for (const name of FORWARDING_HEADERS) {
    headers.delete(name);
  }
  const ip = client
    ? clientIp(client, trustedProxyHops(), clientIpHeader())
    : null;
  if (ip) {
    headers.set("x-forwarded-for", ip);
    headers.set("x-real-ip", ip);
  }
  const secret = proxySecret();
  if (secret) {
    headers.set(PROXY_SECRET_HEADER, secret);
    if (ip && isSingleIp(ip)) {
      headers.set(CLIENT_IP_HEADER, ip);
    }
  }
  return headers;
}

/**
 * The API URL of `path`, an absolute path on the API ("/v1/me?x=1"). A
 * scheme-relative or absolute URL is refused, so no caller can send these
 * headers to another host.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new TypeError("apiFetch takes an absolute path on the API");
  }
  return new URL(path, apiBaseUrl()).toString();
}

/**
 * fetch() against the API at NETRICS_API_URL. Never cached; redirects are
 * not followed (the API answers none, and a followed redirect would carry
 * these headers to wherever it points) unless the caller asks.
 */
export async function apiFetch(
  path: string,
  init: ApiFetchInit = {},
): Promise<Response> {
  const { client, headers, ...rest } = init;
  return fetch(apiUrl(path), {
    redirect: "manual",
    ...rest,
    headers: outboundHeaders(headers, client),
    cache: "no-store",
  });
}
