// An offline stand-in for PostHog's private API, for the contract tests.
// It answers the requests the connector sends with the shapes PostHog
// documents (see fixtures/), checks the key and the host, and records
// every request.

import { readFileSync } from "node:fs";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

export const FAKE_KEY = "phx_fake_personal_api_key_for_tests_0001";

const DAY_MS = 24 * 60 * 60 * 1000;

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

export function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ConnectorResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

export const unauthorized = () => answer(401, fixture("error-401.json"));
export const scopeMissing = () => answer(403, fixture("error-403-scope.json"));
export const rateLimited = (retryAfter: string) =>
  answer(429, fixture("error-429-budget.json"), { "retry-after": retryAfter });

export interface FakeProject {
  id: number;
  name?: string;
  org?: string;
  /** Events on a day (UTC, YYYY-MM-DD); default 100 + day of month. */
  events?: (day: string) => number;
  /** Distinct event names per day; default 12. */
  eventNames?: number;
  /** The key may not read this project's data. */
  refused?: 403 | 404;
}

export interface FakeInsight {
  project: number;
  shortId: string;
  name?: string;
  /** Default an InsightVizNode with a daily TrendsQuery. */
  query?: unknown;
  /** Default: one series per day of the last 7 days up to "today". */
  result?: unknown;
  deleted?: boolean;
  queryStatus?: unknown;
  refused?: 403 | 404;
}

export interface FakePostHogOptions {
  host?: string;
  key?: string;
  orgs?: Array<{ id: string; name: string }>;
  projects?: FakeProject[];
  insights?: FakeInsight[];
  /** Largest listing page the fake hands out (PostHog's is 100). */
  maxPage?: number;
  /** The scheme of `next` URLs (a self-hosted proxy may say http). */
  nextScheme?: "https" | "http";
  /** Answers a request before the fake does; undefined lets it through. */
  intercept?: (request: FakeRequest) => ConnectorResponse | undefined;
}

export interface FakeRequest {
  method: string;
  host: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | null;
}

export const ORG = { id: "0190b4c2-7d1e-7000-8000-000000000001", name: "Acme" };

export function fakeProjects(count: number, extra: Partial<FakeProject> = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: 1000 + index,
    name: `Project ${index}`,
    ...extra,
  }));
}

function defaultEvents(day: string): number {
  return 100 + Number(day.slice(8, 10));
}

function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (
    let ms = Date.parse(`${from}T00:00:00Z`);
    ms <= Date.parse(`${to}T00:00:00Z`);
    ms += DAY_MS
  ) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

export function trendsInsightQuery(interval = "day") {
  return {
    kind: "InsightVizNode",
    source: {
      kind: "TrendsQuery",
      interval,
      series: [{ kind: "EventsNode", event: "$pageview", math: "total" }],
    },
  };
}

