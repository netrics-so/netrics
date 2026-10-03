import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

/**
 * An offline stand-in for the parts of the Vercel API the connector uses,
 * shaped like the recorded fixtures. Values derive only from (project, day,
 * dimension value), so any window asking for a day gets the same numbers.
 */
export interface FakeProject {
  id: string;
  name: string;
  accountId: string;
  analytics: boolean;
}

export interface FakeVercelOptions {
  token?: string;
  projects?: FakeProject[];
  /** Days of data the plan keeps, counted back from `today`. */
  planDays?: number;
  today?: string;
  /** Answers queued ahead of the normal ones (429s, 5xx, …). */
  failures?: Array<{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }>;
  projectsPageSize?: number;
}

export const FAKE_TOKEN = "vercel-fake-token-0123456789";

export const FAKE_PROJECTS: FakeProject[] = [
  {
    id: "prj_alpha",
    name: "alpha-site",
    accountId: "team_fixture",
    analytics: true,
  },
  {
    id: "prj_beta",
    name: "beta-site",
    accountId: "team_fixture",
    analytics: true,
  },
  {
    id: "prj_gamma",
    name: "gamma-docs",
    accountId: "team_fixture",
    analytics: false,
  },
];

const ROUTES = [
  "/",
  "/blog/[slug]",
  "/pricing",
  "/docs/[...slug]",
  "/about",
  "/careers",
];
const COUNTRIES = ["US", "DE", "FR", "GB", "SG", "BR"];
const EVENTS = ["Signup", "Checkout", "Newsletter"];
const DAY_MS = 24 * 60 * 60 * 1000;

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

function days(since: string, until: string): string[] {
  const result: string[] = [];
  for (let ms = Date.parse(since); ms <= Date.parse(until); ms += DAY_MS) {
    result.push(new Date(ms).toISOString());
  }
  return result;
}

export interface FakeVercel {
  runtime: ConnectorRuntime;
  requests: Array<{ url: URL; init: ConnectorFetchInit | undefined }>;
}

export function createFakeVercel(options: FakeVercelOptions = {}): FakeVercel {
  const token = options.token ?? FAKE_TOKEN;
  const projects = options.projects ?? FAKE_PROJECTS;
  const today = options.today ?? "2024-12-31";
  const failures = [...(options.failures ?? [])];
  const pageSize = options.projectsPageSize ?? 100;
  const requests: FakeVercel["requests"] = [];

  const handle = (url: URL, init?: ConnectorFetchInit): ConnectorResponse => {
    if (init?.headers?.authorization !== `Bearer ${token}`) {
      return response(403, {
        error: {
          code: "forbidden",
          message: "Not authorized",
          invalidToken: true,
        },
      });
    }
    const failure = failures.shift();
    if (failure) {
      return response(failure.status, failure.body ?? {}, failure.headers);
    }
    const query = url.searchParams;
    if (url.pathname === "/v10/projects") {
      const start = Number(query.get("from") ?? "0");
      const page = projects.slice(start, start + pageSize);
      const next = start + pageSize < projects.length ? start + pageSize : null;
      return response(200, {
        projects: page.map((project) => ({
          id: project.id,
          name: project.name,
          accountId: project.accountId,
          webAnalytics: project.analytics
            ? {
                id: `wa_${project.id}`,
                enabledAt: 1_700_000_000_000,
                hasData: true,
              }
            : undefined,
        })),
        pagination: { count: page.length, next, prev: null },
      });
    }
    const match =
      /^\/v1\/query\/web-analytics\/(visits|events)\/aggregate$/.exec(
        url.pathname,
      );
    if (!match) {
      return response(404, {
        error: { code: "not_found", message: "Not found" },
      });
    }
    const project = projects.find(
      (candidate) => candidate.id === query.get("projectId"),
    );
    if (!project || query.get("teamId") !== project.accountId) {
      return response(404, {
        error: { code: "not_found", message: "Project not found." },
      });
    }
    if (!project.analytics) {
      return response(404, {
        error: { code: "not_found", message: "Web Analytics not found." },
      });
    }
    const since = `${query.get("since")}T00:00:00.000Z`;
    const until = `${query.get("until")}T00:00:00.000Z`;
    if (until > `${today}T00:00:00.000Z`) {
      return response(400, {
        error: {
          code: "bad_request",
          message: "Invalid request: until is in the future",
        },
      });
    }
    if (options.planDays !== undefined) {
      const oldest =
        Date.parse(`${today}T00:00:00.000Z`) - (options.planDays - 1) * DAY_MS;
      if (Date.parse(since) < oldest) {
        return response(400, {
          error: {
            code: "bad_request",
            message: `Invalid request: the pro plan only grants access to the latest ${options.planDays} days of data.`,
          },
        });
      }
    }
    const by = query.getAll("by");
    const limit = Number(query.get("limit") ?? "10");
    const dimension = by.find((entry) => entry !== "day");
    const values =
      dimension === "route"
        ? ROUTES
        : dimension === "country"
          ? COUNTRIES
          : dimension === "eventName"
            ? EVENTS
            : [undefined];
    // Top `limit` values over the whole range (stable ranking), the rest "Others".
    const top = values.slice(0, limit);
    const rest = values.slice(limit);
    const data = days(since, until).flatMap((timestamp) => {
      const rows = top.map((value) =>
        row(match[1]!, project.id, timestamp, dimension, value),
      );
      if (rest.length > 0 && dimension) {
        const others: Record<string, unknown> = {
          timestamp,
          [dimension]: "Others",
        };
        for (const item of rest.map((value) =>
          row(match[1]!, project.id, timestamp, dimension, value),
        )) {
          for (const field of ["visitors", "pageviews", "count"]) {
            if (typeof item[field] === "number") {
              others[field] =
                ((others[field] as number | undefined) ?? 0) +
                (item[field] as number);
            }
          }
        }
        rows.push(others);
      }
      return rows;
    });
    return response(200, { version: 1, query: { since, until, limit }, data });
  };

  return {
    requests,
    runtime: {
      signal: new AbortController().signal,
      fetch: async (raw, init) => {
        const url = new URL(raw);
        requests.push({ url, init });
        if (url.protocol !== "https:" || url.hostname !== "api.vercel.com") {
          throw new Error(`fake Vercel refuses ${raw}`);
        }
        return handle(url, init);
      },
    },
  };
}

function row(
  kind: string,
  projectId: string,
  timestamp: string,
  dimension: string | undefined,
  value: string | undefined,
): Record<string, unknown> {
  const seed = hash(
    `${projectId}:${timestamp}:${dimension ?? ""}:${value ?? ""}`,
  );
  const visitors = 10 + (seed % 200);
  const base = { timestamp, ...(dimension ? { [dimension]: value } : {}) };
  return kind === "events"
    ? { ...base, count: 1 + (seed % 40), visitors: 1 + (seed % 30) }
    : { ...base, visitors, pageviews: visitors + ((seed >>> 8) % 150) };
}
