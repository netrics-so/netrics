// An offline stand-in for a custom JSON API (milestone 13): one route per
// pagination style, auth method and edge case the custom-api connector
// handles. Binds 127.0.0.1 only; data is deterministic. Test code only: it
// is reached through the `@netrics/connectors/custom-api/testing` subpath.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";

export const FIXTURE_SECRETS = {
  apiKey: "fx-api-key-0001",
  token: "fx-bearer-token-0001",
  username: "fx-user",
  password: "fx-pass-0001",
} as const;

/** The OAuth client the fixture's /oauth/* endpoints accept (#805). */
export const FIXTURE_OAUTH_CLIENT = {
  clientId: "fx-oauth-client",
  clientSecret: "fx-oauth-client-secret-0001",
} as const;

/**
 * The fixture's OAuth server state (#805). Test code only: it holds every
 * issued value so tests can assert that none of them leaks.
 */
export interface FixtureOAuthServer {
  /** Every code, access token and refresh token issued so far. */
  issued: string[];
  /** Each token request: grant type, client auth style and PKCE data. */
  tokenRequests: Array<{
    grantType: string;
    clientAuth: "body" | "basic" | "none";
    codeVerifier: string | null;
    codeChallenge: string | null;
    scope: string | null;
  }>;
  /** Each revocation request's token. */
  revoked: string[];
  /** Each revocation request's token and token_type_hint. */
  revokeRequests: Array<{ token: string; hint: string | null }>;
  /** Runs before a token request is answered (tests interleave work there). */
  onToken: (() => Promise<void> | void) | null;
  /** Runs before a revocation is answered (tests interleave work there). */
  onRevoke: (() => Promise<void> | void) | null;
  /** The client secret the token endpoint accepts (rotate to "revoke" the client). */
  clientSecret: string;
  /** Lifetime of new access tokens. */
  expiresIn: number;
  /** Makes every issued access token expired. */
  expireAccessTokens(): void;
  /** Revokes every refresh token (the user withdrew the grant). */
  revokeRefreshTokens(): void;
}

/** A credential the fixture knows but refuses with 403. */
export const FIXTURE_FORBIDDEN = "forbidden-key";

