import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
} from "@netrics/connector-sdk";

import { decodeJwt, type TestKeyPair } from "./test-keys.js";

// Tests only: an in-memory App Store Connect that verifies the host's
// signed tokens. A team is known by its issuer ID and key; a token signed by
// another key, for another audience or expired answers Apple's 401. Error
// bodies follow Apple's ErrorResponse (see the connector's fixtures).

export interface FakeAscTeam {
  issuerId: string;
  keyId: string;
  key: TestKeyPair;
  apps: Array<{ id: string; name: string; bundleId: string }>;
  vendorNumbers: string[];
  /**
   * "developer" and "customer-support" keys cannot read sales reports
   * (403); only "admin" keys may request analytics reports. Customer
   * reviews are read by "customer-support", "developer" and "admin" keys,
   * not by "sales" ones (the default).
   */
  role?: "sales" | "admin" | "developer" | "customer-support";
  /** A revoked key answers 401 everywhere. */
  revoked?: boolean;
  /**
   * Daily sales reports (YYYY-MM-DD → tab-separated text, served gzipped);
   * other days answer 404 "no sales".
   */
  reports?: Record<string, string>;
  /**
   * The team's Analytics Reports API (#174). Keys of one team share it:
   * give every key entry of a team the same object.
   */
  analytics?: FakeAscAnalytics;
  /**
   * Customer reviews per app ID (#190). Keys of one team share them: give
   * every key entry of a team the same object.
   */
  reviews?: Record<string, FakeAscReview[]>;
}

export interface FakeAscReview {
  rating: number;
  /** ISO date-time with offset, as Apple returns it. */
  createdDate: string;
  /** Alpha-3 territory code. */
  territory: string;
  title?: string;
  body?: string;
  reviewerNickname?: string;
}

/** The pinned production bucket host of analytics segment links. */
export const FAKE_SEGMENT_HOST = "asp-us-west-2.s3.us-west-2.amazonaws.com";

export interface FakeAscInstance {
  /** YYYY-MM-DD */
  processingDate: string;
  /** The segment's tab-separated text, served gzipped. */
  content: string;
}

export interface FakeAscAnalytics {
  /** ONGOING report requests per app ID. */
  requests: Record<string, Array<{ id: string; stopped?: boolean }>>;
  /** DAILY instances per app ID and report. */
  instances?: Record<
    string,
    { discovery?: FakeAscInstance[]; downloads?: FakeAscInstance[] }
  >;
}

const REPORT_NAMES = {
  discovery: "App Store Discovery and Engagement Standard",
  downloads: "App Downloads Standard",
} as const;
type ReportKind = keyof typeof REPORT_NAMES;

function gzipReply(bytes: Uint8Array, contentType: string): ConnectorResponse {
  return {
    status: 200,
    headers: {
      "content-type": contentType,
      "x-rate-limit": "user-hour-lim:3500;user-hour-rem:3400;",
    },
    text: () => new TextDecoder().decode(bytes),
    json: () => {
      throw new Error("not JSON");
    },
    bytes: () => new Uint8Array(bytes),
  };
}

/** The gzip file of one segment, and its MD5 (as Apple lists it). */
function segmentFile(content: string): { bytes: Uint8Array; md5: string } {
  const bytes = new Uint8Array(gzipSync(content));
  return { bytes, md5: createHash("md5").update(bytes).digest("hex") };
}

export interface FakeAsc {
  fetch(url: string, init?: ConnectorFetchInit): Promise<ConnectorResponse>;
  requests: Array<{
    url: URL;
    issuerId: string | undefined;
    /** The key ID of the key that signed the request's token. */
    keyId?: string | undefined;
    method?: string;
    authorization?: string | undefined;
  }>;
  /** The next answers, ahead of the normal ones. */
  failures: number[];
}

function reply(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      "content-type": "application/json",
      "x-rate-limit": "user-hour-lim:3500;user-hour-rem:3400;",
    },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

function error(status: number, code: string, title: string, detail: string) {
  return reply(status, {
    errors: [{ status: String(status), code, title, detail }],
  });
}

