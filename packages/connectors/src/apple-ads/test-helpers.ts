import { readFileSync } from "node:fs";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

/**
 * An offline stand-in for the parts of the Apple Ads Platform API the
 * connector uses, answering with fixtures shaped after Apple's
 * documentation (each fixture names its page; #370's captures confirm
 * them). An API user is known by its access tokens; any other token gets a
 * 401. Ad-account-scoped calls must carry `X-AP-Context: adAccountId=<id>`
 * of an account in the user's ACL with an API role, otherwise 403 (as a
 * token cannot read another account).
 */
export interface FakeApiUser {
  tokens: string[];
  /** The `/v1/acls` fixture name. */
  acls: string;
  /** Roles that read the API (the fake's view of UserAcl). */
  apiRoles?: string[];
}

export interface FakeAppleAdsOptions {
  users: FakeApiUser[];
  /** Answers queued ahead of the normal ones (429s, 5xx, …). */
  failures?: Array<{
    status: number;
    fixture?: string;
    headers?: Record<string, string>;
  }>;
  /** `RateLimit-Remaining` on every answer (default 90 of 100). */
  remaining?: number;
}

export interface RecordedRequest {
  url: URL;
  method: string;
  token: string;
  /** The `X-AP-Context` header, if sent. */
  context: string | undefined;
  body: unknown;
}

export interface FakeAppleAds {
  runtime: ConnectorRuntime;
  fetch: ConnectorRuntime["fetch"];
  requests: RecordedRequest[];
}

const DEFAULT_API_ROLES = [
  "API Account Read Only",
  "Limited Access: API Read Only",
  "API Account Manager",
  "Limited Access: API Read & Write",
  "Admin",
];

/** Paths that take no context header (Access overview). */
const UNSCOPED = new Set(["/v1/me", "/v1/acls"]);

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

function hasFixture(name: string): boolean {
  try {
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url));
    return true;
  } catch {
    return false;
  }
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

interface AclFixture {
  result: {
    acls: Array<{ adAccount: { id: number | string }; roles: string[] }>;
  };
}

export function createFakeAppleAds(options: FakeAppleAdsOptions): FakeAppleAds {
  const requests: RecordedRequest[] = [];
  const failures = [...(options.failures ?? [])];
  const remaining = options.remaining ?? 90;
  const rateHeaders = {
    "ratelimit-limit": "100",
    "ratelimit-remaining": String(remaining),
    "ratelimit-reset": "30",
  };
  const reply = (status: number, body: unknown) =>
    jsonResponse(status, body, rateHeaders);

  async function fetch(
    raw: string,
    init: ConnectorFetchInit = {},
  ): Promise<ConnectorResponse> {
    const url = new URL(raw);
    const headers = Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const token = (headers.authorization ?? "").replace(/^Bearer /, "");
    const context = headers["x-ap-context"];
    requests.push({
      url,
      method: init.method ?? "GET",
      token,
      context,
      body: init.body ? (JSON.parse(init.body) as unknown) : undefined,
    });
    if (url.host !== "api.ads.apple.com" || url.protocol !== "https:") {
      throw new Error(`fake Apple Ads: unexpected host ${url.host}`);
    }
    const queued = failures.shift();
    if (queued) {
      return jsonResponse(
        queued.status,
        queued.fixture ? fixture(queued.fixture) : {},
        { ...rateHeaders, ...queued.headers },
      );
    }
    const user = options.users.find((entry) => entry.tokens.includes(token));
    if (!user) {
      return reply(401, fixture("error-unauthorized"));
    }
    const acls = fixture(user.acls) as AclFixture;
    if (url.pathname === "/v1/acls" && (init.method ?? "GET") === "GET") {
      return reply(200, acls);
    }
    if (UNSCOPED.has(url.pathname)) {
      return reply(404, {});
    }
    // Every other call is ad-account scoped.
    const match = /^adAccountId=(\d+)$/.exec(context ?? "");
    const apiRoles = user.apiRoles ?? DEFAULT_API_ROLES;
    const acl = acls.result.acls.find(
      (entry) => String(entry.adAccount.id) === match?.[1],
    );
    if (!match || !acl || !acl.roles.some((role) => apiRoles.includes(role))) {
      return reply(403, fixture("error-forbidden"));
    }
    const adAccountId = match[1]!;
    const account = /^\/v1\/ad-accounts\/(\d+)$/.exec(url.pathname);
    if (account && init.method !== "POST") {
      // The path must name the context's own account.
      if (account[1] !== adAccountId) {
        return reply(403, fixture("error-forbidden"));
      }
      return reply(200, fixture(`ad-account-${adAccountId}`));
    }
    if (url.pathname === "/v1/campaigns/query" && init.method === "POST") {
      const name = `campaigns-${adAccountId}`;
      return reply(
        200,
        hasFixture(name)
          ? fixture(name)
          : {
              result: [],
              pagination: { totalCount: 0, offset: 0, pageSize: 0 },
            },
      );
    }
    const app = /^\/v1\/apps\/(\d+)$/.exec(url.pathname);
    if (app && hasFixture(`app-${app[1]}`)) {
      return reply(200, fixture(`app-${app[1]}`));
    }
    return reply(404, { error: { code: "NOT_FOUND", message: "Not found" } });
  }

  return {
    fetch,
    requests,
    runtime: { fetch, signal: new AbortController().signal },
  };
}
