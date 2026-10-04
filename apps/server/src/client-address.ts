import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Secret } from "./secret.js";

/**
 * Requests from the web frontend (ADR 0013, #156).
 *
 * With NETRICS_PROXY_SECRET set, the web app sends the secret in
 * PROXY_SECRET_HEADER on every call and the client address it resolved in
 * FORWARDED_CLIENT_IP_HEADER. The API believes that address only on requests
 * carrying a valid secret; every other request keeps request.ip from
 * Fastify's trusted-proxy logic (NETRICS_TRUSTED_PROXIES). The secret never
 * gates access: a request without it is served and authenticated like any
 * other, except that session cookies are accepted only through the frontend.
 *
 * Without NETRICS_PROXY_SECRET everything behaves as before: request.ip is
 * the client address and cookies are accepted on every request.
 */

export const PROXY_SECRET_HEADER = "x-netrics-proxy-secret";
/** Same name as the internal header the auth bridge hands to better-auth. */
export const FORWARDED_CLIENT_IP_HEADER = "x-netrics-client-ip";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * The client address for rate limits and audit: the address the web
     * frontend forwarded on a request with a valid proxy secret, otherwise
     * request.ip. Set by an onRequest hook before any route runs.
     */
    clientIp: string;
    /**
     * Whether the request carries a valid NETRICS_PROXY_SECRET, i.e. comes
     * from the web frontend. Always false while no secret is configured.
     */
    fromFrontend: boolean;
  }
}

/**
 * Whether the browser auth flow (/api/auth/*) is served to this request.
 * Without a configured secret, always (one origin, self-hosting unchanged).
 * With one, only through the web frontend: browsers reach /api/auth only via
 * the web origin, so on a separate API host (api.netrics.so) the flow does
 * not exist (ADR 0013, #158).
 */
export function servesAuthFlow(
  request: FastifyRequest,
  proxySecrets: readonly Secret[],
): boolean {
  return proxySecrets.length === 0 || request.fromFrontend;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Whether `presented` equals one of `secrets`, in time independent of where
 * the values differ and of their lengths (both sides are hashed first). Every
 * configured value is compared, so the time does not tell which one matched.
 */
export function matchesProxySecret(
  presented: string | undefined,
  secrets: readonly Secret[],
): boolean {
  if (presented === undefined || secrets.length === 0) {
    return false;
  }
  const candidate = digest(presented);
  let matched = false;
  for (const secret of secrets) {
    matched = timingSafeEqual(candidate, digest(secret.reveal())) || matched;
  }
  return matched;
}

function singleHeader(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** A single IPv4 or IPv6 address, nothing else (no lists, ports, zones). */
export function validClientIp(value: string | undefined): string | null {
  const address = value?.trim();
  return address && isIP(address) !== 0 ? address : null;
}

/**
 * Resolves request.clientIp for every request and enforces the cookie rule.
 * Registered before every other onRequest hook and route.
 */
export function registerClientAddress(
  app: FastifyInstance,
  proxySecrets: readonly Secret[],
): void {
  app.decorateRequest("clientIp", "");
  app.decorateRequest("fromFrontend", false);
  app.addHook("onRequest", async (request) => {
    const fromFrontend = matchesProxySecret(
      singleHeader(request, PROXY_SECRET_HEADER),
      proxySecrets,
    );
    const forwarded = fromFrontend
      ? validClientIp(singleHeader(request, FORWARDED_CLIENT_IP_HEADER))
      : null;
    request.clientIp = forwarded ?? request.ip;
    request.fromFrontend = fromFrontend;

    // Neither header travels further (better-auth, logs, handlers): the
    // secret is consumed here, and the auth bridge sets the client address
    // header from request.clientIp itself.
    delete request.headers[PROXY_SECRET_HEADER];
    delete request.headers[FORWARDED_CLIENT_IP_HEADER];

    // Session cookies only through the frontend: with a secret configured, a
    // request without it is authenticated by bearer token or not at all.
    if (proxySecrets.length > 0 && !fromFrontend) {
      delete request.headers.cookie;
    }
  });
}
