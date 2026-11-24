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
  /** Deployments, newest first, one every `deployEveryMs` back from `today` noon. */
  deployments?: number;
  deployEveryMs?: number;
}

/** A deployment as Vercel's list answers it. */
export interface FakeDeployment {
  uid: string;
  projectId: string;
  created: number;
  readyState: string;
  readySubstate?: string;
  target: string | null;
  buildingAt?: number;
  ready?: number;
}

/** States cycled through by the generated deployments, newest first. */
export const FAKE_STATES = [
  "BUILDING",
  "READY",
  "ERROR",
  "READY",
  "CANCELED",
  "QUEUED",
  "READY",
  "INITIALIZING",
] as const;

/** The deployments the fake answers for a project, newest first. */
export function fakeDeployments(
  project: FakeProject,
  today: string,
): FakeDeployment[] {
  const count = project.deployments ?? 8;
  const every = project.deployEveryMs ?? 6 * 60 * 60 * 1000;
  const newest = Date.parse(`${today}T12:00:00.000Z`);
  return Array.from({ length: count }, (_, index) => {
    const created = newest - index * every;
    const readyState = FAKE_STATES[index % FAKE_STATES.length]!;
    const built = readyState === "READY" || readyState === "ERROR";
    return {
      uid: `dpl_${project.id}_${index}`,
      projectId: project.id,
      created,
      readyState,
      ...(readyState === "READY" ? { readySubstate: "PROMOTED" } : {}),
      target: index % 2 === 0 ? "production" : null,
      ...(built || readyState === "BUILDING"
        ? { buildingAt: created + 1_000 }
        : {}),
      ...(readyState === "READY" ? { ready: created + 61_000 } : {}),
    };
  });
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
  /**
   * The rate-limit window every answer reports (`x-ratelimit-remaining`,
   * `x-ratelimit-reset`): `remaining` requests left, counted down per
   * request, until `resetInMs` after `now()`.
   */
  window?: { remaining: number; resetInMs: number; now: () => number };
  /** The billing export's status (403: the token's role may not read it). */
  billingStatus?: number;
  /** A later state of a deployment, by id (building → ready). */
  states?: Record<string, string>;
  /** Deployment ids the list leaves out (deleted at Vercel). */
  deleted?: string[];
  /**
   * The deployment serving production per project (`targets.production`),
   * by id; null for none. Default: the newest promoted READY one.
   */
  live?: Record<string, string | null>;
  /** Deployments of a custom environment, by id: its slug. */
  environments?: Record<string, string>;
  /** Deployment lists without their pagination object. */
  omitPagination?: boolean;
  /** A creation time per deployment id, instead of the generated one. */
  created?: Record<string, number>;
  /** Thrown by the runtime's fetch for the billing export (a size cap). */
  billingThrows?: () => Error;
  /** A later READY substate of a deployment, by id (ROLLING, STAGED). */
  substates?: Record<string, string>;
  /** Projects the billing export no longer charges (#894). */
  unbilled?: string[];
  /** The effective cost of each project's daily usage charge (default 0.25). */
  usageCost?: number;
  /** A second daily charge per project (another SKU) of this effective cost. */
  extraCost?: number;
  /** Projects listed with Web Analytics whose analytics answer 404. */
  analyticsGone?: string[];
  /** Answers per path that fail once, after `after` successful requests. */
  failAfter?: {
    after: number;
    status: number;
    path?: string;
    headers?: Record<string, string>;
  };
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
  let served = 0;
  let failedOnce = false;
  const deleted = new Set(options.deleted ?? []);

  let remaining = options.window?.remaining ?? 0;
  const windowHeaders = (): Record<string, string> => {
    const window = options.window;
    if (!window) return {};
    remaining = Math.max(0, remaining - 1);
    return {
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(
        Math.ceil((window.now() + window.resetInMs) / 1000),
      ),
    };
  };

  const answer = (url: URL, init?: ConnectorFetchInit): ConnectorResponse => {
    const result = handle(url, init);
    const extra = windowHeaders();
    return { ...result, headers: { ...extra, ...result.headers } };
  };

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
    const failAfter = options.failAfter;
    if (
      failAfter &&
      (!failAfter.path || url.pathname === failAfter.path) &&
      (served += 1) > failAfter.after &&
      !failedOnce
    ) {
      failedOnce = true;
      return response(
        failAfter.status,
        { error: { code: "internal", message: "secret provider detail" } },
        failAfter.headers,
      );
    }
    const query = url.searchParams;
    const deploymentsOf = (project: FakeProject) =>
      fakeDeployments(project, today)
        .map((deployment) => {
          const state = options.states?.[deployment.uid];
          const slug = options.environments?.[deployment.uid];
          const created = options.created?.[deployment.uid];
          const substate = options.substates?.[deployment.uid];
          return {
            ...deployment,
            ...(state ? { readyState: state } : {}),
            ...(substate ? { readySubstate: substate } : {}),
            ...(created !== undefined ? { created } : {}),
            ...(slug
              ? { target: null, customEnvironment: { id: `env_${slug}`, slug } }
              : {}),
          };
        })
        .filter((deployment) => !deleted.has(deployment.uid));
    const projectPath = /^\/v9\/projects\/([^/]+)$/.exec(url.pathname);
    if (projectPath) {
      const found = projects.find(
        (candidate) => candidate.id === projectPath[1],
      );
      if (!found || query.get("teamId") !== found.accountId) {
        return response(404, {
          error: { code: "not_found", message: "Project not found." },
        });
      }
      const all = deploymentsOf(found);
      const chosen = options.live?.[found.id];
      const live =
        chosen === null
          ? undefined
          : chosen !== undefined
            ? all.find((deployment) => deployment.uid === chosen)
            : all.find(
                (deployment) =>
                  deployment.target === "production" &&
                  deployment.readyState === "READY" &&
                  deployment.readySubstate !== "STAGED",
              );
      return response(200, {
        id: found.id,
        name: found.name,
        accountId: found.accountId,
        targets: live
          ? {
              production: {
                id: live.uid,
                createdAt: live.created,
                readyAt: live.ready,
                readyState: "READY",
                readySubstate: "PROMOTED",
                target: "production",
                url: `${live.uid}.vercel.app`,
              },
            }
          : {},
      });
    }
    if (url.pathname === "/v7/deployments") {
      const project = projects.find(
        (candidate) => candidate.id === query.get("projectId"),
      );
      if (!project || query.get("teamId") !== project.accountId) {
        return response(404, {
          error: { code: "not_found", message: "Project not found." },
        });
      }
      const limit = Number(query.get("limit") ?? "20");
      const since = query.has("since") ? Number(query.get("since")) : -1;
      const until = query.has("until")
        ? Number(query.get("until"))
        : Number.POSITIVE_INFINITY;
      const target = query.get("target");
      const state = query.get("state");
      const matching = deploymentsOf(project).filter(
        (deployment) =>
          deployment.created > since &&
          deployment.created < until &&
          (target === null || deployment.target === target) &&
          (state === null || deployment.readyState === state),
      );
      const page = matching.slice(0, limit);
      const next =
        matching.length > limit ? page[page.length - 1]!.created : null;
      return response(200, {
        deployments: page.map((deployment) => ({
          ...deployment,
          state: deployment.readyState,
          name: project.name,
          url: `${deployment.uid}.vercel.app`,
          createdAt: deployment.created,
          type: "LAMBDAS",
          creator: { uid: "user_fake" },
          inspectorUrl: null,
          meta: { githubCommitRef: "main" },
        })),
        ...(options.omitPagination
          ? {}
          : { pagination: { count: page.length, next, prev: null } }),
      });
    }
    if (url.pathname === "/v1/billing/charges") {
      const team = query.get("teamId");
      if (options.billingStatus && options.billingStatus !== 200) {
        return response(options.billingStatus, {
          error: { code: "forbidden", message: "You don't have permission" },
        });
      }
      // One charge per project and day of [from, to), the seat on the 1st.
      const lines: Array<Record<string, unknown>> = [];
      const from = Date.parse(query.get("from") ?? "");
      const to = Date.parse(query.get("to") ?? "");
      for (let day = from; day < to; day += DAY_MS) {
        const start = new Date(day).toISOString();
        const end = new Date(day + DAY_MS).toISOString();
        for (const project of projects.filter(
          (candidate) =>
            candidate.accountId === team &&
            !options.unbilled?.includes(candidate.id),
        )) {
          lines.push({
            BilledCost: 0.5,
            EffectiveCost: options.usageCost ?? 0.25,
            BillingCurrency: "USD",
            ChargeCategory: "Usage",
            ChargePeriodStart: start,
            ChargePeriodEnd: end,
            ConsumedQuantity: 100,
            ConsumedUnit: "invocations",
            ServiceName: "Function Invocations",
            ServiceCategory: "Compute",
            SkuId: "function-invocations",
            SubAccountId: team,
            SubAccountName: "Fake Team",
            Tags: { ProjectId: project.id, ProjectName: project.name },
          });
          if (options.extraCost !== undefined) {
            lines.push({
              ...lines.at(-1)!,
              BilledCost: options.extraCost,
              EffectiveCost: options.extraCost,
              ServiceName: "Bandwidth",
              SkuId: "bandwidth",
            });
          }
        }
        if (new Date(day).getUTCDate() === 1) {
          lines.push({
            BilledCost: 20,
            EffectiveCost: 20,
            BillingCurrency: "USD",
            ChargeCategory: "Purchase",
            ChargePeriodStart: start,
            ChargePeriodEnd: end,
            ConsumedQuantity: null,
            ConsumedUnit: null,
            ServiceName: "Pro Seat",
            ServiceCategory: "Developer Tools",
            SkuId: "pro-seat",
            SubAccountId: team,
            SubAccountName: "Fake Team",
            Tags: {},
          });
        }
      }
      const text = lines.map((line) => JSON.stringify(line)).join("\n");
      return {
        status: 200,
        headers: { "content-type": "application/jsonl" },
        text: () => text,
        json: () => {
          throw new Error("not JSON");
        },
        bytes: () => new TextEncoder().encode(text),
      };
    }
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
    if (!project.analytics || options.analyticsGone?.includes(project.id)) {
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
        if (options.billingThrows && url.pathname === "/v1/billing/charges") {
          throw options.billingThrows();
        }
        return answer(url, init);
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
