import { executeSync } from "@netrics/connector-runtime";
import type {
  ConnectionContext,
  Connector,
  ConnectorResponse,
  ConnectorRuntime,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { createHetznerCloudConnector } from "@netrics/connectors";
import { describe, expect, it } from "vitest";

// Whole Hetzner Cloud syncs through the host's own result validation
// (executeSync → validateSyncResult, ADR 0026 §7), which the connectors
// package cannot import. The connector talks to a small offline stand-in
// for the Hetzner Cloud API.

const NOW = "2024-01-31T00:30:00.000Z";
const TOKEN = "hetzner-server-test-token";
const HOUR_MS = 60 * 60 * 1000;

function answer(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      "content-type": "application/json",
      "ratelimit-limit": "3600",
      "ratelimit-remaining": "3599",
      "ratelimit-reset": String(Math.floor(Date.parse(NOW) / 1000) + 1),
    },
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

const location = {
  id: 1,
  name: "fsn1",
  city: "Falkenstein",
  country: "DE",
  network_zone: "eu-central",
};
const price = (net: string) => [
  {
    location: "fsn1",
    price_hourly: { net: "0.0060", gross: "0.0071" },
    price_monthly: { net, gross: net },
  },
];
const PRICING = {
  pricing: {
    currency: "EUR",
    vat_rate: "19.00",
    server_backup: { percentage: "20.00" },
    volume: { price_per_gb_month: { net: "0.0440", gross: "0.0524" } },
    image: { price_per_gb_month: { net: "0.0110", gross: "0.0131" } },
    server_types: [{ name: "cx22", prices: price("3.7900") }],
    load_balancer_types: [{ name: "lb11", prices: price("5.3900") }],
    primary_ips: [{ type: "ipv4", prices: price("0.5000") }],
    floating_ips: [{ type: "ipv4", prices: price("3.0000") }],
  },
};

interface FakeOptions {
  /** Servers whose metrics answer 403. */
  forbidden?: Set<number>;
  /** Called before each answer: lets a test change the servers mid-run. */
  beforeAnswer?: (
    path: string,
    params: URLSearchParams,
    servers: Array<{ id: number } & Record<string, unknown>>,
  ) => void;
  /** Answers this many items per page at most. */
  maxPerPage?: number;
}

function fakeHetzner(
  count: number,
  labels: Record<string, string>,
  options: FakeOptions = {},
) {
  const servers: Array<{ id: number } & Record<string, unknown>> = Array.from(
    { length: count },
    (_, index) => ({
      id: 100 + index,
      name: `server-${index}`,
      status: index % 5 === 0 ? "off" : "running",
      created: "2023-06-01T10:00:00+00:00",
      labels,
      server_type: { name: "cx22", cores: 2, memory: 4, disk: 40 },
      location,
      backup_window: index % 2 === 0 ? "22-02" : null,
      primary_disk_size: 40,
      included_traffic: 21990232555520,
      outgoing_traffic: 1000,
      ingoing_traffic: 2000,
    }),
  );
  const volumes = servers.map((server) => ({
    id: 9_000 + server.id,
    name: `vol-${server.id}`,
    size: 10,
    server: server.id,
    location,
  }));
  const snapshots = servers.slice(0, 3).map((server) => ({
    id: 8_000 + server.id,
    type: "snapshot",
    description: `before upgrade ${server.id}`,
    image_size: 2.5,
    created_from: { id: server.id, name: server.name },
  }));
  const listing = (key: string, items: unknown[], params: URLSearchParams) => {
    const page = Number(params.get("page") ?? "1");
    const perPage = Math.min(
      options.maxPerPage ?? 50,
      Number(params.get("per_page") ?? "25"),
    );
    const last = Math.max(1, Math.ceil(items.length / perPage));
    return {
      [key]: items.slice((page - 1) * perPage, page * perPage),
      meta: {
        pagination: {
          page,
          per_page: perPage,
          previous_page: page > 1 ? page - 1 : null,
          next_page: page < last ? page + 1 : null,
          last_page: last,
          total_entries: items.length,
        },
      },
    };
  };
  const runtime: ConnectorRuntime = {
    signal: new AbortController().signal,
    fetch: async (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\/v1/, "");
      const params = parsed.searchParams;
      options.beforeAnswer?.(path, params, servers);
      if (path === "/pricing") return answer(200, PRICING);
      if (path === "/servers")
        return answer(200, listing("servers", servers, params));
      if (path === "/volumes") {
        // A deleted server's volume went with it.
        const kept = volumes.filter((volume) =>
          servers.some((server) => server.id === volume.server),
        );
        return answer(200, listing("volumes", kept, params));
      }
      if (path === "/images") {
        expect(params.get("type")).toBe("snapshot");
        return answer(200, listing("images", snapshots, params));
      }
      if (
        path === "/primary_ips" ||
        path === "/floating_ips" ||
        path === "/load_balancers"
      ) {
        return answer(200, listing(path.slice(1), [], params));
      }
      const metrics = /^\/servers\/(\d+)\/metrics$/.exec(path);
      if (metrics) {
        if (options.forbidden?.has(Number(metrics[1]))) {
          return answer(403, {
            error: { code: "forbidden", message: "insufficient permissions" },
          });
        }
        const start = Date.parse(params.get("start")!);
        const end = Date.parse(params.get("end")!);
        const values: Array<[number, string]> = [];
        for (let at = start; at <= end; at += HOUR_MS) {
          values.push([at / 1000, String((at / HOUR_MS) % 100)]);
        }
        return answer(200, {
          metrics: {
            start: params.get("start"),
            end: params.get("end"),
            step: 3600,
            time_series: {
              cpu: { values },
              "network.0.bandwidth.in": { values },
              "network.0.bandwidth.out": { values },
              "disk.0.bandwidth.read": { values },
              "disk.0.bandwidth.write": { values },
            },
          },
        });
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  return runtime;
}

function hetznerWith(
  runtime: ConnectorRuntime,
  now: () => number = () => Date.parse(NOW),
  sleep: (ms: number) => Promise<void> = async () => {},
): Connector {
  const connector = createHetznerCloudConnector({ now, sleep });
  return {
    ...connector,
    sync: (ctx, request) => connector.sync(ctx, request, runtime),
  };
}

const context: ConnectionContext = {
  connectionId: "hetzner-host-test",
  config: {},
  credentials: { token: TOKEN },
};

async function syncThroughHost(
  connector: Connector,
  request: SyncRequest,
  start?: string,
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  let cursor: string | undefined = start;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const result = await executeSync(connector, context, {
      ...request,
      ...(cursor ? { cursor } : {}),
    });
    results.push(result);
    if (result.done) return results;
    cursor = result.nextCursor;
  }
  throw new Error("the sync did not finish");
}

const rows = (results: SyncResult[], key: string) =>
  results
    .flatMap((result) => result.datasetPages ?? [])
    .filter((page) => page.datasetKey === key)
    .flatMap((page) => page.records);

describe("Hetzner Cloud syncs through the host's validation (#872)", () => {
  it("accepts a small incremental sync", async () => {
    const results = await syncThroughHost(hetznerWith(fakeHetzner(3, {})), {
      mode: "incremental",
      from: "2024-01-30T20:00:00.000Z",
      to: NOW,
    });
    const last = results.at(-1)!;
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    expect(rows(results, "servers")).toHaveLength(3);
    // 3 servers, 2 backups, 3 volumes, 3 snapshots.
    expect(rows(results, "cost_items")).toHaveLength(3 + 2 + 3 + 3);
    expect(last.nextFrom).toBe("2024-01-31T00:00:00.000Z");
  });

  it("accepts many servers with large rows and 30 days of metrics", async () => {
    const labels = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `team.example.com/label-${index}`,
        "x".repeat(60),
      ]),
    );
    const results = await syncThroughHost(
      hetznerWith(fakeHetzner(140, labels)),
      {
        mode: "backfill",
        from: "2024-01-01T00:30:00.000Z",
        to: NOW,
      },
    );
    const last = results.at(-1)!;
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    expect(rows(results, "servers")).toHaveLength(140);
    expect(
      results
        .flatMap((result) => result.observations)
        .filter(
          (observation) =>
            observation.metricKey === "hetzner-cloud.cpu_vcpu_percent" &&
            observation.dimensions.resource === "100",
        ),
    ).toHaveLength(30 * 24);
    expect(
      last.freshness?.filter((entry) => entry.stream === "metrics"),
    ).toHaveLength(140);
  });
});

