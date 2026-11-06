import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

/**
 * An offline stand-in for the parts of the Search Console API the connector
 * uses, shaped like the recorded fixtures. Values derive only from (site,
 * date, keys), so any window asking for a day gets the same numbers.
 */
export interface FakeSite {
  siteUrl: string;
  permissionLevel: string;
}

export const FAKE_TOKEN = "ya29.fake-access-token-0123456789";

export const FAKE_SITES: FakeSite[] = [
  { siteUrl: "https://www.example.com/", permissionLevel: "siteOwner" },
  { siteUrl: "sc-domain:example.org", permissionLevel: "siteFullUser" },
  {
    siteUrl: "https://blog.example.net/",
    permissionLevel: "siteRestrictedUser",
  },
  {
    siteUrl: "https://unverified.example.com/",
    permissionLevel: "siteUnverifiedUser",
  },
];

export interface FakeSearchConsoleOptions {
  token?: string;
  sites?: FakeSite[];
  /** The fake's today (UTC date); final data ends `finalLagDays` before. */
  today?: string;
  finalLagDays?: number;
  /** Distinct pages per site (to exceed a page of rows). */
  pageCount?: number;
  /** Listed sites whose queries answer 403 (access removed since). */
  forbiddenSites?: string[];
  /** Answers queued ahead of the normal ones (429s, 5xx, …). */
  failures?: Array<{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }>;
}

export interface RecordedQuery {
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions: string[];
  rowLimit: number;
  startRow: number;
  dataState: string | undefined;
  type: string | undefined;
}

