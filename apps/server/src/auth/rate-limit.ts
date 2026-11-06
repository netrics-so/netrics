/**
 * Auth rate limiting. better-auth counts requests per client IP and path in
 * the auth.rate_limit table, so the limits hold across API replicas.
 *
 * The client IP is never read from a header the client controls: Fastify
 * resolves request.ip from the socket and the trusted proxy hops
 * (NETRICS_TRUSTED_PROXIES); on a request carrying a valid
 * NETRICS_PROXY_SECRET the web frontend's forwarded address replaces it
 * (client-address.ts). The auth bridge hands better-auth exactly that
 * request.clientIp in CLIENT_IP_HEADER, overwriting anything the client sent.
 */

/**
 * Internal header carrying the resolved client IP into better-auth; the same
 * name the frontend forwards it under (FORWARDED_CLIENT_IP_HEADER).
 */
export const CLIENT_IP_HEADER = "x-netrics-client-ip";

interface Rule {
  /** Seconds. */
  window: number;
  max: number;
}

/** Everything not listed in AUTH_RATE_LIMIT_RULES. */
export const DEFAULT_AUTH_RATE_LIMIT: Rule = { window: 60, max: 100 };

/**
 * Explicit limits per client IP, keyed by path below /api/auth. Generous
 * enough for a team joining from one office address, tight enough to make
 * password guessing and reset-mail flooding slow.
 */
export const AUTH_RATE_LIMIT_RULES: Record<string, Rule | false> = {
  "/sign-in/*": { window: 60, max: 10 },
  "/sign-up/*": { window: 600, max: 20 },
  "/request-password-reset": { window: 900, max: 5 },
  "/forget-password": { window: 900, max: 5 },
  "/forget-password/*": { window: 900, max: 5 },
  "/reset-password": { window: 900, max: 10 },
  "/reset-password/*": { window: 900, max: 10 },
  "/send-verification-email": { window: 900, max: 5 },
  "/change-password": { window: 60, max: 5 },
  "/change-email": { window: 60, max: 5 },
  // The web server checks the session for every page render from its own
  // address, without a client IP; a per-IP limit would throttle all users
  // together. It only reads the session the cookie already proves.
  "/get-session": false,
};
