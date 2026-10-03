import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

/**
 * An offline stand-in for the parts of the App Store Connect API the
 * connector uses, answering with the sanitized fixtures. Each team is known
 * by the bearer tokens of its key; every other token gets Apple's 401.
 */
export interface FakeTeam {
  /** Tokens this team's key signs (any other token is refused). */
  tokens: string[];
  /** Apps listed by GET /v1/apps, in fixture-page shape. */
  appPages?: unknown[];
  vendorNumbers: string[];
  /**
   * "sales" (Sales/Finance, the default) reads reports but no reviews;
   * "admin" reads both and requests analytics reports; "developer" and
   * "customer-support" read reviews but no sales.
   */
  role?: "sales" | "admin" | "developer" | "customer-support";
  /**
   * Customer review pages (#190) by request path, with `?cursor=<c>` for a
   * page reached through links.next. An app without pages has no reviews.
   */
  reviewPages?: Record<string, unknown>;
  /** The Account Holder has not accepted the current agreements. */
  agreementsMissing?: boolean;
  /** Days (YYYY-MM-DD) with sales (SALES_REPORT_TSV); other days answer 404. */
  salesDays?: string[];
  /** Reports per day (YYYY-MM-DD): TSV text served gzipped, or raw bytes. */
  reports?: Record<string, string | Uint8Array>;
  /** Days whose report is not published yet (404 "not available yet"). */
  pendingDays?: string[];
  /** The Analytics Reports API of this team (#174). */
  analytics?: FakeAnalytics;
}

/**
 * Analytics endpoints served from fixtures: JSON:API pages by request path
 * (with `?cursor=<c>` for a page reached through links.next), and the
 * segment files of the presigned S3 links by path.
 */
export interface FakeAnalytics {
  pages: Record<string, unknown>;
  files?: Record<string, Uint8Array>;
  /**
   * How POST /v1/analyticsReportRequests answers: created (201), 409
   * (already requested), or by role (default: 201 for "admin", else 403).
   */
  create?: "created" | "conflict";
}

/** The pinned production bucket host of analytics segment links. */
export const SEGMENT_HOST = "asp-us-west-2.s3.us-west-2.amazonaws.com";

