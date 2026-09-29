/**
 * One address for the web app. With NETRICS_APP_ORIGIN set, a request on any
 * other host (an old platform default domain, say) is sent to the same path
 * on the app origin: the API trusts only WEB_ORIGIN, so sign-in and every
 * mutation fail anywhere else. Pairing hosts are left to pairing-host.ts.
 * Without the variable nothing is redirected (self-hosting is unaffected).
 */

import { appOriginUrl, normalizeHost, pairingHosts } from "./pairing-host";

export interface CanonicalHostConfig {
  appOrigin: string;
  /** Hosts served in place: the app origin's host and the pairing hosts. */
  hosts: ReadonlySet<string>;
}

export function canonicalHostConfig(
  env: Record<string, string | undefined>,
): CanonicalHostConfig | null {
  const origin = appOriginUrl(env);
  if (!origin) return null;
  const hosts = pairingHosts(env);
  hosts.add(normalizeHost(origin.host));
  return { appOrigin: origin.origin, hosts };
}

/**
 * Paths served on every host:
 * - /healthz: the platform's liveness probe and release smoke checks, which
 *   reach the service by an internal or default address.
 * - /v1/server and /v1/device/*: the device API. TVs paired against an old
 *   address keep calling it, and the tvOS app refuses redirects.
 * - /kiosk: a browser kiosk keeps its device credentials in that origin's
 *   localStorage; moving it would unpair it.
 * - /_next/*: build assets, only requested by pages served on this host
 *   (the kiosk, or a page loaded just before the switch).
 */
function servedOnEveryHost(pathname: string): boolean {
  return (
    pathname === "/healthz" ||
    pathname === "/v1/server" ||
    pathname === "/kiosk" ||
    pathname.startsWith("/v1/device/") ||
    pathname.startsWith("/_next/")
  );
}

/**
 * Where a request on a host other than the app origin's goes (same path and
 * query on the app origin), or null to serve it here.
 */
export function canonicalHostRedirect(
  config: CanonicalHostConfig | null,
  host: string | null,
  url: URL,
): string | null {
  if (!config || !host || config.hosts.has(normalizeHost(host))) return null;
  if (servedOnEveryHost(url.pathname)) return null;
  // Set path and query on the origin rather than resolving the path against
  // it: "//evil.example" would otherwise leave the origin.
  const target = new URL(config.appOrigin);
  target.pathname = url.pathname;
  target.search = url.search;
  return target.toString();
}
