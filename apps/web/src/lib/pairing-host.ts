/**
 * The hosted service's short pairing domain (ADR 0010). TVs show
 * "netrics.tv" and a QR code for netrics.tv/<CODE>; that domain points at
 * this web app, which sends every request on it to the approval page on the
 * app origin. Configured at runtime, so one image serves SaaS and
 * self-hosting; without the variables nothing is redirected.
 *
 *   NETRICS_PAIRING_HOST  host names, comma-separated (netrics.tv,www.netrics.tv)
 *   NETRICS_APP_ORIGIN    where the approval page lives (https://app.netrics.so)
 */

export interface PairingHostConfig {
  hosts: ReadonlySet<string>;
  appOrigin: string;
}

/** Host name as compared: lower case, without port and trailing dot. */
export function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    // IPv6 literal: keep the brackets, drop the port.
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** The pairing host names from NETRICS_PAIRING_HOST, normalized. */
export function pairingHosts(
  env: Record<string, string | undefined>,
): Set<string> {
  return new Set(
    (env.NETRICS_PAIRING_HOST ?? "")
      .split(",")
      .map(normalizeHost)
      .filter((host) => host.length > 0),
  );
}

/** NETRICS_APP_ORIGIN as an http(s) URL, or null when unset or invalid. */
export function appOriginUrl(
  env: Record<string, string | undefined>,
): URL | null {
  const rawOrigin = env.NETRICS_APP_ORIGIN?.trim();
  if (!rawOrigin) return null;
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" && origin.protocol !== "http:") return null;
  return origin;
}

/**
 * The redirect configuration, or null (no redirect) when either variable is
 * missing or invalid, or when the app origin is itself a pairing host.
 */
export function pairingHostConfig(
  env: Record<string, string | undefined>,
): PairingHostConfig | null {
  const hosts = pairingHosts(env);
  const origin = appOriginUrl(env);
  if (hosts.size === 0 || !origin) return null;
  if (hosts.has(normalizeHost(origin.host))) return null;
  return { hosts, appOrigin: origin.origin };
}

const CODE_SHAPE = /^([A-Z0-9]{4})[-\s]?([A-Z0-9]{4})$/;

/** A pairing code in the TV's XXXX-XXXX form, or null for anything else. */
export function normalizePairingCode(
  value: string | null | undefined,
): string | null {
  if (!value || value.length > 20) return null;
  const match = CODE_SHAPE.exec(value.trim().toUpperCase());
  return match ? `${match[1]}-${match[2]}` : null;
}

function firstPathSegment(pathname: string): string | null {
  const segment = pathname.split("/").find((part) => part.length > 0);
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Where a request on a pairing host goes, or null when the host is not one
 * (or the redirect is not configured). The code is taken from the first
 * path segment or ?code=, and only passed on in its normalized form.
 */
export function pairingHostRedirect(
  config: PairingHostConfig | null,
  host: string | null,
  url: URL,
): string | null {
  if (!config || !host || !config.hosts.has(normalizeHost(host))) return null;
  const code =
    normalizePairingCode(firstPathSegment(url.pathname)) ??
    normalizePairingCode(url.searchParams.get("code"));
  const target = new URL("/devices/approve", config.appOrigin);
  if (code) target.searchParams.set("code", code);
  return target.toString();
}