export interface RecordedRequest {
  method: string;
  /** Host header, e.g. "127.0.0.1:<port>" or "localhost:<port>". */
  host: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

export interface CustomApiFixtureServer {
  /** "http://127.0.0.1:<port>" or, with tls, "https://127.0.0.1:<port>". */
  origin: string;
  host: "127.0.0.1";
  port: number;
  /** The self-signed certificate (PEM) with tls, for egress `tlsCa`; null without. */
  ca: string | null;
  /** Every request since the start or the last reset(). */
  requests: RecordedRequest[];
  /** Clears the recorded requests (not the photo settings below). */
  reset(): void;
  /**
   * GET /photos: the newest records' `photo` become these /images/ paths
   * (newest first, e.g. "big.png", "html"); null restores the default.
   */
  setImages(paths: readonly string[] | null): void;
  /** GET /photos: adds `?sig=<value>` to every photo URL; null removes it. */
  signUrls(value: string | null): void;
  /** The /oauth/* endpoints' state (#805). */
  oauth: FixtureOAuthServer;
  close(): Promise<void>;
}

export interface FixtureItem {
  id: number;
  name: string;
  created_at: string;
  /** A decimal: a string on even ids, a number on odd ids. */
  price: string | number;
  image_url: string;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 25 items, ids 1..25, created 2024-01-01T00:00:00Z + n hours. */
export const FIXTURE_ITEMS: readonly Omit<FixtureItem, "image_url">[] =
  Array.from({ length: 25 }, (_, index) => {
    const id = index + 1;
    return {
      id,
      name: `Item ${id}`,
      created_at: new Date(Date.UTC(2024, 0, 1) + id * HOUR_MS).toISOString(),
      price: id % 2 === 0 ? `${id}.50` : id + 0.25,
    };
  });

export interface FixtureDay {
  date: string;
  orders: number;
  revenue: { amount: string; currency: string };
}

function dayOfYear(date: string): number {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return (
    Math.round((ms - Date.UTC(Number(date.slice(0, 4)), 0, 1)) / DAY_MS) + 1
  );
}

/** 2023-01-01 .. 2024-12-31: orders = day of year, revenue = orders × 1.5 EUR. */
export const FIXTURE_DAILY: readonly FixtureDay[] = (() => {
  const days: FixtureDay[] = [];
  for (
    let ms = Date.UTC(2023, 0, 1);
    ms <= Date.UTC(2024, 11, 31);
    ms += DAY_MS
  ) {
    const date = new Date(ms).toISOString().slice(0, 10);
    const orders = dayOfYear(date);
    days.push({
      date,
      orders,
      revenue: { amount: (orders * 1.5).toFixed(2), currency: "EUR" },
    });
  }
  return days;
})();

/**
 * Records of GET /edge/bad-values: ids that do not parse, "n/a" integers,
 * mixed date formats and decimals with too many fraction digits.
 */
export const FIXTURE_BAD_VALUES: readonly Record<string, unknown>[] = [
  { id: 1, orders: 3, day: "2024-01-01", price: "1.25" },
  { id: 2, orders: "n/a", day: "31.12.2024", price: "1.255" },
  { id: 3, orders: 4.5, day: "2024-01-03T10:00:00Z", price: 2 },
  { id: "x", orders: 1, day: "2024-01-04", price: "3.00" },
];

/**
 * Records of GET /photos (an image stream): 5 photos, one a day from
 * 2024-03-01, each pointing at a distinct generated PNG.
 */
export const FIXTURE_PHOTO_COUNT = 5;

/** Bytes over 2 MiB, served with a declared length by /images/big.png. */
export const FIXTURE_BIG_IMAGE_BYTES = 2_097_153;

const IMAGE_FILES: Record<string, string> = {
  "plain.png": "image/png",
  "plain.jpg": "image/jpeg",
  "lossy.webp": "image/webp",
  "gps.jpg": "image/jpeg",
};

const imageCache = new Map<string, Buffer>();

/** A test image copied from the server's image fixtures, read on first use. */
function imageFile(name: string): Buffer {
  let bytes = imageCache.get(name);
  if (!bytes) {
    bytes = readFileSync(new URL(`./images/${name}`, import.meta.url));
    imageCache.set(name, bytes);
  }
  return bytes;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, crc]);
}

