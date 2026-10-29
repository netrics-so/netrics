import { randomBytes, randomUUID } from "node:crypto";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";

import { APPLE_ADS_AUDIENCE, APPLE_ADS_SCOPE } from "./providers/apple-ads.js";
import { decodeJwt, type TestKeyPair } from "./test-keys.js";

// Tests only (#373): Apple's token endpoint and the parts of the Apple Ads
// Platform API the connector reads, in the shapes of Apple's documentation
// (packages/connectors/src/apple-ads/fixtures name the pages). The token
// endpoint verifies the signed client secret like Apple; the API accepts
// only tokens it issued and serves an ad account only in its own
// `X-AP-Context` and only to an API user whose ACL has it.

export interface FakeAdAccount {
  id: string;
  name: string;
  orgId: string;
  currency: string;
  timezone: string;
  productFeatures: string[];
  campaigns: Array<{ id: string; name: string; appId: string }>;
  /**
   * The campaign report (#374): one entry per campaign, day (the ad
   * account's) and country or region. Mutable (a revised day). A campaign
   * here need not be in `campaigns` (a deleted one keeps its history).
   */
  report?: FakeReportEntry[];
}

export interface FakeReportEntry {
  campaignId: string;
  appId: string;
  date: string;
  country: string;
  /** Spend as Apple's decimal string, in the account's currency. */
  spend: string;
  impressions: number;
  taps: number;
  tapInstalls: number;
  viewInstalls: number;
  /** The ad group of the entry (#376); default `${campaignId}01`. */
  adGroupId?: string;
}

export interface FakeApiUserKey {
  clientId: string;
  teamId: string;
  keyId: string;
  key: TestKeyPair;
  /** ACL: ad account ID → roles. Mutable (a lost ACL). */
  acl: Map<string, string[]>;
}

export function fakeApiUserKey(
  key: TestKeyPair,
  acl: Record<string, string[]>,
): FakeApiUserKey {
  return {
    clientId: `SEARCHADS.${randomUUID()}`,
    teamId: `SEARCHADS.${randomUUID()}`,
    keyId: randomUUID(),
    key,
    acl: new Map(Object.entries(acl)),
  };
}

export function apiUserCredentials(user: FakeApiUserKey) {
  return {
    clientId: user.clientId,
    teamId: user.teamId,
    keyId: user.keyId,
    privateKey: user.key.privateKeyPem,
  };
}

const API_ROLES = new Set([
  "API Account Read Only",
  "Limited Access: API Read Only",
  "API Account Manager",
  "Limited Access: API Read & Write",
  "Admin",
]);

function reply(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      "content-type": "application/json",
      "ratelimit-limit": "100",
      "ratelimit-remaining": "90",
      "ratelimit-reset": "30",
    },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

export interface FakeAppleAdsCall {
  path: string;
  /** The JSON body of a POST. */
  body?: unknown;
  token: string;
  context: string | undefined;
}

/** One day of entries as Apple's AppsMetrics (2-decimal amounts). */
function metricsOf(
  date: string,
  entries: FakeReportEntry[],
  currency: string,
): Record<string, unknown> {
  const add = (pick: (entry: FakeReportEntry) => number) =>
    entries.reduce((sum, entry) => sum + pick(entry), 0);
  const cents = entries.reduce(
    (sum, entry) => sum + BigInt(entry.spend.replace(".", "")),
    0n,
  );
  const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  const tap = add((entry) => entry.tapInstalls);
  const view = add((entry) => entry.viewInstalls);
  return {
    date,
    localSpend: { amount, currency },
    impressions: add((entry) => entry.impressions),
    taps: add((entry) => entry.taps),
    tapInstalls: tap,
    viewInstalls: view,
    totalInstalls: tap + view,
    tapNewDownloads: tap,
    viewNewDownloads: view,
    totalNewDownloads: tap + view,
    tapRedownloads: 0,
    viewRedownloads: 0,
    totalRedownloads: 0,
  };
}

interface ReportQueryBody {
  timeRange: { start: string; end: string; granularity?: string };
  filters?: Array<{ field: string; operator: string; value: unknown }>;
  groupBy?: string[];
  pagination: { offset: number; pageSize: number };
}

/**
 * `POST /v1/reports/apps/adgroups/query` as Apple documents it (#376):
 * the required campaignId filter, one row per ad group.
 */