export function createFakePostHog(options: FakePostHogOptions = {}) {
  const host = options.host ?? "us.posthog.com";
  const key = options.key ?? FAKE_KEY;
  const orgs = options.orgs ?? [ORG];
  const projects = options.projects ?? fakeProjects(1);
  const insights = options.insights ?? [];
  const maxPage = options.maxPage ?? 100;
  const requests: FakeRequest[] = [];

  function page<T>(items: T[], path: string, params: URLSearchParams) {
    const limit = Math.min(Number(params.get("limit") ?? 100), maxPage);
    const offset = Number(params.get("offset") ?? 0);
    const results = items.slice(offset, offset + limit);
    const end = offset + results.length;
    return {
      count: items.length,
      next:
        end < items.length
          ? `${options.nextScheme ?? "https"}://${host}${path}?limit=${limit}&offset=${end}`
          : null,
      previous: null,
      results,
    };
  }

  function trends(project: FakeProject, body: Record<string, unknown>) {
    const query = body.query as {
      series: Array<{ event: string | null; math: string }>;
      dateRange: { date_from: string; date_to: string };
    };
    const days = daysBetween(
      query.dateRange.date_from,
      query.dateRange.date_to,
    );
    const events = project.events ?? defaultEvents;
    const value = (math: string, event: string | null, day: string) => {
      const total = events(day);
      if (math === "dau") return total > 0 ? 10 : 0;
      if (math === "weekly_active") return total > 0 ? 50 : 0;
      if (math === "monthly_active") return total > 0 ? 100 : 0;
      return event === "$pageview" ? Math.floor(total / 2) : total;
    };
    return {
      results: query.series.map((series, order) => {
        const data = days.map((day) => value(series.math, series.event, day));
        return {
          action: {
            id: series.event,
            type: "events",
            order,
            name: series.event ?? "All events",
            math: series.math,
          },
          label: series.event ?? "All events",
          count: data.reduce((sum, entry) => sum + entry, 0),
          data,
          labels: days.map((day) => day),
          days,
        };
      }),
      is_cached: false,
      timezone: "UTC",
    };
  }

  function topEvents(project: FakeProject, text: string) {
    const [from, to] = [
      ...text.matchAll(/toDateTime\('(\d{4}-\d{2}-\d{2})/g),
    ].map((match) => match[1]!);
    const names = project.eventNames ?? 12;
    const events = project.events ?? defaultEvents;
    const rows: Array<[string, string, number]> = [];
    for (const day of daysBetween(from!, to!)) {
      if (events(day) === 0) continue;
      for (let index = 0; index < Math.min(names, 10); index += 1) {
        rows.push([
          day,
          index === 0 ? "$pageview" : `event_${index}`,
          100 - index,
        ]);
      }
    }
    return {
      columns: ["day", "event", "events"],
      types: [
        ["day", "Date"],
        ["event", "String"],
        ["events", "UInt64"],
      ],
      results: rows,
      hasMore: false,
      is_cached: false,
    };
  }

  function insightOf(entry: FakeInsight) {
    return {
      id: Number(entry.shortId.length) * 1000 + entry.project,
      short_id: entry.shortId,
      name: entry.name ?? `Insight ${entry.shortId}`,
      derived_name: null,
      deleted: entry.deleted ?? false,
      last_refresh: "2024-01-10T11:00:00Z",
      query: entry.query ?? trendsInsightQuery(),
      result:
        entry.result !== undefined
          ? entry.result
          : [
              {
                action: { order: 0, math: "total" },
                label: "$pageview",
                count: 70,
                data: [10, 10, 10, 10, 10, 10, 10],
                labels: [],
                days: daysBetween("2024-01-04", "2024-01-10"),
              },
            ],
      ...(entry.queryStatus !== undefined
        ? { query_status: entry.queryStatus }
        : {}),
    };
  }

  function route(request: FakeRequest): ConnectorResponse {
    const { method, path, params, body } = request;
    if (method === "GET" && path === "/api/organizations/") {
      return answer(200, page(orgs, path, params));
    }
    const orgProjects = /^\/api\/organizations\/([^/]+)\/projects\/$/.exec(
      path,
    );
    if (method === "GET" && orgProjects) {
      const org = decodeURIComponent(orgProjects[1]!);
      const own = projects
        .filter((project) => (project.org ?? ORG.id) === org)
        .map((project) => ({
          id: project.id,
          uuid: `0190b4c2-0000-7000-8000-${String(project.id).padStart(12, "0")}`,
          organization: org,
          api_token: `phc_${project.id}`,
          name: project.name ?? `Project ${project.id}`,
          timezone: "UTC",
        }));
      return answer(200, page(own, path, params));
    }
    const query = /^\/api\/projects\/(\d+)\/query\/$/.exec(path);
    if (method === "POST" && query) {
      const project = projects.find((entry) => String(entry.id) === query[1]);
      if (!project) return answer(404, { detail: "Not found." });
      if (project.refused) {
        return answer(project.refused, {
          type: "authentication_error",
          code: "permission_denied",
          detail: "You don't have access to the project.",
        });
      }
      const node = (body?.query ?? {}) as { kind?: string; query?: string };
      if (node.kind === "TrendsQuery")
        return answer(200, trends(project, body!));
      if (node.kind === "HogQLQuery" && node.query === "SELECT 1") {
        return answer(200, { results: [[1]], columns: ["1"] });
      }
      if (node.kind === "HogQLQuery") {
        return answer(200, topEvents(project, node.query ?? ""));
      }
      return answer(400, { type: "validation_error", detail: "bad query" });
    }
    const list = /^\/api\/projects\/(\d+)\/insights\/$/.exec(path);
    if (method === "GET" && list) {
      const project = projects.find((entry) => String(entry.id) === list[1]);
      if (!project) return answer(404, { detail: "Not found." });
      const shortId = params.get("short_id");
      const matching = insights.filter(
        (entry) =>
          String(entry.project) === list[1] &&
          (shortId === null || entry.shortId === shortId),
      );
      const refused = matching.find((entry) => entry.refused);
      if (refused) {
        return answer(refused.refused!, {
          type: "authentication_error",
          code: "permission_denied",
          detail: "You do not have access to this resource.",
        });
      }
      return answer(200, page(matching.map(insightOf), path, params));
    }
    return answer(404, { detail: "Not found." });
  }

  const runtime: ConnectorRuntime = {
    signal: new AbortController().signal,
    fetch: async (url: string, init?: ConnectorFetchInit) => {
      const parsed = new URL(url);
      const request: FakeRequest = {
        method: init?.method ?? "GET",
        host: parsed.host,
        path: parsed.pathname,
        params: parsed.searchParams,
        body: init?.body
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
      };
      requests.push(request);
      if (parsed.protocol !== "https:") {
        throw new Error(`egress denied: ${parsed.protocol} is not https`);
      }
      if (parsed.host !== host) {
        throw new Error(`egress denied: ${parsed.host} is not ${host}`);
      }
      const intercepted = options.intercept?.(request);
      if (intercepted) return intercepted;
      if (init?.headers?.authorization !== `Bearer ${key}`) {
        return unauthorized();
      }
      return route(request);
    },
  };
  return { runtime, requests };
}
