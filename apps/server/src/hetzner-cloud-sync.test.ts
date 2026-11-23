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

function fakeHetzner(count: number, labels: Record<string, string>) {
  const servers = Array.from({ length: count }, (_, index) => ({
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
  }));
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
    const perPage = Number(params.get("per_page") ?? "25");
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
      if (path === "/pricing") return answer(200, PRICING);
      if (path === "/servers")
        return answer(200, listing("servers", servers, params));
      if (path === "/volumes")
        return answer(200, listing("volumes", volumes, params));
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

function hetznerWith(runtime: ConnectorRuntime): Connector {
  const connector = createHetznerCloudConnector({
    now: () => Date.parse(NOW),
    sleep: async () => {},
  });
  return {
    ...connector,
    sync: (ctx, request) => connector.sync(ctx, request, runtime),
  };
}

async function syncThroughHost(
  connector: Connector,
  request: SyncRequest,
): Promise<SyncResult[]> {
  const context: ConnectionContext = {
    connectionId: "hetzner-host-test",
    config: {},
    credentials: { token: TOKEN },
  };
  const results: SyncResult[] = [];
  let cursor: string | undefined;
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