/** A valid 2 × 2 RGB PNG whose colour (and so whose bytes) depends on `n`. */
export function fixturePng(n: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixel = [n & 0xff, (n >> 8) & 0xff, 0x80];
  const row = [0, ...pixel, ...pixel];
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([...row, ...row]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const PAGE_SIZE = 10;
const JSON_TYPE = "application/json; charset=utf-8";

let certificate: { key: string; cert: string } | undefined;

/** One self-signed certificate for IP 127.0.0.1 per process. */
function selfSignedCertificate(): { key: string; cert: string } {
  if (certificate) return certificate;
  const dir = mkdtempSync(join(tmpdir(), "netrics-custom-api-fixture-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "2",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(key) || !existsSync(cert))
    throw new Error("openssl did not write the fixture certificate");
  certificate = {
    key: readFileSync(key, "utf8"),
    cert: readFileSync(cert, "utf8"),
  };
  return certificate;
}

function single(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * Starts the fixture API on 127.0.0.1 (port 0 unless given). With
 * `tls: true` it serves https with a self-signed certificate for
 * 127.0.0.1 (exposed as `ca`); an object supplies key and certificate.
 */
export async function startCustomApiFixtureServer(
  options: {
    port?: number;
    tls?: boolean | { key: string; cert: string };
  } = {},
): Promise<CustomApiFixtureServer> {
  const tls =
    options.tls === true
      ? selfSignedCertificate()
      : options.tls === false || options.tls === undefined
        ? null
        : options.tls;
  const scheme = tls ? "https" : "http";
  const requests: RecordedRequest[] = [];
  let port = 0;
  let photoImages: readonly string[] | null = null;
  let photoSignature: string | null = null;
  const codes = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      challenge: string | null;
      scope: string | null;
    }
  >();
  /** Access token → expiry (ms). */
  const accessTokens = new Map<string, number>();
  /** Refresh token → the scope it was granted. */
  const refreshTokens = new Map<string, string | null>();
  const oauth: FixtureOAuthServer = {
    issued: [],
    tokenRequests: [],
    revoked: [],
    revokeRequests: [],
    onRevoke: null,
    onToken: null,
    clientSecret: FIXTURE_OAUTH_CLIENT.clientSecret,
    expiresIn: 3600,
    expireAccessTokens() {
      for (const token of accessTokens.keys()) accessTokens.set(token, 0);
    },
    revokeRefreshTokens() {
      refreshTokens.clear();
    },
  };
  const issue = (prefix: string) => {
    const value = `${prefix}-${randomBytes(12).toString("hex")}`;
    oauth.issued.push(value);
    return value;
  };

  /**
   * /oauth/authorize, /oauth/token, /oauth/revoke and /oauth/api/items.
   * Token URL query options: `rotate=1` rotates refresh tokens,
   * `norefresh=1` issues none, `scopesep=comma` lists granted scopes with
   * commas (GitHub, Slack), `tokentype=<type>` answers that token_type
   * (`none` omits it; Slack answers "bot"), `grantscope=<scope>` grants
   * that scope whatever was asked for.
   */
  const handleOAuth = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    headers: Record<string, string>,
    send: (
      status: number,
      body: unknown,
      extra?: Record<string, string>,
    ) => void,
  ) => {
    const query = url.searchParams;
    if (url.pathname === "/oauth/authorize") {
      const redirectUri = query.get("redirect_uri") ?? "";
      if (
        query.get("response_type") !== "code" ||
        query.get("client_id") !== FIXTURE_OAUTH_CLIENT.clientId ||
        !redirectUri
      )
        return send(400, { error: "invalid_request" });
      const challenge = query.get("code_challenge");
      if (challenge && query.get("code_challenge_method") !== "S256")
        return send(400, { error: "invalid_request" });
      const code = issue("fx-code");
      codes.set(code, {
        clientId: FIXTURE_OAUTH_CLIENT.clientId,
        redirectUri,
        challenge,
        scope: query.get("scope"),
      });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      const state = query.get("state");
      if (state) target.searchParams.set("state", state);
      response.writeHead(302, { location: target.toString() });
      return response.end();
    }
    if (url.pathname === "/oauth/api/items") {
      const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
      const expires = bearer ? accessTokens.get(bearer) : undefined;
      if (expires === undefined || expires <= Date.now())
        return send(401, { error: "invalid_token" });
      return send(200, {
        data: FIXTURE_ITEMS.slice(0, 3).map((item) => ({ ...item })),
      });
    }
    if (
      request.method !== "POST" ||
      (url.pathname !== "/oauth/token" && url.pathname !== "/oauth/revoke")
    )
      return send(404, { error: "not found" });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      let clientId = body.get("client_id");
      let clientSecret = body.get("client_secret");
      let clientAuth: "body" | "basic" | "none" = clientId ? "body" : "none";
      const basic = /^Basic (.+)$/.exec(headers.authorization ?? "")?.[1];
      if (basic) {
        const [id, secret] = Buffer.from(basic, "base64")
          .toString("utf8")
          .split(":")
          .map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
        clientId = id ?? null;
        clientSecret = secret ?? null;
        clientAuth = "basic";
      }
      if (
        clientId !== FIXTURE_OAUTH_CLIENT.clientId ||
        clientSecret !== oauth.clientSecret
      )
        return send(401, { error: "invalid_client" });
      if (url.pathname === "/oauth/revoke") {
        const token = body.get("token") ?? "";
        oauth.revoked.push(token);
        oauth.revokeRequests.push({
          token,
          hint: body.get("token_type_hint"),
        });
        refreshTokens.delete(token);
        accessTokens.delete(token);
        void Promise.resolve(oauth.onRevoke?.()).finally(() => send(200, {}));
        return;
      }
      const respond = () => {
        const grantType = body.get("grant_type") ?? "";
        const verifier = body.get("code_verifier");
        const code = body.get("code");
        const stored = code ? codes.get(code) : undefined;
        oauth.tokenRequests.push({
          grantType,
          clientAuth,
          codeVerifier: verifier,
          codeChallenge: stored?.challenge ?? null,
          scope: body.get("scope") ?? stored?.scope ?? null,
        });
        const tokenType = (): Record<string, string> => {
          const type = query.get("tokentype");
          return type === "none" ? {} : { token_type: type ?? "Bearer" };
        };
        const granted = (requested: string | null) => {
          const scope = query.get("grantscope") ?? requested;
          return scope && query.get("scopesep") === "comma"
            ? scope.split(" ").join(",")
            : scope;
        };
        const tokens = (scope: string | null, refresh: boolean) => {
          const accessToken = issue("fx-access");
          accessTokens.set(accessToken, Date.now() + oauth.expiresIn * 1000);
          const refreshToken =
            refresh && query.get("norefresh") !== "1"
              ? issue("fx-refresh")
              : null;
          if (refreshToken) refreshTokens.set(refreshToken, scope);
          return send(200, {
            access_token: accessToken,
            ...tokenType(),
            expires_in: oauth.expiresIn,
            ...(refreshToken ? { refresh_token: refreshToken } : {}),
            ...(granted(scope) ? { scope: granted(scope) } : {}),
          });
        };
        switch (grantType) {
          case "client_credentials":
            return tokens(body.get("scope"), false);
          case "authorization_code": {
            if (!code || !stored) return send(400, { error: "invalid_grant" });
            codes.delete(code);
            if (body.get("redirect_uri") !== stored.redirectUri)
              return send(400, { error: "invalid_grant" });
            if (stored.challenge) {
              const expected = verifier
                ? createHash("sha256").update(verifier).digest("base64url")
                : null;
              if (expected !== stored.challenge)
                return send(400, { error: "invalid_grant" });
            }
            return tokens(stored.scope, true);
          }
          case "refresh_token": {
            const token = body.get("refresh_token") ?? "";
            if (!refreshTokens.has(token))
              return send(400, { error: "invalid_grant" });
            const accessToken = issue("fx-access");
            accessTokens.set(accessToken, Date.now() + oauth.expiresIn * 1000);
            const scope = refreshTokens.get(token) ?? null;
            let rotated: string | null = null;
            if (query.get("rotate") === "1") {
              refreshTokens.delete(token);
              rotated = issue("fx-refresh");
              refreshTokens.set(rotated, scope);
            }
            return send(200, {
              access_token: accessToken,
              ...tokenType(),
              expires_in: oauth.expiresIn,
              ...(rotated ? { refresh_token: rotated } : {}),
              ...(granted(scope) ? { scope: granted(scope) } : {}),
            });
          }
          default:
            return send(400, { error: "unsupported_grant_type" });
        }
      };
      // A test may hold the answer (the request is already recorded).
      const hook = oauth.onToken;
      if (hook) {
        void Promise.resolve(hook()).finally(respond);
        return;
      }
      return respond();
    });
  };

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const host = single(request.headers.host);
    const url = new URL(request.url ?? "/", `${scheme}://${host || "x"}`);
    const query = Object.fromEntries(url.searchParams);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers))
      headers[name.toLowerCase()] = single(value);
    requests.push({
      method: request.method ?? "GET",
      host,
      path: url.pathname,
      query,
      headers,
    });
    const origin = `${scheme}://127.0.0.1:${port}`;
    const otherOrigin = `${scheme}://localhost:${port}`;
    const items = FIXTURE_ITEMS.map((item) => ({
      ...item,
      image_url: `${origin}/images/${item.id}.png`,
    }));
    const send = (
      status: number,
      body: unknown,
      extra: Record<string, string> = {},
    ) => {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      response.writeHead(status, {
        "content-type": typeof body === "string" ? "text/html" : JSON_TYPE,
        ...extra,
      });
      response.end(text);
    };
    const int = (name: string, fallback: number) => {
      const value = Number(query[name] ?? "");
      return query[name] !== undefined &&
        query[name] !== "" &&
        Number.isSafeInteger(value)
        ? value
        : fallback;
    };
    const authorize = (
      ok: boolean,
      forbidden: boolean,
      onOk: () => void = () => send(200, { data: items.slice(0, 3) }),
    ) => {
      if (forbidden) send(403, { error: "forbidden" });
      else if (!ok) send(401, { error: "unauthorized" });
      else onOk();
    };

    if (url.pathname.startsWith("/oauth/"))
      return handleOAuth(request, response, url, headers, send);

    switch (url.pathname) {
      case "/items/pages": {
        const page = int("page", 1);
        const size = int("per_page", PAGE_SIZE);
        const start = (page - 1) * size;
        return send(200, {
          data: start < 0 ? [] : items.slice(start, start + size),
        });
      }
      case "/items/offset": {
        const offset = int("offset", 0);
        const limit = int("limit", PAGE_SIZE);
        return send(200, { items: items.slice(offset, offset + limit) });
      }
      case "/items/cursor": {
        const start = query.cursor ? Number(query.cursor.slice(1)) : 0;
        const end = start + PAGE_SIZE;
        return send(200, {
          data: items.slice(start, end),
          meta: { next: end < items.length ? `c${end}` : null },
        });
      }
      case "/items/next-body": {
        const after = int("after", 0);
        const end = after + PAGE_SIZE;
        return send(200, {
          data: items.slice(after, end),
          links: {
            next:
              end < items.length
                ? `${origin}/items/next-body?after=${end}`
                : null,
          },
        });
      }
      case "/items/next-link": {
        const after = int("after", 0);
        const end = after + PAGE_SIZE;
        return send(
          200,
          { data: items.slice(after, end) },
          end < items.length
            ? {
                link: `<${origin}/items/next-link?after=${end}>; rel="next", <${origin}/items/next-link>; rel="first"`,
              }
            : {},
        );
      }
      case "/stats":
        return send(200, { visitors: 1234, as_of: "2024-01-01" });
      case "/daily": {
        const unix = query.fmt === "unix";
        const instant = (value: string | undefined, fallback: number) => {
          if (!value) return fallback;
          const ms = unix ? Number(value) * 1000 : Date.parse(value);
          return Number.isFinite(ms) ? ms : fallback;
        };
        const from = instant(query.from, -Infinity);
        const to = instant(query.to, Infinity);
        const days = FIXTURE_DAILY.filter((day) => {
          const ms = Date.parse(`${day.date}T00:00:00Z`);
          return ms >= from && ms < to;
        }).map((day) =>
          unix
            ? { ...day, date: Date.parse(`${day.date}T00:00:00Z`) / 1000 }
            : day,
        );
        return send(200, { data: days });
      }
      case "/auth/api-key-header": {
        const key = headers["x-api-key"];
        return authorize(
          key === FIXTURE_SECRETS.apiKey,
          key === FIXTURE_FORBIDDEN,
        );
      }
      case "/auth/api-key-query": {
        const key = query.api_key;
        return authorize(
          key === FIXTURE_SECRETS.apiKey,
          key === FIXTURE_FORBIDDEN,
          () =>
            query.bad === undefined
              ? send(200, { data: items.slice(0, 3) })
              : // An API that echoes the key it was sent (Review Focus 3).
                send(400, { error: `bad request for key ${key}` }),
        );
      }
      case "/auth/api-key-query-echo": {
        // Next links built from the request URI, echoing the key (as
        // frameworks do); the second page fails.
        const key = query.api_key;
        const after = int("after", 0);
        return authorize(
          key === FIXTURE_SECRETS.apiKey,
          key === FIXTURE_FORBIDDEN,
          () =>
            after === 0
              ? send(200, {
                  data: items.slice(0, PAGE_SIZE),
                  links: {
                    next: `${origin}/auth/api-key-query-echo?after=${PAGE_SIZE}&api_key=${key}`,
                  },
                })
              : send(500, { error: "page two is broken" }),
        );
      }
      case "/auth/api-key-self-link": {
        // The last page links to itself, with the key placed first.
        const key = query.api_key;
        const after = int("after", 0);
        return authorize(
          key === FIXTURE_SECRETS.apiKey,
          key === FIXTURE_FORBIDDEN,
          () =>
            send(200, {
              data: items.slice(after, after + PAGE_SIZE),
              links: {
                next: `${origin}/auth/api-key-self-link?api_key=${key}&after=${PAGE_SIZE}`,
              },
            }),
        );
      }
      case "/auth/bearer": {
        const value = headers.authorization;
        return authorize(
          value === `Bearer ${FIXTURE_SECRETS.token}`,
          value === `Bearer ${FIXTURE_FORBIDDEN}`,
        );
      }
      case "/auth/bearer-custom": {
        const value = headers["x-token"];
        return authorize(
          value === `Token ${FIXTURE_SECRETS.token}`,
          value === `Token ${FIXTURE_FORBIDDEN}`,
        );
      }
      case "/auth/basic": {
        const value = headers.authorization;
        const expected = Buffer.from(
          `${FIXTURE_SECRETS.username}:${FIXTURE_SECRETS.password}`,
        ).toString("base64");
        const forbidden = Buffer.from(
          `${FIXTURE_SECRETS.username}:${FIXTURE_FORBIDDEN}`,
        ).toString("base64");
        return authorize(
          value === `Basic ${expected}`,
          value === `Basic ${forbidden}`,
        );
      }
      case "/edge/next-cycle": {
        // first → a → b → a: a cycle of two pages.
        const page = query.p;
        const next = page === "a" ? "b" : "a";
        const at = page === "b" ? PAGE_SIZE : 0;
        return send(200, {
          data: items.slice(at, at + PAGE_SIZE),
          links: { next: `${origin}/edge/next-cycle?p=${next}` },
        });
      }
      case "/edge/next-reorder":
        // The second page links to itself with its parameters reordered.
        return send(200, {
          data: items.slice(0, PAGE_SIZE),
          links: {
            next:
              query.x === undefined
                ? `${origin}/edge/next-reorder?x=1&y=2`
                : `${origin}/edge/next-reorder?y=2&x=1`,
          },
        });
      case "/edge/next-off-host":
        return send(200, {
          data: items.slice(0, PAGE_SIZE),
          links: { next: `${otherOrigin}/items/next-body?after=${PAGE_SIZE}` },
        });
      case "/edge/redirect-off-host":
        response.writeHead(302, { location: `${otherOrigin}/items/pages` });
        return response.end();
      case "/edge/repeat-cursor":
        return send(200, {
          data: items.slice(0, PAGE_SIZE),
          meta: { next: "same" },
        });
      case "/edge/endless": {
        const n = query.cursor ? Number(query.cursor) : 0;
        const id = Number.isSafeInteger(n) ? n : 0;
        return send(200, {
          data: [
            {
              id: id + 1,
              name: `Endless ${id + 1}`,
              created_at: items[0]!.created_at,
              price: "1.00",
            },
          ],
          meta: { next: String(id + 1) },
        });
      }
      case "/edge/bad-values":
        return send(200, { data: FIXTURE_BAD_VALUES });
      case "/edge/not-json":
        return send(200, "<!doctype html><title>Not JSON</title>");
      case "/edge/deep": {
        const depth = 100;
        response.writeHead(200, { "content-type": JSON_TYPE });
        return response.end(`${'{"a":'.repeat(depth)}1${"}".repeat(depth)}`);
      }
      case "/edge/429":
        return send(429, { error: "slow down" }, { "retry-after": "120" });
      // Builder routes (B-G1, #806): a two-page stats feed, an endpoint that
      // echoes the request (token included), a huge page, and a health
      // check for the e2e web server.
      case "/builder/stats": {
        const bearer =
          headers.authorization === `Bearer ${FIXTURE_SECRETS.token}`;
        if (!bearer) return send(401, { error: "unauthorized" });
        const page = query.cursor === "p2" ? 2 : 1;
        const start = Date.parse(
          `${/^\d{4}-\d{2}-\d{2}$/.test(query.from ?? "") ? query.from : "2024-01-01"}T00:00:00Z`,
        );
        const first = Number.isFinite(start) ? start : Date.UTC(2024, 0, 1);
        const data = Array.from({ length: 3 }, (_, index) => {
          const day = (page - 1) * 3 + index;
          return {
            date: new Date(first + day * DAY_MS).toISOString().slice(0, 10),
            orders: day + 1,
            revenue: { amount: "12.50", currency: "EUR" },
          };
        });
        return send(200, { data, meta: { next: page === 1 ? "p2" : null } });
      }
      case "/builder/echo": {
        const bearer =
          headers.authorization === `Bearer ${FIXTURE_SECRETS.token}`;
        if (!bearer) return send(401, { error: "unauthorized" });
        return send(200, {
          data: [{ url: `${origin}${request.url ?? "/"}`, headers }],
          whoami: headers.authorization,
        });
      }
      case "/builder/echo-query":
        // Echoes its own URL, query (and so a query API key) included.
        return send(200, { data: [{ url: `${origin}${request.url ?? "/"}` }] });
      case "/builder/wide":
        // 100 records of 10 texts of 2,000 characters (about 2 MB).
        return send(200, {
          data: Array.from({ length: 100 }, (_, index) =>
            Object.fromEntries(
              Array.from({ length: 10 }, (_, field) => [
                `f${field}`,
                `${index}:`.padEnd(2_000, "w"),
              ]),
            ),
          ),
        });
      case "/builder/huge":
        return send(200, {
          data: Array.from({ length: 100_000 }, (_, index) => ({
            id: index + 1,
            name: `Row ${index + 1}`,
          })),
        });
      case "/health":
        return send(200, { ok: true });
      case "/photos": {
        // Newest first by taken_at; photo paths per setImages/signUrls.
        const photos = Array.from({ length: FIXTURE_PHOTO_COUNT }, (_, i) => {
          const n = FIXTURE_PHOTO_COUNT - i;
          const path = photoImages?.[i] ?? `n/${n}.png`;
          const sig = photoSignature
            ? `?sig=${encodeURIComponent(photoSignature)}`
            : "";
          return {
            id: n,
            taken_at: new Date(Date.UTC(2024, 2, n)).toISOString(),
            title: `Photo ${n}`,
            photo: `${origin}/images/${path}${sig}`,
          };
        });
        return send(200, { data: photos });
      }
      case "/images/big.png": {
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(FIXTURE_BIG_IMAGE_BYTES),
        });
        return response.end(Buffer.alloc(FIXTURE_BIG_IMAGE_BYTES));
      }
      case "/images/html":
        return send(200, "<!doctype html><title>Not an image</title>");
      case "/images/redirect-other-host":
        response.writeHead(302, {
          location: `${otherOrigin}/images/plain.png`,
        });
        return response.end();
      case "/images/slow":
        // Never answers; close() ends the connection.
        return;
      case "/images/auth-required.png":
        if (headers.authorization !== `Bearer ${FIXTURE_SECRETS.token}`)
          return send(401, { error: "unauthorized" });
        response.writeHead(200, { "content-type": "image/png" });
        return response.end(imageFile("plain.png"));
      default: {
        const file = /^\/images\/([a-z]+\.(?:png|jpg|webp))$/.exec(
          url.pathname,
        )?.[1];
        if (file && IMAGE_FILES[file]) {
          response.writeHead(200, { "content-type": IMAGE_FILES[file] });
          return response.end(imageFile(file));
        }
        const generated = /^\/images\/n\/(\d{1,4})\.png$/.exec(url.pathname);
        if (generated) {
          response.writeHead(200, { "content-type": "image/png" });
          return response.end(fixturePng(Number(generated[1])));
        }
        return send(404, { error: "not found" });
      }
    }
  };

  const server: Server = tls
    ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler)
    : createHttpServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    origin: `${scheme}://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    ca: tls ? tls.cert : null,
    requests,
    reset() {
      requests.length = 0;
    },
    setImages(paths) {
      photoImages = paths ? [...paths] : null;
    },
    signUrls(value) {
      photoSignature = value;
    },
    oauth,
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