export function createFakeAsc(teams: FakeAscTeam[]): FakeAsc {
  const requests: FakeAsc["requests"] = [];
  const failures: number[] = [];

  function teamOf(authorization: string | undefined): FakeAscTeam | undefined {
    const token = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
    if (!token) return undefined;
    for (const team of teams) {
      const decoded = decodeJwt(token, team.key.publicKey);
      const exp = Number(decoded.claims.exp);
      if (
        decoded.verifies &&
        !team.revoked &&
        decoded.header.kid === team.keyId &&
        decoded.claims.iss === team.issuerId &&
        decoded.claims.aud === "appstoreconnect-v1" &&
        exp * 1000 > Date.now() - 60_000
      ) {
        return team;
      }
    }
    return undefined;
  }

  return {
    requests,
    failures,
    async fetch(raw, init) {
      const url = new URL(raw);
      if (url.hostname === FAKE_SEGMENT_HOST) {
        requests.push({
          url,
          issuerId: undefined,
          method: init?.method ?? "GET",
          authorization: init?.headers?.authorization,
        });
        // /reports/<app>/<kind>/<index>.csv.gz
        const [, , appId, kind, file] = url.pathname.split("/");
        const instance = teams
          .map(
            (candidate) =>
              candidate.analytics?.instances?.[appId ?? ""]?.[
                kind as ReportKind
              ]?.[Number.parseInt(file ?? "", 10)],
          )
          .find((entry) => entry !== undefined);
        if (!instance || init?.headers?.authorization !== undefined) {
          return reply(403, { error: "AccessDenied" });
        }
        return gzipReply(
          segmentFile(instance.content).bytes,
          "application/octet-stream",
        );
      }
      if (url.hostname !== "api.appstoreconnect.apple.com") {
        throw new Error(`fake App Store Connect refuses ${raw}`);
      }
      const team = teamOf(init?.headers?.authorization);
      requests.push({
        url,
        issuerId: team?.issuerId,
        keyId: team?.keyId,
        method: init?.method ?? "GET",
      });
      if (!team) {
        return error(
          401,
          "NOT_AUTHORIZED",
          "Authentication credentials are missing or invalid.",
          "Provide a properly configured and signed bearer token, and make sure that it has not expired.",
        );
      }
      const failure = failures.shift();
      if (failure !== undefined) {
        return failure === 429
          ? error(
              429,
              "RATE_LIMIT_EXCEEDED",
              "The request rate limit has been reached.",
              "We've received too many requests for this API.",
            )
          : error(
              failure,
              "UNEXPECTED_ERROR",
              "An unexpected error occurred.",
              "An unexpected error occurred on the server side.",
            );
      }
      const analytics = analyticsReply(team, url, init);
      if (analytics) return analytics;
      if (url.pathname === "/v1/apps") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        return reply(200, {
          data: team.apps.slice(0, limit).map((app) => ({
            type: "apps",
            id: app.id,
            attributes: { name: app.name, bundleId: app.bundleId },
          })),
          links: {},
        });
      }
      const reviews = /^\/v1\/apps\/(\d+)\/customerReviews$/.exec(url.pathname);
      if (reviews) {
        if (
          team.role !== "customer-support" &&
          team.role !== "developer" &&
          team.role !== "admin"
        ) {
          return error(
            403,
            "FORBIDDEN_ERROR",
            "This request is forbidden for security reasons",
            "The API key in use does not allow this request",
          );
        }
        const list = [...(team.reviews?.[reviews[1]!] ?? [])].sort(
          (a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate),
        );
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const offset = Number(url.searchParams.get("cursor") ?? 0);
        const fields = (
          url.searchParams.get("fields[customerReviews]") ??
          "rating,title,body,reviewerNickname,createdDate,territory"
        ).split(",");
        const page = list.slice(offset, offset + limit);
        const next = offset + limit < list.length;
        const query = new URLSearchParams(url.searchParams);
        query.set("cursor", String(offset + limit));
        return reply(200, {
          data: page.map((review, index) => ({
            type: "customerReviews",
            id: `review-${reviews[1]}-${offset + index}`,
            attributes: Object.fromEntries(
              Object.entries(review).filter(([field]) =>
                fields.includes(field),
              ),
            ),
          })),
          links: next
            ? { next: `https://${url.hostname}${url.pathname}?${query}` }
            : {},
        });
      }
      if (url.pathname === "/v1/salesReports") {
        if (team.role === "developer" || team.role === "customer-support") {
          return error(
            403,
            "FORBIDDEN_ERROR",
            "This request is forbidden for security reasons",
            "The API key in use does not allow this request",
          );
        }
        if (
          !team.vendorNumbers.includes(
            url.searchParams.get("filter[vendorNumber]") ?? "",
          )
        ) {
          return reply(400, {
            errors: [
              {
                status: "400",
                code: "PARAMETER_ERROR.INVALID",
                title: "A parameter has an invalid value",
                detail: "Invalid vendor number specified. Try again.",
                source: { parameter: "filter[vendorNumber]" },
              },
            ],
          });
        }
        const report =
          team.reports?.[url.searchParams.get("filter[reportDate]") ?? ""];
        if (report !== undefined) {
          const bytes = new Uint8Array(gzipSync(report));
          return {
            status: 200,
            headers: {
              "content-type": "application/a-gzip",
              "x-rate-limit": "user-hour-lim:3500;user-hour-rem:3400;",
            },
            text: () => new TextDecoder().decode(bytes),
            json: () => {
              throw new Error("not JSON");
            },
            bytes: () => new Uint8Array(bytes),
          };
        }
        // No sales that day: a 404 that counts as success.
        return error(
          404,
          "NOT_FOUND",
          "The request expected results but none were found",
          "There were no sales for the date specified.",
        );
      }
      return error(
        404,
        "NOT_FOUND",
        "The specified resource does not exist",
        "The path provided does not match a defined resource type.",
      );
    },
  };
}

