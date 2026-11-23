import { readFileSync } from "node:fs";

import type {
  ConnectorFetchInit,
  ConnectorResponse,
  ConnectorRuntime,
} from "@netrics/connector-sdk";

import { HETZNER_API } from "./api.js";

/**
 * An offline stand-in for the parts of the Hetzner Cloud API the connector
 * reads, answering in the shapes of the fixtures (`fixtures/`, written
 * after the documented schemas and examples). Listings page by `page` and
 * `per_page` with `meta.pagination`; metrics are a function of the server
 * and the hour, so any window asking for an hour gets the same numbers.
 */
export const FAKE_TOKEN = "hetzner-fake-token-0123456789";

export function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

type Item = { id: number } & Record<string, unknown>;

export interface FakeData {
  servers: Item[];
  volumes: Item[];
  primary_ips: Item[];
  floating_ips: Item[];
  load_balancers: Item[];
}

export function fixtureData(): FakeData {
  const list = (name: string, key: string) =>
    (fixture(name) as Record<string, Item[]>)[key]!;
  return {
    servers: list("servers-all-statuses.json", "servers"),
    volumes: list("volumes.json", "volumes"),
    primary_ips: list("primary-ips.json", "primary_ips"),
    floating_ips: list("floating-ips.json", "floating_ips"),
    load_balancers: list("load-balancers.json", "load_balancers"),
  };
}

/** `count` servers like the first fixture server, IDs from 1,000. */
export function manyServers(
  count: number,
  extra: (index: number) => Record<string, unknown> = () => ({}),
): Item[] {
  const template = fixtureData().servers[0]!;
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(template),
    id: 1_000 + index,
    name: `server-${String(index).padStart(4, "0")}`,
    ...extra(index),
  }));
}

/** CPU (per vCPU, percent) of a server in an hour, as the fake answers it. */
export function fakeCpu(serverId: number, hourMs: number): number {
  return ((serverId * 7 + hourMs / 3_600_000) % 90) + 5;
}

export interface FakeRequest {
  url: string;
  path: string;
  params: Record<string, string>;
  init: ConnectorFetchInit | undefined;
}

export interface FakeHetznerOptions {
  token?: string;
  data?: FakeData;
  /** The price list's answer; the fixture by default. */
  pricing?: unknown;
  /** Items per page at most (Hetzner: 50). */
  maxPerPage?: number;
  /** Servers whose metrics answer 404 (deleted) or 403. */
  gone?: Set<number>;
  forbiddenMetrics?: Set<number>;
  /** Answers queued ahead of the normal ones (429s, 5xx, …). */
  failures?: Array<{
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    /** Only for a request whose path matches. */
    path?: RegExp;
  }>;
  /** Rate-limit headers on every answer. */
  rateHeaders?: Record<string, string>;
  /** Called before each answer: lets a test change the data mid-run. */
  beforeAnswer?: (request: FakeRequest, data: FakeData) => void;
  /** Breaks a listing's pagination: more pages, but no next page. */
  brokenPagination?: boolean;
}

function response(
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

export interface FakeHetzner {
  runtime: ConnectorRuntime;
  requests: FakeRequest[];
  data: FakeData;
}

export function createFakeHetzner(
  options: FakeHetznerOptions = {},
): FakeHetzner {
  const token = options.token ?? FAKE_TOKEN;
  const data = options.data ?? fixtureData();
  const requests: FakeRequest[] = [];
  const failures = [...(options.failures ?? [])];
  const maxPerPage = options.maxPerPage ?? 50;

  function listing(key: keyof FakeData, params: Record<string, string>) {
    const page = Math.max(1, Number(params.page ?? "1") || 1);
    const perPage = Math.min(
      maxPerPage,
      Math.max(1, Number(params.per_page ?? "25") || 25),
    );
    const items = [...data[key]].sort((a, b) => a.id - b.id);
    const lastPage = Math.max(1, Math.ceil(items.length / perPage));
    const slice = items.slice((page - 1) * perPage, page * perPage);
    return {
      [key]: slice,
      meta: {
        pagination: {
          page,
          per_page: perPage,
          previous_page: page > 1 ? page - 1 : null,
          next_page:
            page < lastPage && !options.brokenPagination ? page + 1 : null,
          last_page: lastPage,
          total_entries: items.length,
        },
      },
    };
  }

  function metrics(serverId: number, params: Record<string, string>) {
    const start = Date.parse(params.start!);
    const end = Date.parse(params.end!);
    const step = Number(params.step) * 1000;
    const series: Record<string, Array<[number, string]>> = {
      cpu: [],
      "disk.0.iops.read": [],
      "disk.0.bandwidth.read": [],
      "disk.0.bandwidth.write": [],
      "network.0.bandwidth.in": [],
      "network.0.bandwidth.out": [],
    };
    for (let at = start; at <= end; at += step) {
      const seconds = at / 1000;
      series.cpu!.push([seconds, String(fakeCpu(serverId, at))]);
      series["disk.0.iops.read"]!.push([seconds, "1"]);
      series["disk.0.bandwidth.read"]!.push([seconds, String(serverId * 10)]);
      series["disk.0.bandwidth.write"]!.push([seconds, String(serverId * 20)]);
      series["network.0.bandwidth.in"]!.push([seconds, "1000.5"]);
      series["network.0.bandwidth.out"]!.push([seconds, "2000.25"]);
    }
    return {
      metrics: {
        start: params.start,
        end: params.end,
        step: Number(params.step),
        time_series: Object.fromEntries(
          Object.entries(series).map(([name, values]) => [name, { values }]),
        ),
      },
    };
  }

  function answer(path: string, params: Record<string, string>) {
    if (path === "/pricing") {
      return response(200, options.pricing ?? fixture("pricing.json"));
    }
    const metricsPath = /^\/servers\/(\d+)\/metrics$/.exec(path);
    if (metricsPath) {
      const id = Number(metricsPath[1]);
      if (
        options.gone?.has(id) ||
        !data.servers.some((server) => server.id === id)
      ) {
        return response(404, fixture("error-404.json"));
      }
      if (options.forbiddenMetrics?.has(id)) {
        return response(403, fixture("error-403-forbidden.json"));
      }
      return response(200, metrics(id, params));
    }
    const key = path.slice(1) as keyof FakeData;
    if (key in data) return response(200, listing(key, params));
    return response(404, fixture("error-404.json"));
  }

  const runtime: ConnectorRuntime = {
    signal: new AbortController().signal,
    fetch: async (url, init) => {
      if (!url.startsWith(`${HETZNER_API}/`) || init?.method !== "GET") {
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
      }
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/v1/, "");
      const params = Object.fromEntries(parsed.searchParams.entries());
      const request = { url, path, params, init };
      requests.push(request);
      options.beforeAnswer?.(request, data);
      const failureIndex = failures.findIndex(
        (failure) => !failure.path || failure.path.test(path),
      );
      if (failureIndex >= 0) {
        const [failure] = failures.splice(failureIndex, 1);
        return response(failure!.status, failure!.body ?? "", {
          ...options.rateHeaders,
          ...failure!.headers,
        });
      }
      if (init.headers?.authorization !== `Bearer ${token}`) {
        return response(401, fixture("error-401.json"), options.rateHeaders);
      }
      const result = answer(path, params);
      return {
        ...result,
        headers: { ...result.headers, ...options.rateHeaders },
      };
    },
  };
  return { runtime, requests, data };
}