/** A segment file fixture (`fixtures/<name>.csv.gz`) as bytes. */
export function segmentFixture(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}.csv.gz`, import.meta.url)),
  );
}

export interface FakeAppStoreConnectOptions {
  teams: FakeTeam[];
  /** Answers queued ahead of the normal ones (429s, 5xx, …). */
  failures?: Array<{
    status: number;
    fixture?: string;
    headers?: Record<string, string>;
  }>;
  /** X-Rate-Limit user-hour-rem on every answer (default 3000). */
  remaining?: number;
}

export interface FakeAppStoreConnect {
  runtime: ConnectorRuntime;
  fetch: ConnectorRuntime["fetch"];
  requests: Array<{ url: URL; init: ConnectorFetchInit | undefined }>;
  /** Bodies of POST /v1/analyticsReportRequests. */
  created: unknown[];
}

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
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

/** A synthetic sales report (tab-separated text) from fixtures/. */
export function reportFixture(name: string): string {
  return readFileSync(
    new URL(`./fixtures/${name}.tsv`, import.meta.url),
    "utf8",
  );
}

export const SALES_REPORT_TSV = reportFixture("sales-2026-09-28");

/** Column names of the synthetic reports, in Apple's file order. */
export const REPORT_HEADER = SALES_REPORT_TSV.split("\n")[0]!.split("\t");

/**
 * A report of the given rows: each row names the columns it fills, every
 * other column stays empty.
 */
export function buildReport(rows: Array<Record<string, string>>): string {
  return [
    REPORT_HEADER.join("\t"),
    ...rows.map((row) =>
      REPORT_HEADER.map((column) => row[column] ?? "").join("\t"),
    ),
  ].join("\n");
}

function gzipResponse(
  content: string | Uint8Array,
  headers: Record<string, string>,
) {
  // Text is gzipped here; bytes are served as given (a prepared archive).
  const bytes = typeof content === "string" ? gzipSync(content) : content;
  return {
    status: 200,
    headers: { "content-type": "application/a-gzip", ...headers },
    text: () => new TextDecoder().decode(bytes),
    json: () => {
      throw new Error("not JSON");
    },
    bytes: () => new Uint8Array(bytes),
  } satisfies ConnectorResponse;
}

export function createFakeAppStoreConnect(
  options: FakeAppStoreConnectOptions,
): FakeAppStoreConnect {
  const failures = [...(options.failures ?? [])];
  const requests: FakeAppStoreConnect["requests"] = [];
  const created: unknown[] = [];
  const rate = () => ({
    "x-rate-limit": `user-hour-lim:3500;user-hour-rem:${options.remaining ?? 3000};`,
  });

  const handle = (url: URL, init?: ConnectorFetchInit): ConnectorResponse => {
    const token = /^Bearer (.+)$/.exec(init?.headers?.authorization ?? "")?.[1];
    const team = options.teams.find((candidate) =>
      candidate.tokens.includes(token ?? ""),
    );
    if (!team) {
      return jsonResponse(401, fixture("error-unauthorized"));
    }
    const failure = failures.shift();
    if (failure) {
      return jsonResponse(
        failure.status,
        failure.fixture ? fixture(failure.fixture) : {},
        { ...rate(), ...failure.headers },
      );
    }
    if (url.pathname === "/v1/apps" && init?.method === "GET") {
      const pages = team.appPages ?? [];
      const cursor = url.searchParams.get("cursor");
      // The page whose own link carries the cursor (Apple's cursors are opaque).
      const index =
        cursor === null
          ? 0
          : pages.findIndex((page) =>
              String(
                (page as { links?: { self?: string } }).links?.self ?? "",
              ).includes(`cursor=${cursor}&`),
            );
      const limit = Number(url.searchParams.get("limit") ?? 50);
      if (limit === 1) {
        // The key probe: one app is enough.
        const first = (pages[0] ?? { data: [] }) as { data: unknown[] };
        return jsonResponse(
          200,
          { data: first.data.slice(0, 1), links: {} },
          rate(),
        );
      }
      return jsonResponse(200, pages[index] ?? { data: [] }, rate());
    }
    if (url.pathname === "/v1/salesReports" && init?.method === "GET") {
      if (team.agreementsMissing) {
        return jsonResponse(403, fixture("error-forbidden-agreements"), rate());
      }
      if (team.role === "developer" || team.role === "customer-support") {
        return jsonResponse(403, fixture("error-forbidden-role"), rate());
      }
      const vendor = url.searchParams.get("filter[vendorNumber]") ?? "";
      if (!team.vendorNumbers.includes(vendor)) {
        return jsonResponse(400, fixture("error-invalid-vendor"), rate());
      }
      const date = url.searchParams.get("filter[reportDate]") ?? "";
      if ((team.pendingDays ?? []).includes(date)) {
        return jsonResponse(
          404,
          fixture("error-not-found-not-available"),
          rate(),
        );
      }
      const report = team.reports?.[date];
      if (report !== undefined) return gzipResponse(report, rate());
      if (!(team.salesDays ?? []).includes(date)) {
        return jsonResponse(404, fixture("error-not-found-no-sales"), rate());
      }
      return gzipResponse(SALES_REPORT_TSV, rate());
    }
    if (
      /^\/v1\/apps\/\d+\/customerReviews$/.test(url.pathname) &&
      init?.method === "GET"
    ) {
      if (team.role === undefined || team.role === "sales") {
        return jsonResponse(403, fixture("error-forbidden-role"), rate());
      }
      const cursor = url.searchParams.get("cursor");
      const page =
        team.reviewPages?.[
          cursor === null ? url.pathname : `${url.pathname}?cursor=${cursor}`
        ];
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const body = (page ?? { data: [], links: {} }) as { data: unknown[] };
      return jsonResponse(
        200,
        limit === 1 ? { ...body, data: body.data.slice(0, 1) } : body,
        rate(),
      );
    }
    const analytics = team.analytics;
    if (
      analytics &&
      url.pathname === "/v1/analyticsReportRequests" &&
      init?.method === "POST"
    ) {
      created.push(JSON.parse(init.body ?? "null"));
      const outcome =
        analytics.create ?? (team.role === "admin" ? "created" : "forbidden");
      if (outcome === "conflict") {
        return jsonResponse(409, fixture("error-conflict"), rate());
      }
      if (outcome === "forbidden") {
        return jsonResponse(403, fixture("error-forbidden-role"), rate());
      }
      return jsonResponse(201, fixture("analytics-request-created"), rate());
    }
    if (analytics && init?.method === "GET") {
      const cursor = url.searchParams.get("cursor");
      const page =
        analytics.pages[
          cursor === null ? url.pathname : `${url.pathname}?cursor=${cursor}`
        ];
      if (page !== undefined) return jsonResponse(200, page, rate());
    }
    return jsonResponse(
      404,
      {
        errors: [
          {
            status: "404",
            code: "NOT_FOUND",
            title: "The specified resource does not exist",
            detail: `The path provided does not match a defined resource type.`,
          },
        ],
      },
      rate(),
    );
  };

  const fetch: ConnectorRuntime["fetch"] = async (raw, init) => {
    const url = new URL(raw);
    requests.push({ url, init });
    if (url.protocol === "https:" && url.hostname === SEGMENT_HOST) {
      // S3 answers a presigned link without any Authorization header.
      const file = options.teams
        .map((team) => team.analytics?.files?.[url.pathname])
        .find((entry) => entry !== undefined);
      if (!file || init?.headers?.authorization !== undefined) {
        const text = "<Error><Code>AccessDenied</Code></Error>";
        return {
          status: 403,
          headers: { "content-type": "application/xml" },
          text: () => text,
          json: () => {
            throw new Error("not JSON");
          },
          bytes: () => new TextEncoder().encode(text),
        };
      }
      return {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        text: () => new TextDecoder().decode(file),
        json: () => {
          throw new Error("not JSON");
        },
        bytes: () => new Uint8Array(file),
      };
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.appstoreconnect.apple.com"
    ) {
      throw new Error(`fake App Store Connect refuses ${raw}`);
    }
    return handle(url, init);
  };

  return {
    requests,
    created,
    fetch,
    runtime: { signal: new AbortController().signal, fetch },
  };
}