function adGroupReport(account: FakeAdAccount, body: ReportQueryBody) {
  const { start, end, granularity } = body.timeRange;
  const campaignId = body.filters?.find(
    (filter) => filter.field === "campaignId" && filter.operator === "EQUALS",
  )?.value;
  const entries = (account.report ?? []).filter(
    (entry) =>
      entry.campaignId === campaignId &&
      entry.date >= start &&
      entry.date <= end,
  );
  const groups = new Map<string, FakeReportEntry[]>();
  for (const entry of entries) {
    const key = entry.adGroupId ?? `${entry.campaignId}01`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const rows = [...groups.keys()].sort().map((key) => {
    const members = groups.get(key)!;
    const dates = [...new Set(members.map((entry) => entry.date))].sort();
    const { date: _date, ...total } = metricsOf(
      start,
      members,
      account.currency,
    );
    return {
      metadata: {
        id: Number(key),
        campaignId: Number(campaignId),
        adAccountId: Number(account.id),
        name: `Ad group ${key}`,
        status: "ENABLED",
        deleted: false,
      },
      totalMetrics: total,
      ...(granularity
        ? {
            granularMetrics: dates.map((date) =>
              metricsOf(
                date,
                members.filter((entry) => entry.date === date),
                account.currency,
              ),
            ),
          }
        : {}),
    };
  });
  const { offset, pageSize } = body.pagination;
  return {
    result:
      rows.length > 0 ? { rows: rows.slice(offset, offset + pageSize) } : {},
    pagination: { totalCount: rows.length, offset, pageSize },
  };
}

/** `POST /v1/reports/apps/campaigns/query` as Apple documents it. */
function campaignReport(account: FakeAdAccount, body: ReportQueryBody) {
  const { start, end, granularity } = body.timeRange;
  const byCountry = body.groupBy?.includes("countryOrRegion") ?? false;
  const entries = (account.report ?? []).filter(
    (entry) => entry.date >= start && entry.date <= end,
  );
  const groups = new Map<string, FakeReportEntry[]>();
  for (const entry of entries) {
    const key = byCountry
      ? `${entry.campaignId}|${entry.country}`
      : entry.campaignId;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const rows = [...groups.keys()].sort().map((key) => {
    const members = groups.get(key)!;
    const first = members[0]!;
    const dates = [...new Set(members.map((entry) => entry.date))].sort();
    const days = dates.map((date) =>
      metricsOf(
        date,
        members.filter((entry) => entry.date === date),
        account.currency,
      ),
    );
    const { date: _date, ...total } = metricsOf(
      start,
      members,
      account.currency,
    );
    return {
      metadata: {
        id: Number(first.campaignId),
        name: `Campaign ${first.campaignId}`,
        adAccountId: Number(account.id),
        promotedObjectType: "APPSTORE_APP",
        promotedObjectId: first.appId,
        ...(byCountry ? { countryOrRegion: first.country } : {}),
      },
      totalMetrics: total,
      ...(granularity ? { granularMetrics: days } : {}),
    };
  });
  const { offset, pageSize } = body.pagination;
  return {
    result:
      rows.length > 0 ? { rows: rows.slice(offset, offset + pageSize) } : {},
    pagination: { totalCount: rows.length, offset, pageSize },
  };
}

export interface FakeAppleAdsServer {
  fetch(url: string, init?: ConnectorFetchInit): Promise<ConnectorResponse>;
  users: FakeApiUserKey[];
  exchanges: number;
  clientSecrets: string[];
  issued: string[];
  /** API calls (not the token endpoint). */
  calls: FakeAppleAdsCall[];
  /**
   * Answers queued ahead of the normal ones for API calls (not the token
   * endpoint): a 429 in the middle of a backfill.
   */
  failures: Array<{
    status: number;
    headers?: Record<string, string>;
    /** Only a call this matches gets the answer (default: the next). */
    match?: (call: FakeAppleAdsCall) => boolean;
  }>;
}

export function createFakeAppleAdsServer(
  accounts: FakeAdAccount[],
  users: FakeApiUserKey[],
): FakeAppleAdsServer {
  /** Issued token → its API user. */
  const tokens = new Map<string, FakeApiUserKey>();
  const server: FakeAppleAdsServer = {
    users,
    exchanges: 0,
    clientSecrets: [],
    issued: [],
    calls: [],
    failures: [],
    async fetch(raw, init = {}) {
      const url = new URL(raw);
      if (url.href === "https://appleid.apple.com/auth/oauth2/token") {
        const form = new URLSearchParams(init.body ?? "");
        const secret = form.get("client_secret") ?? "";
        server.clientSecrets.push(secret);
        const user = server.users.find(
          (entry) => entry.clientId === form.get("client_id"),
        );
        if (
          init.method !== "POST" ||
          !user ||
          form.get("grant_type") !== "client_credentials" ||
          form.get("scope") !== APPLE_ADS_SCOPE
        ) {
          return reply(400, { error: "invalid_client" });
        }
        let decoded;
        try {
          decoded = decodeJwt(secret, user.key.publicKey);
        } catch {
          return reply(400, { error: "invalid_client" });
        }
        const { header, claims } = decoded;
        if (
          !decoded.verifies ||
          header.alg !== "ES256" ||
          header.kid !== user.keyId ||
          claims.iss !== user.teamId ||
          claims.sub !== user.clientId ||
          claims.aud !== APPLE_ADS_AUDIENCE ||
          typeof claims.exp !== "number" ||
          claims.exp < Math.floor(Date.now() / 1000)
        ) {
          return reply(400, { error: "invalid_client" });
        }
        server.exchanges += 1;
        const token = `apple-ads-test-${randomBytes(18).toString("base64url")}`;
        server.issued.push(token);
        tokens.set(token, user);
        return reply(200, {
          access_token: token,
          token_type: "Bearer",
          expires_in: 3600,
          scope: APPLE_ADS_SCOPE,
        });
      }
      if (url.host !== "api.ads.apple.com") {
        return reply(404, {});
      }
      const headers = init.headers ?? {};
      const token = (headers.authorization ?? "").replace(/^Bearer /, "");
      const context = headers["x-ap-context"];
      server.calls.push({
        path: url.pathname,
        token,
        context,
        ...(init.body ? { body: JSON.parse(init.body) as unknown } : {}),
      });
      const call = server.calls.at(-1)!;
      const index = server.failures.findIndex(
        (failure) => !failure.match || failure.match(call),
      );
      const queued =
        index >= 0 ? server.failures.splice(index, 1)[0] : undefined;
      if (queued) {
        const response = reply(queued.status, {
          error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many requests" },
        });
        return {
          ...response,
          headers: { ...response.headers, ...queued.headers },
        };
      }
      const user = tokens.get(token);
      if (!user) {
        return reply(401, { error: { code: "UNAUTHORIZED", message: "" } });
      }
      if (url.pathname === "/v1/acls") {
        return reply(200, {
          result: {
            acls: [...user.acl].flatMap(([id, roles]) => {
              const account = accounts.find((entry) => entry.id === id);
              return account
                ? [
                    {
                      adAccount: {
                        id: Number(id),
                        name: account.name,
                        orgId: Number(account.orgId),
                      },
                      roles,
                    },
                  ]
                : [];
            }),
          },
        });
      }
      const contextId = /^adAccountId=(\d+)$/.exec(context ?? "")?.[1];
      const roles = contextId ? user.acl.get(contextId) : undefined;
      const account = accounts.find((entry) => entry.id === contextId);
      if (!account || !roles?.some((role) => API_ROLES.has(role))) {
        return reply(403, {
          error: { code: "FORBIDDEN", message: "Insufficient privileges" },
        });
      }
      if (url.pathname === `/v1/ad-accounts/${account.id}`) {
        return reply(200, {
          result: {
            id: Number(account.id),
            name: account.name,
            orgId: Number(account.orgId),
            timezone: account.timezone,
            currency: account.currency,
            systemStatus: "ACTIVE",
            systemStatusReasons: [],
            productFeatures: account.productFeatures,
          },
        });
      }
      if (url.pathname === "/v1/campaigns/query") {
        return reply(200, {
          result: account.campaigns.map((campaign) => ({
            id: Number(campaign.id),
            name: campaign.name,
            adAccountId: Number(account.id),
            promotedObjectType: "APPSTORE_APP",
            promotedObjectId: campaign.appId,
            status: "ENABLED",
            displayStatus: "RUNNING",
            deleted: false,
          })),
          pagination: {
            totalCount: account.campaigns.length,
            offset: 0,
            pageSize: 1000,
          },
        });
      }
      if (url.pathname === "/v1/reports/apps/campaigns/query") {
        return reply(
          200,
          campaignReport(
            account,
            JSON.parse(init.body ?? "{}") as ReportQueryBody,
          ),
        );
      }
      if (url.pathname === "/v1/reports/apps/adgroups/query") {
        return reply(
          200,
          adGroupReport(
            account,
            JSON.parse(init.body ?? "{}") as ReportQueryBody,
          ),
        );
      }
      const app = /^\/v1\/apps\/(\d+)$/.exec(url.pathname);
      if (app) {
        return reply(200, {
          result: { id: app[1], appName: `App ${app[1]}` },
        });
      }
      return reply(404, { error: { code: "NOT_FOUND", message: "" } });
    },
  };
  return server;
}