export interface FakeSearchConsole {
  runtime: ConnectorRuntime;
  requests: Array<{ url: URL; init: ConnectorFetchInit | undefined }>;
  queries: RecordedQuery[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const QUERIES = [
  "netrics",
  "netrics dashboard",
  "tv dashboard",
  "search console metrics",
  "apple tv kpi",
  "open source analytics",
];
const COUNTRIES = ["usa", "deu", "fra", "gbr", "ind"];
const DEVICES = ["DESKTOP", "MOBILE", "TABLET"];
const VALID_DIMENSIONS = [
  "date",
  "page",
  "query",
  "country",
  "device",
  "searchAppearance",
];

function hash(input: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function response(
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

function googleError(
  code: number,
  status: string,
  reason: string,
  message: string,
) {
  return {
    error: {
      code,
      message,
      errors: [{ message, domain: "global", reason }],
      status,
    },
  };
}

function metrics(seed: number, scale: number) {
  const impressions = scale * (20 + (seed % 400));
  const clicks = Math.floor(impressions / (4 + ((seed >>> 9) % 20)));
  return {
    clicks,
    impressions,
    ctr: clicks / impressions,
    position: 1 + ((seed >>> 4) % 400) / 10,
  };
}

function origin(siteUrl: string): string {
  return siteUrl.startsWith("sc-domain:")
    ? `https://${siteUrl.slice("sc-domain:".length)}/`
    : siteUrl;
}

export function createFakeSearchConsole(
  options: FakeSearchConsoleOptions = {},
): FakeSearchConsole {
  const token = options.token ?? FAKE_TOKEN;
  const sites = options.sites ?? FAKE_SITES;
  const today = options.today ?? "2024-01-20";
  const lastFinal =
    Date.parse(`${today}T00:00:00.000Z`) - (options.finalLagDays ?? 3) * DAY_MS;
  const pageCount = options.pageCount ?? 6;
  const forbidden = new Set(options.forbiddenSites ?? []);
  const failures = [...(options.failures ?? [])];
  const requests: FakeSearchConsole["requests"] = [];
  const queries: RecordedQuery[] = [];

  const values = (siteUrl: string, dimension: string): string[] => {
    switch (dimension) {
      case "page":
        return Array.from(
          { length: pageCount },
          (_, index) => `${origin(siteUrl)}p/${index}`,
        );
      case "query":
        return QUERIES;
      case "country":
        return COUNTRIES;
      case "device":
        return DEVICES;
      default:
        return [];
    }
  };

  const handle = (url: URL, init?: ConnectorFetchInit): ConnectorResponse => {
    if (init?.headers?.authorization !== `Bearer ${token}`) {
      return response(
        401,
        googleError(
          401,
          "UNAUTHENTICATED",
          "authError",
          "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.",
        ),
      );
    }
    const failure = failures.shift();
    if (failure) {
      return response(failure.status, failure.body ?? {}, failure.headers);
    }
    if (url.pathname === "/webmasters/v3/sites" && init?.method === "GET") {
      return response(200, { siteEntry: sites });
    }
    const match =
      /^\/webmasters\/v3\/sites\/([^/]+)\/searchAnalytics\/query$/.exec(
        url.pathname,
      );
    if (!match || init?.method !== "POST") {
      return response(
        404,
        googleError(404, "NOT_FOUND", "notFound", "Not Found"),
      );
    }
    const siteUrl = decodeURIComponent(match[1]!);
    const site = sites.find((candidate) => candidate.siteUrl === siteUrl);
    if (
      !site ||
      site.permissionLevel === "siteUnverifiedUser" ||
      forbidden.has(siteUrl)
    ) {
      return response(
        403,
        googleError(
          403,
          "PERMISSION_DENIED",
          "forbidden",
          `User does not have sufficient permission for site '${siteUrl}'. See also: https://support.google.com/webmasters/answer/2451999.`,
        ),
      );
    }
    const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
    const dimensions = (body.dimensions as string[] | undefined) ?? [];
    const rowLimit = (body.rowLimit as number | undefined) ?? 1000;
    const startRow = (body.startRow as number | undefined) ?? 0;
    const startDate = String(body.startDate);
    const endDate = String(body.endDate);
    queries.push({
      siteUrl,
      startDate,
      endDate,
      dimensions,
      rowLimit,
      startRow,
      dataState: body.dataState as string | undefined,
      type: body.type as string | undefined,
    });
    if (
      rowLimit > 25_000 ||
      rowLimit < 1 ||
      dimensions.some((dimension) => !VALID_DIMENSIONS.includes(dimension)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
      startDate > endDate
    ) {
      return response(
        400,
        googleError(400, "INVALID_ARGUMENT", "badRequest", "Invalid request."),
      );
    }

    const dates: string[] = [];
    for (
      let ms = Date.parse(`${startDate}T00:00:00.000Z`);
      ms <= Date.parse(`${endDate}T00:00:00.000Z`) && ms <= lastFinal;
      ms += DAY_MS
    ) {
      dates.push(new Date(ms).toISOString().slice(0, 10));
    }
    if (dates.length === 0) {
      return response(200, { responseAggregationType: "byProperty" });
    }

    // Every combination of the requested dimensions' values.
    let combinations: Array<Record<string, string>> = [{}];
    for (const dimension of dimensions) {
      const options = dimension === "date" ? dates : values(siteUrl, dimension);
      combinations = combinations.flatMap((combination) =>
        options.map((value) => ({ ...combination, [dimension]: value })),
      );
    }
    const rows = combinations.flatMap((combination) => {
      const rowDates =
        combination.date !== undefined ? [combination.date] : dates;
      let clicks = 0;
      let impressions = 0;
      let weighted = 0;
      for (const date of rowDates) {
        const keys = dimensions
          .filter((dimension) => dimension !== "date")
          .map((dimension) => `${dimension}=${combination[dimension]}`)
          .join("&");
        const value = metrics(
          hash(`${siteUrl}|${date}|${keys}`),
          keys === "" ? 10 : 1,
        );
        clicks += value.clicks;
        impressions += value.impressions;
        weighted += value.position * value.impressions;
      }
      return [
        {
          ...(dimensions.length > 0
            ? { keys: dimensions.map((dimension) => combination[dimension]!) }
            : {}),
          clicks,
          impressions,
          ctr: clicks / impressions,
          position: weighted / impressions,
        },
      ];
    });
    rows.sort(
      (a, b) =>
        b.clicks - a.clicks ||
        (a.keys ?? []).join("|").localeCompare((b.keys ?? []).join("|")),
    );
    const page = rows.slice(startRow, startRow + rowLimit);
    return response(200, {
      ...(page.length > 0 ? { rows: page } : {}),
      responseAggregationType: dimensions.includes("page")
        ? "byPage"
        : "byProperty",
    });
  };

  return {
    requests,
    queries,
    runtime: {
      signal: new AbortController().signal,
      fetch: async (raw, init) => {
        const url = new URL(raw);
        requests.push({ url, init });
        if (
          url.protocol !== "https:" ||
          url.hostname !== "searchconsole.googleapis.com"
        ) {
          throw new Error(`fake Search Console refuses ${raw}`);
        }
        return handle(url, init);
      },
    },
  };
}