const observed = (results: SyncResult[], metricKey: string) =>
  results
    .flatMap((result) => result.observations)
    .filter((observation) => observation.metricKey === metricKey);

const costs = (results: SyncResult[]) =>
  Object.fromEntries(
    observed(results, "hetzner-cloud.monthly_cost").map((observation) => [
      observation.dimensions.resource,
      observation.value,
    ]),
  );

describe("Hetzner Cloud follow-ups through the host's validation (#893)", () => {
  const WINDOW: SyncRequest = {
    mode: "backfill",
    from: "2024-01-30T20:00:00.000Z",
    to: NOW,
  };

  it("zeroes a deleted server after a history reload", async () => {
    let deleted = false;
    const runtime = fakeHetzner(
      3,
      {},
      {
        beforeAnswer: (_path, _params, servers) => {
          const index = servers.findIndex((server) => server.id === 101);
          if (deleted && index >= 0) servers.splice(index, 1);
        },
      },
    );
    const first = await syncThroughHost(hetznerWith(runtime), WINDOW);
    expect(costs(first)["101"]).toBeGreaterThan(0);
    deleted = true;
    // A fresh backfill: no cursor, the stored one as the baseline only.
    const reload = await syncThroughHost(hetznerWith(runtime), {
      ...WINDOW,
      previousCursor: first.at(-1)!.nextCursor!,
    });
    expect(costs(reload)["101"]).toBe(0);
    expect(costs(reload)["100"]).toBeGreaterThan(0);
  });

  it("leaves the snapshots when a delete and a create between pages keep the total", async () => {
    let changed = false;
    const runtime = fakeHetzner(
      30,
      {},
      {
        maxPerPage: 10,
        beforeAnswer: (path, params, servers) => {
          if (!changed && path === "/servers" && params.get("page") === "2") {
            changed = true;
            servers.splice(0, 1);
            servers.push({ ...servers[0]!, id: 900 });
          }
        },
      },
    );
    const results = await syncThroughHost(hetznerWith(runtime), WINDOW);
    const last = results.at(-1)!;
    expect(last.receivedDatasets).toEqual([]);
    expect(last.nextFrom).toBe(WINDOW.from);
  });

  it("starts the snapshots over when a stored run is too old to resume", async () => {
    const runtime = fakeHetzner(3, {});
    const first = await executeSync(hetznerWith(runtime), context, WINDOW);
    expect(first.done).toBe(false);
    const oldKeys = new Set(
      (first.datasetPages ?? []).map((page) => page.refreshKey),
    );
    const later = () => Date.parse(NOW) + 13 * HOUR_MS;
    const resumed = await syncThroughHost(
      hetznerWith(runtime, later),
      WINDOW,
      first.nextCursor,
    );
    const pages = resumed.flatMap((result) => result.datasetPages ?? []);
    expect(pages.some((page) => oldKeys.has(page.refreshKey))).toBe(false);
    expect(resumed.at(-1)!.receivedDatasets).toEqual(["servers", "cost_items"]);
  });

  it("re-reads a refused server's hours once access returns", async () => {
    const forbidden = new Set([101]);
    const runtime = fakeHetzner(3, {}, { forbidden });
    const first = await syncThroughHost(hetznerWith(runtime), WINDOW);
    forbidden.clear();
    const later = () => Date.parse(NOW) + 2 * HOUR_MS;
    const second = await syncThroughHost(
      hetznerWith(runtime, later),
      {
        mode: "incremental",
        from: first.at(-1)!.nextFrom!,
        to: new Date(later()).toISOString(),
      },
      first.at(-1)!.nextCursor,
    );
    const hours = (resource: string) =>
      observed(second, "hetzner-cloud.cpu_vcpu_percent").filter(
        (observation) => observation.dimensions.resource === resource,
      );
    // 20:00 to 00:00, refused before, and the two new hours.
    expect(hours("101")).toHaveLength(6);
    expect(hours("100")).toHaveLength(2);
  });

  it("returns the checkpoint when a request stalls late in a page", async () => {
    const base = fakeHetzner(3, {});
    let t = Date.parse(NOW);
    let count = 0;
    const runtime: ConnectorRuntime = {
      ...base,
      fetch: async (url, init) => {
        count += 1;
        if (count === 10) {
          t += init?.timeoutMs ?? 60_000;
          throw Object.assign(new Error("egress timeout"), {
            name: "EgressTimeoutError",
          });
        }
        t += 1_000;
        return base.fetch(url, init);
      },
    };
    const started = t;
    const page = await executeSync(
      hetznerWith(
        runtime,
        () => t,
        async (ms) => {
          t += ms;
        },
      ),
      context,
      WINDOW,
    );
    expect(page.done).toBe(false);
    expect(t - started).toBeLessThanOrEqual(45_000);
  });
});
