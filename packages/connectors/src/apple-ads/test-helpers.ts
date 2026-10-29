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
  /** Campaign report data per ad account (fakeReport answers from it). */
  reports?: Record<string, FakeReport>;
}

/** The counts of one day in a fake report; unset fields are 0. */
export type FakeDay = Partial<{
  spend: string;
  impressions: number;
  taps: number;
  tapInstalls: number;
  viewInstalls: number;
  tapNewDownloads: number;
  viewNewDownloads: number;
  tapRedownloads: number;
  viewRedownloads: number;
}>;

export interface FakeReportCampaign {
  id: string;
  name: string;
  app: string;
  deleted?: boolean;
  /** Date → country or region → that day's numbers. */
  days: Record<string, Record<string, FakeDay>>;
  /**
   * Date → what the campaign total has beyond its countries (rows the
   * breakdown hides).
   */
  hidden?: Record<string, FakeDay>;
}

export interface FakeReport {
  currency: string;
  campaigns: FakeReportCampaign[];
}

const COUNT_FIELDS = [
  "impressions",
  "taps",
  "tapInstalls",
  "viewInstalls",
  "tapNewDownloads",
  "viewNewDownloads",
  "tapRedownloads",
  "viewRedownloads",
] as const;

/** Cents as Apple's decimal string ("12.30"); amounts here have 2 decimals. */
function cents(amount: string): bigint {
  const [whole, fraction = ""] = amount.split(".");
  const sign = whole!.startsWith("-") ? -1n : 1n;
  return BigInt(whole!) * 100n + sign * BigInt((fraction + "00").slice(0, 2));
}

function decimal(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/** One day as Apple's AppsMetrics, totals included. */
export function appsMetrics(
  date: string,
  days: FakeDay[],
  currency: string,
): Record<string, unknown> {
  const sum = (field: (typeof COUNT_FIELDS)[number]) =>
    days.reduce((total, day) => total + (day[field] ?? 0), 0);
  const spend = days.reduce(
    (total, day) => total + cents(day.spend ?? "0"),
    0n,
  );
  const metrics: Record<string, unknown> = {
    date,
    localSpend: { amount: decimal(spend), currency },
  };
  for (const field of COUNT_FIELDS) metrics[field] = sum(field);
  metrics.totalInstalls = sum("tapInstalls") + sum("viewInstalls");
  metrics.totalNewDownloads = sum("tapNewDownloads") + sum("viewNewDownloads");
  metrics.totalRedownloads = sum("tapRedownloads") + sum("viewRedownloads");
  metrics.ttr = 0;
  return metrics;
}

interface ReportBody {
  timeRange: {
    start: string;
    end: string;
    timeZone: string;
    granularity?: string;
  };
  groupBy?: string[];
  pagination: { offset: number; pageSize: number };
}

/**
 * Answers `POST /v1/reports/apps/campaigns/query` from a FakeReport like
 * Apple documents it: one row per campaign (or per campaign and country
 * with `groupBy: ["countryOrRegion"]`), `granularMetrics` per day with
 * data, no rows without metrics, offset paging with `totalCount`.
 */
export function fakeReport(
  report: FakeReport,
  adAccountId: string,
  body: ReportBody,
): { status: number; body: unknown } {
  const { start, end, timeZone, granularity } = body.timeRange;
  const span = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (
    timeZone !== "ORTZ" ||
    span < 1 ||
    (granularity === "DAILY" && span > 90) ||
    (granularity === undefined && span !== 1) ||
    body.pagination.pageSize > 5000
  ) {
    return {
      status: 400,
      body: {
        error: {
          code: "INVALID_REQUEST",
          message: "invalid report request",
          details: [],
        },
      },
    };
  }
  const byCountry = body.groupBy?.includes("countryOrRegion") ?? false;
  const rows: unknown[] = [];
  for (const campaign of [...report.campaigns].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const dates = Object.keys(campaign.days)
      .concat(Object.keys(campaign.hidden ?? {}))
      .filter((date, index, all) => all.indexOf(date) === index)
      .filter((date) => date >= start && date <= end)
      .sort();
    const metadata = {
      id: Number(campaign.id),
      name: campaign.name,
      adAccountId: Number(adAccountId),
      promotedObjectType: "APPSTORE_APP",
      promotedObjectId: campaign.app,
      status: campaign.deleted ? "PAUSED" : "ENABLED",
      deleted: campaign.deleted ?? false,
    };
    const asRow = (
      extra: Record<string, unknown>,
      granular: Record<string, unknown>[],
    ) => {
      if (granular.length === 0) return;
      // totalMetrics is the range's sum; netrics reads it only for one day.
      const { date: _date, ...total } = granular[0]!;
      rows.push({
        metadata: { ...metadata, ...extra },
        totalMetrics: total,
        ...(granularity ? { granularMetrics: granular } : {}),
      });
    };
    if (byCountry) {
      const countries = [
        ...new Set(
          dates.flatMap((date) => Object.keys(campaign.days[date] ?? {})),
        ),
      ].sort();
      for (const country of countries) {
        asRow(
          { countryOrRegion: country },
          dates.flatMap((date) => {
            const day = campaign.days[date]?.[country];
            return day ? [appsMetrics(date, [day], report.currency)] : [];
          }),
        );
      }
    } else {
      asRow(
        {},
        dates.map((date) =>
          appsMetrics(
            date,
            [
              ...Object.values(campaign.days[date] ?? {}),
              ...(campaign.hidden?.[date] ? [campaign.hidden[date]!] : []),
            ],
            report.currency,
          ),
        ),
      );
    }
  }
  const { offset, pageSize } = body.pagination;
  return {
    status: 200,
    body: {
      result:
        rows.length > 0 ? { rows: rows.slice(offset, offset + pageSize) } : {},
      pagination: { totalCount: rows.length, offset, pageSize },
    },
  };
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
    if (
      url.pathname === "/v1/reports/apps/campaigns/query" &&
      init.method === "POST"
    ) {
      const answer = fakeReport(
        options.reports?.[adAccountId] ?? { currency: "USD", campaigns: [] },
        adAccountId,
        JSON.parse(init.body ?? "{}") as ReportBody,
      );
      return reply(answer.status, answer.body);
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