/** The Analytics Reports endpoints, or undefined for other paths. */
function analyticsReply(
  team: FakeAscTeam,
  url: URL,
  init: ConnectorFetchInit | undefined,
): ConnectorResponse | undefined {
  const state = team.analytics;
  if (!state) return undefined;
  const path = url.pathname;
  const forbidden = () =>
    error(
      403,
      "FORBIDDEN_ERROR",
      "This request is forbidden for security reasons",
      "The API key in use does not allow this request",
    );
  if (path === "/v1/analyticsReportRequests" && init?.method === "POST") {
    if (team.role !== "admin") return forbidden();
    const body = JSON.parse(init.body ?? "{}") as {
      data?: { relationships?: { app?: { data?: { id?: string } } } };
    };
    const appId = body.data?.relationships?.app?.data?.id ?? "";
    if (!team.apps.some((app) => app.id === appId)) {
      return error(
        404,
        "NOT_FOUND",
        "The specified resource does not exist",
        "There is no resource of type 'apps' with id",
      );
    }
    const list = (state.requests[appId] ??= []);
    if (list.some((entry) => !entry.stopped)) {
      return error(
        409,
        "ENTITY_ERROR",
        "The request entity is not valid.",
        "You already have such an entity",
      );
    }
    const id = randomUUID();
    list.push({ id });
    return reply(201, {
      data: {
        type: "analyticsReportRequests",
        id,
        attributes: { accessType: "ONGOING", stoppedDueToInactivity: false },
      },
    });
  }
  if (init?.method === "POST") return undefined;
  if (path === "/v1/builds") {
    // Builds (app icons, #226): Sales and Customer Support keys may not.
    if (
      (team.role ?? "sales") === "sales" ||
      team.role === "customer-support"
    ) {
      return forbidden();
    }
    return reply(200, { data: [], links: {} });
  }
  const apps = /^\/v1\/apps\/(\d+)\/analyticsReportRequests$/.exec(path);
  if (apps) {
    if (team.role === "developer") return forbidden();
    return reply(200, {
      data: (state.requests[apps[1]!] ?? []).map((entry) => ({
        type: "analyticsReportRequests",
        id: entry.id,
        attributes: {
          accessType: "ONGOING",
          stoppedDueToInactivity: entry.stopped === true,
        },
      })),
      links: {},
    });
  }
  const reports = /^\/v1\/analyticsReportRequests\/([^/]+)\/reports$/.exec(
    path,
  );
  if (reports) {
    const appId = Object.entries(state.requests).find(([, list]) =>
      list.some((entry) => entry.id === reports[1]),
    )?.[0];
    if (!appId) return undefined;
    return reply(200, {
      data: (Object.keys(REPORT_NAMES) as ReportKind[]).map((kind) => ({
        type: "analyticsReports",
        id: `rpt-${appId}-${kind}`,
        attributes: { name: REPORT_NAMES[kind], category: "X" },
      })),
      links: {},
    });
  }
  const instances = /^\/v1\/analyticsReports\/rpt-(\d+)-(\w+)\/instances$/.exec(
    path,
  );
  if (instances) {
    const list =
      state.instances?.[instances[1]!]?.[instances[2] as ReportKind] ?? [];
    return reply(200, {
      data: list.map((entry, index) => ({
        type: "analyticsReportInstances",
        id: `inst-${instances[1]}-${instances[2]}-${index}`,
        attributes: {
          granularity: "DAILY",
          processingDate: entry.processingDate,
        },
      })),
      links: {},
    });
  }
  const segments =
    /^\/v1\/analyticsReportInstances\/inst-(\d+)-(\w+)-(\d+)\/segments$/.exec(
      path,
    );
  if (segments) {
    const [, appId, kind, index] = segments;
    const instance =
      state.instances?.[appId!]?.[kind as ReportKind]?.[Number(index)];
    if (!instance) return undefined;
    const file = segmentFile(instance.content);
    return reply(200, {
      data: [
        {
          type: "analyticsReportSegments",
          id: `seg-${appId}-${kind}-${index}`,
          attributes: {
            checksum: file.md5,
            sizeInBytes: file.bytes.length,
            url: `https://${FAKE_SEGMENT_HOST}/reports/${appId}/${kind}/${index}.csv.gz?X-Amz-Expires=300&X-Amz-Signature=fake-presigned-signature`,
          },
        },
      ],
      links: {},
    });
  }
  return undefined;
}
