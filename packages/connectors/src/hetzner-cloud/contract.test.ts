import type {
  ConnectionContext,
  ConnectorRuntime,
  DatasetPage,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import {
  ConnectorError,
  DATASET_LIMITS,
  RateLimitedError,
  syncResultSchema,
  validateDatasetPage,
} from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  HetznerApiError,
  apiError,
  assertReadOnly,
  createHetznerClient,
} from "./api.js";
import { decimalOf, minorOf, units } from "./cost.js";
import { HETZNER_DATASETS, serverRecord, serverState } from "./datasets.js";
import {
  COST_STREAM,
  MAX_REQUESTS_PER_PAGE,
  METRICS,
  METRICS_STREAM,
  SERVERS_STREAM,
  SERVER_STATUSES,
  TOKEN_FORBIDDEN_CODE,
  TOKEN_REJECTED_CODE,
  TOKEN_REJECTED_MESSAGE,
  createHetznerCloudConnector,
  hetznerCloudManifest,
} from "./index.js";
import {
  checkPagination,
  metricsSchema,
  pricingSchema,
  serversPageSchema,
} from "./schemas.js";
import {
  FAKE_TOKEN,
  createFakeHetzner,
  fakeCpu,
  fixture,
  fixtureData,
  manyServers,
  type FakeHetznerOptions,
} from "./test-helpers.js";

const NOW = "2024-01-11T00:30:00.000Z";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const noSleep = async () => {};
const clock = () => Date.parse(NOW);

function connector(now: () => number = clock) {
  return createHetznerCloudConnector({ now, sleep: noSleep });
}

/**
 * The host's rules for one result (connector-runtime validateSyncResult,
 * ADR 0026 §7), which the connectors package may not import: a final result
 * carries only complete pages, received datasets only on the final result,
 * and every page fits its dataset. apps/server's hetzner-cloud-sync.test.ts
 * runs whole syncs through the real validation.
 */
function expectHostAccepts(result: SyncResult): void {
  const parsed = syncResultSchema.safeParse(result);
  expect(parsed.success, parsed.error?.message).toBe(true);
  if (result.done) {
    for (const page of result.datasetPages ?? []) {
      expect(page.complete, `${page.datasetKey} ${page.pageKey}`).toBe(true);
      expect(page.records).toEqual([]);
    }
    expectValidFreshness(hetznerCloudManifest, result);
  } else {
    expect(result.receivedDatasets ?? []).toEqual([]);
  }
  const schemas = new Map(
    HETZNER_DATASETS.map((dataset) => [dataset.key, dataset]),
  );
  for (const page of result.datasetPages ?? []) {
    expect(() =>
      validateDatasetPage(schemas.get(page.datasetKey)!, page),
    ).not.toThrow();
    for (const record of page.records) {
      expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThanOrEqual(
        DATASET_LIMITS.rowBytes,
      );
    }
  }
}

function context(
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    connectionId: "hetzner-test",
    config: {},
    credentials: { token: FAKE_TOKEN },
    ...overrides,
  };
}

const fake = (options: FakeHetznerOptions = {}) => createFakeHetzner(options);

const WINDOW: SyncRequest = {
  mode: "backfill",
  from: "2024-01-09T00:00:00.000Z",
  to: NOW,
};

/** Runs every page of one sync the way the engine does. */
async function syncAll(
  runtime: ConnectorRuntime,
  request: SyncRequest = WINDOW,
  ctx = context(),
  now: () => number = clock,
  start?: string,
) {
  const pages: SyncResult[] = [];
  let cursor: string | undefined = start;
  for (let guard = 0; guard < 500; guard += 1) {
    const page = await connector(now).sync(
      ctx,
      { ...request, ...(cursor ? { cursor } : {}) },
      runtime,
    );
    expectHostAccepts(page);
    pages.push(page);
    if (page.done) break;
    expect(page.nextCursor).not.toBe(cursor);
    cursor = page.nextCursor;
  }
  return {
    pages,
    observations: pages.flatMap((page) => page.observations),
    datasetPages: pages.flatMap((page) => page.datasetPages ?? []),
    last: pages.at(-1)!,
  };
}

function rowsOf(pages: DatasetPage[], key: string) {
  return pages
    .filter((page) => page.datasetKey === key)
    .flatMap((page) => page.records.map((record) => record.values));
}

function costOf(observations: Observation[]): Record<string, number> {
  return Object.fromEntries(
    observations
      .filter((observation) => observation.metricKey === METRICS.monthlyCost)
      .map((observation) => [
        observation.dimensions.resource,
        observation.value,
      ]),
  );
}

runConnectorContractTests(connector(), {
  context: context(),
  runtime: fake().runtime,
  cursorOrder: "changing",
});

describe("Hetzner Cloud manifest", () => {
  it("is a read-only connector of the Cloud API host", () => {
    expect(hetznerCloudManifest.outboundDomains).toEqual(["api.hetzner.cloud"]);
    expect(
      hetznerCloudManifest.datasets?.map((dataset) => dataset.key),
    ).toEqual(["servers", "cost_items"]);
    expect(hetznerCloudManifest.backfillDays).toBe(30);
    expect(
      hetznerCloudManifest.freshnessStreams?.map((stream) => stream.key),
    ).toEqual([SERVERS_STREAM, METRICS_STREAM, COST_STREAM]);
  });
});

describe("Hetzner Cloud check", () => {
  it("reads one server and the price list", async () => {
    const { runtime, requests } = fake();
    expect(await connector().check(context(), runtime)).toEqual({ ok: true });
    expect(requests.map((request) => request.path)).toEqual([
      "/servers",
      "/pricing",
    ]);
    expect(requests[0]!.params).toMatchObject({ per_page: "1" });
    expect(requests[0]!.init?.headers?.authorization).toBe(
      `Bearer ${FAKE_TOKEN}`,
    );
  });

  it("accepts the token of an empty project", async () => {
    const { runtime } = fake({
      data: {
        servers: [],
        volumes: [],
        primary_ips: [],
        floating_ips: [],
        load_balancers: [],
        images: [],
      },
    });
    expect(await connector().check(context(), runtime)).toEqual({ ok: true });
  });

  it("names a wrong token without echoing it", async () => {
    const { runtime } = fake({ token: "the-real-one" });
    const result = await connector().check(context(), runtime);
    expect(result).toEqual({
      ok: false,
      code: TOKEN_REJECTED_CODE,
      message: TOKEN_REJECTED_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("names a token that may not read", async () => {
    const { runtime } = fake({
      failures: [{ status: 403, body: fixture("error-403-forbidden.json") }],
    });
    const result = await connector().check(context(), runtime);
    expect(result).toMatchObject({ ok: false, code: TOKEN_FORBIDDEN_CODE });
  });

  it("throws (retryable) during maintenance", async () => {
    const { runtime } = fake({
      failures: [{ status: 403, body: fixture("error-403-maintenance.json") }],
    });
    await expect(connector().check(context(), runtime)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("asks for a token when none is stored", async () => {
    const { runtime, requests } = fake();
    const result = await connector().check(
      context({ credentials: {} }),
      runtime,
    );
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});

describe("Hetzner Cloud discover", () => {
  it("lists servers and load balancers, and the unattached items", async () => {
    const resources = await connector().discover(context(), fake().runtime);
    expect(
      resources.map((resource) => [resource.kind, resource.id, resource.name]),
    ).toEqual([
      ...fixtureData().servers.map((server) => [
        "server",
        String(server.id),
        server.name,
      ]),
      ["load_balancer", "lb-7001", "web-lb"],
      ["unattached", "unattached", "Not attached to a server"],
    ]);
  });

  it("pages through servers", async () => {
    const data = { ...fixtureData(), servers: manyServers(23) };
    const { runtime, requests } = fake({ data, maxPerPage: 10 });
    const resources = await connector().discover(context(), runtime);
    expect(resources.filter((r) => r.kind === "server")).toHaveLength(23);
    expect(
      requests
        .filter((request) => request.path === "/servers")
        .map((request) => request.params.page),
    ).toEqual(["1", "2", "3"]);
  });

  it("refuses a listing that announces pages it does not name", async () => {
    const data = { ...fixtureData(), servers: manyServers(23) };
    const { runtime } = fake({ data, maxPerPage: 10, brokenPagination: true });
    await expect(connector().discover(context(), runtime)).rejects.toThrow(
      /announces more pages but names no next page/,
    );
  });
});

describe("Hetzner Cloud sync", () => {
  it("reads servers, cost and metrics into valid pages", async () => {
    const { runtime, requests } = fake();
    const { observations, datasetPages, last, pages } = await syncAll(runtime);

    // Servers: every status, with its state for the status widget.
    const servers = rowsOf(datasetPages, "servers");
    expect(servers.map((row) => [row.status, row.state])).toEqual([
      ["running", "up"],
      ["initializing", "building"],
      ["starting", "building"],
      ["stopping", "down"],
      ["off", "down"],
      ["deleting", "down"],
      ["migrating", "building"],
      ["rebuilding", "building"],
      ["unknown", "unknown"],
    ]);
    expect(servers[0]).toMatchObject({
      server_id: "42",
      name: "server-running",
      server_type: "cx22",
      cores: 2,
      location: "fsn1",
      city: "Falkenstein",
      labels: { environment: "production", app: "shop" },
      backups: true,
      created_at: "2023-01-10T08:30:00.000Z",
      checked_at: NOW,
    });

    // Cost: every item at its monthly price, net, in cents of EUR.
    expect(costOf(observations)).toEqual({
      // cx22 3.79 + backups 0.758 + 100 GB 4.40 + IPv4 0.50 (+ IPv6 0)
      // + a 2.3 GB snapshot 0.0253
      "42": 947,
      "43": 1610, // cpx31 13.10 + floating IPv4 3.00
      "44": 379,
      "45": 379,
      "46": 1572, // cpx31 13.10 + backups 2.62
      "47": 379,
      "48": 379,
      "49": 1310,
      "50": 379,
      "lb-7001": 539,
      // 10 GB 0.44 + unassigned IPv4 0.50 + a 10 GB snapshot of a server
      // that no longer exists 0.11
      unattached: 105,
    });
    const cost = observations.find(
      (observation) => observation.metricKey === METRICS.monthlyCost,
    )!;
    expect(cost.sourceTimestamp).toBe("2024-01-11T00:00:00.000Z");
    expect(cost.dimensions.currency).toBe("EUR");
    const items = rowsOf(datasetPages, "cost_items");
    expect(items).toHaveLength(9 + 2 + 2 + 3 + 1 + 1 + 2);
    // Snapshots only (backups are priced as a share of the server), each
    // with its source server when that server is in the project.
    expect(
      items
        .filter((row) => row.item_kind === "snapshot")
        .map((row) => [
          row.item_id,
          row.resource_id,
          row.basis,
          row.monthly_net,
        ]),
    ).toEqual([
      ["8001", "42", "2.3 GB", "0.025300"],
      ["8002", "unattached", "10 GB", "0.110000"],
    ]);
    expect(
      requests.find((request) => request.path === "/images")!.params,
    ).toMatchObject({ type: "snapshot", sort: "id:asc" });
    expect(
      items.find(
        (row) => row.item_kind === "server_backup" && row.item_id === "42",
      ),
    ).toMatchObject({
      resource_id: "42",
      basis: "20.00 %",
      monthly_net: "0.758000",
      monthly_gross: "0.902020",
      currency: "EUR",
    });

    // Metrics: one value an hour per server; CPU as Hetzner reports it,
    // per vCPU (a resize must not rescale history).
    const cpu = observations.filter(
      (observation) =>
        observation.metricKey === METRICS.cpu &&
        observation.dimensions.resource === "43",
    );
    expect(cpu).toHaveLength(48);
    expect(cpu[0]).toEqual({
      metricKey: "hetzner-cloud.cpu_vcpu_percent",
      sourceTimestamp: "2024-01-09T00:00:00.000Z",
      value:
        Math.round(fakeCpu(43, Date.parse("2024-01-09T00:00:00.000Z")) * 1e6) /
        1e6,
      dimensions: { resource: "43" },
    });
    expect(cpu.at(-1)!.sourceTimestamp).toBe("2024-01-10T23:00:00.000Z");
    for (const key of [
      METRICS.diskRead,
      METRICS.diskWrite,
      METRICS.networkIn,
      METRICS.networkOut,
    ]) {
      expect(
        observations.filter((observation) => observation.metricKey === key),
      ).toHaveLength(9 * 48);
    }
    const metricRequests = requests.filter((request) =>
      request.path.endsWith("/metrics"),
    );
    expect(metricRequests).toHaveLength(9);
    expect(metricRequests[0]!.params).toEqual({
      type: "cpu,disk,network",
      start: "2024-01-09T00:00:00.000Z",
      end: "2024-01-11T00:00:00.000Z",
      step: "3600",
    });

    // The final page completes both snapshots and reports every stream.
    expect(last.done).toBe(true);
    expect(last.observations).toEqual([]);
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    expect(last.freshness).toEqual([
      { stream: SERVERS_STREAM },
      ...fixtureData().servers.map((server) => ({
        stream: METRICS_STREAM,
        resource: String(server.id),
      })),
      { stream: COST_STREAM },
    ]);
    expect(last.nextFrom).toBe("2024-01-11T00:00:00.000Z");
    for (const page of pages) {
      expect(page.datasetPages?.length ?? 0).toBeLessThanOrEqual(
        DATASET_LIMITS.datasets,
      );
    }
  });

  it("reads nothing more of metrics while no new hour is complete", async () => {
    const { runtime, requests } = fake();
    const { last } = await syncAll(runtime, {
      mode: "incremental",
      from: "2024-01-11T00:00:00.000Z",
      to: NOW,
    });
    expect(requests.some((request) => request.path.endsWith("/metrics"))).toBe(
      false,
    );
    expect(last.nextFrom).toBe("2024-01-11T00:00:00.000Z");
    // Nothing was read, so no server's metrics are reported fresh
    // (ADR 0025 §2); the stored freshness stays.
    expect(
      last.freshness?.filter((entry) => entry.stream === METRICS_STREAM),
    ).toEqual([]);
  });

  it("reads 30 days of metrics in requests of at most 500 samples", async () => {
    const { runtime, requests } = fake();
    const { observations } = await syncAll(runtime, {
      mode: "backfill",
      from: new Date(clock() - 40 * DAY_MS).toISOString(),
      to: NOW,
    });
    const metricRequests = requests.filter(
      (request) => request.path === "/servers/42/metrics",
    );
    expect(metricRequests).toHaveLength(2);
    for (const request of metricRequests) {
      const samples =
        (Date.parse(request.params.end!) - Date.parse(request.params.start!)) /
          HOUR_MS +
        1;
      expect(samples).toBeLessThanOrEqual(500);
    }
    // Hetzner keeps 30 days: nothing older is asked for.
    expect(metricRequests[0]!.params.start).toBe("2023-12-12T00:00:00.000Z");
    expect(metricRequests[1]!.params.end).toBe("2024-01-11T00:00:00.000Z");
    const hours = observations.filter(
      (observation) =>
        observation.metricKey === METRICS.cpu &&
        observation.dimensions.resource === "42",
    );
    expect(hours).toHaveLength(30 * 24);
    expect(new Set(hours.map((hour) => hour.sourceTimestamp)).size).toBe(
      30 * 24,
    );
  });

  it("completes an empty project", async () => {
    const { runtime } = fake({
      data: {
        servers: [],
        volumes: [],
        primary_ips: [],
        floating_ips: [],
        load_balancers: [],
        images: [],
      },
    });
    const { observations, datasetPages, last } = await syncAll(runtime);
    expect(observations).toEqual([]);
    expect(datasetPages.every((page) => page.records.length === 0)).toBe(true);
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    expect(last.freshness).toEqual([
      { stream: SERVERS_STREAM },
      { stream: COST_STREAM },
    ]);
  });

  it("refuses a revoked token with the check's reason code", async () => {
    const { runtime } = fake({ token: "another" });
    const error = await connector()
      .sync(context(), WINDOW, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorError);
    expect((error as ConnectorError).code).toBe(TOKEN_REJECTED_CODE);
  });

  it("never puts Hetzner's error text into an error", async () => {
    const echo = {
      error: { code: "invalid_input", message: `echo ${FAKE_TOKEN} SECRET` },
    };
    const error = apiError(422, echo);
    expect(error.message).not.toContain("SECRET");
    expect(error.message).toBe("Hetzner Cloud API answered 422.");
    const { runtime } = fake({ failures: [{ status: 422, body: echo }] });
    const thrown = await connector()
      .sync(context(), WINDOW, runtime)
      .catch((caught: unknown) => caught as Error);
    expect(thrown).toBeInstanceOf(HetznerApiError);
    expect((thrown as Error).message).not.toContain("SECRET");
  });
});

describe("Hetzner Cloud answers", () => {
  it("parses the fixtures", () => {
    expect(
      serversPageSchema.safeParse(fixture("servers-all-statuses.json")).success,
    ).toBe(true);
    expect(
      serversPageSchema.safeParse(fixture("servers-empty.json")).success,
    ).toBe(true);
    expect(pricingSchema.safeParse(fixture("pricing.json")).success).toBe(true);
    expect(
      metricsSchema.safeParse(fixture("metrics-cpu-disk-network.json")).success,
    ).toBe(true);
  });

  it("maps every documented server status to a state", () => {
    expect(
      Object.fromEntries(
        SERVER_STATUSES.map((status) => [status, serverState(status)]),
      ),
    ).toEqual({
      running: "up",
      initializing: "building",
      starting: "building",
      stopping: "down",
      off: "down",
      deleting: "down",
      migrating: "building",
      rebuilding: "building",
      unknown: "unknown",
    });
    expect(serverState("hibernating")).toBe("unknown");
  });

  it("classifies Hetzner's errors by status and code", () => {
    expect(apiError(401, fixture("error-401.json")).kind).toBe("auth");
    expect(apiError(403, fixture("error-403-forbidden.json")).kind).toBe(
      "forbidden",
    );
    expect(apiError(403, fixture("error-403-maintenance.json")).kind).toBe(
      "unavailable",
    );
    expect(apiError(404, fixture("error-404.json")).kind).toBe("not_found");
  });

  it("only reads listings, never an action", () => {
    expect(() => assertReadOnly("/servers")).not.toThrow();
    expect(() => assertReadOnly("/servers/42/metrics")).not.toThrow();
    expect(() => assertReadOnly("/servers/42/actions/poweroff")).toThrow();
    expect(() => assertReadOnly("/servers/42")).toThrow();
    expect(() => assertReadOnly("/ssh_keys")).toThrow();
  });

  it("checks pagination invariants", () => {
    const page = {
      page: 1,
      per_page: 50,
      previous_page: null,
      next_page: 2,
      last_page: 3,
      total_entries: 120,
    };
    expect(checkPagination(page, 1, 50, "x")).toBe(2);
    expect(() =>
      checkPagination({ ...page, next_page: null }, 1, 50, "x"),
    ).toThrow(/announces more pages/);
    expect(() => checkPagination(page, 2, 50, "x")).toThrow(/another page/);
    expect(() =>
      checkPagination({ ...page, next_page: 3 }, 1, 50, "x"),
    ).toThrow(/skips a page/);
    expect(() => checkPagination(page, 1, 0, "x")).toThrow(/empty page/);
    expect(() => checkPagination(page, 1, 51, "x")).toThrow(/per_page/);
    expect(
      checkPagination(
        { ...page, next_page: null, last_page: null, total_entries: null },
        1,
        10,
        "x",
      ),
    ).toBeNull();
  });

  it("does exact decimal arithmetic", () => {
    expect(decimalOf(units("3.7900") + units("0.758"))).toBe("4.548000");
    expect(minorOf(units("9.4480"), "EUR")).toBe(945);
    expect(minorOf(units("9.4449"), "EUR")).toBe(944);
    expect(minorOf(units("100.5"), "JPY")).toBe(101);
    expect(decimalOf(units("0.0524") * 100n)).toBe("5.240000");
  });

  it("keeps a server row within 64 KiB by leaving huge labels out", () => {
    const server = serversPageSchema.parse(fixture("servers-all-statuses.json"))
      .servers[0]!;
    const labels = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [
        `label-${index}`,
        "v".repeat(60),
      ]),
    );
    const record = serverRecord({ ...server, labels }, NOW);
    expect(record.values.labels).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(
      DATASET_LIMITS.rowBytes,
    );
  });
});

describe("rate limits and failures", () => {
  it("hands a persistent 429 to the host as a rate limit", async () => {
    const failures = Array.from({ length: 3 }, () => ({
      status: 429,
      body: fixture("error-429.json"),
      headers: {
        "ratelimit-limit": "3600",
        "ratelimit-remaining": "0",
        "ratelimit-reset": String(Math.floor(clock() / 1000) + 3600),
      },
    }));
    const { runtime } = fake({ failures });
    const error = await connector()
      .sync(context(), WINDOW, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(Date.parse((error as RateLimitedError).retryAt)).toBeGreaterThan(
      clock(),
    );
  });

  it("keeps a 429 without headers a rate limit", async () => {
    const failures = Array.from({ length: 3 }, () => ({
      status: 429,
      body: fixture("error-429.json"),
    }));
    const { runtime } = fake({ failures });
    await expect(
      connector().sync(context(), WINDOW, runtime),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("waits out a short 429 and server errors, then goes on", async () => {
    const { runtime, requests } = fake({
      failures: [
        { status: 429, body: fixture("error-429.json") },
        { status: 503, body: "" },
      ],
    });
    const { last } = await syncAll(runtime);
    expect(last.done).toBe(true);
    expect(requests[0]!.path).toBe("/pricing");
    expect(requests[2]!.path).toBe("/pricing");
  });

  it("paces itself when the budget runs low", async () => {
    const reset = String(Math.floor(clock() / 1000) + 3600);
    const { runtime } = fake({
      rateHeaders: {
        "ratelimit-limit": "3600",
        "ratelimit-remaining": "10",
        "ratelimit-reset": reset,
      },
    });
    const waits: number[] = [];
    const sync = createHetznerCloudConnector({
      now: clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const page = await sync.sync(context(), WINDOW, runtime);
    expect(page.done).toBe(false);
    // Ten requests short of the floor refill at one a second.
    expect(waits[0]).toBe(10_000);
  });

  it("stops before the budget runs out when it refills later", async () => {
    const { runtime, requests } = fake({
      rateHeaders: {
        "ratelimit-limit": "3600",
        "ratelimit-remaining": "0",
        "ratelimit-reset": String(Math.floor(clock() / 1000) + 3600),
      },
    });
    // The first request tells the budget; nothing is sent past it, and the
    // page returns what it read.
    const first = await connector().sync(context(), WINDOW, runtime);
    expect(first.done).toBe(false);
    expect(requests).toHaveLength(1);
    // The next page starts with the step that waits, as a rate limit.
    const error = await connector()
      .sync(context(), { ...WINDOW, cursor: first.nextCursor }, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
  });

  it("returns the progress when a later step fails, and repeats only that step", async () => {
    const { runtime, requests } = fake({
      failures: [
        {
          status: 500,
          body: "",
          path: /^\/volumes$/,
        },
        { status: 500, body: "", path: /^\/volumes$/ },
        { status: 500, body: "", path: /^\/volumes$/ },
      ],
    });
    const first = await connector().sync(context(), WINDOW, runtime);
    expectHostAccepts(first);
    expect(first.done).toBe(false);
    expect(rowsOf(first.datasetPages ?? [], "servers")).toHaveLength(9);
    const paths = requests.map((request) => request.path);
    expect(paths).toEqual([
      "/pricing",
      "/servers",
      "/volumes",
      "/volumes",
      "/volumes",
    ]);
    requests.length = 0;
    const second = await connector().sync(
      context(),
      { ...WINDOW, cursor: first.nextCursor },
      runtime,
    );
    expectHostAccepts(second);
    expect(requests[0]!.path).toBe("/volumes");
    expect(rowsOf(second.datasetPages ?? [], "servers")).toEqual([]);
  });

  it("returns the progress when a later step is rate limited", async () => {
    const limited = Array.from({ length: 3 }, () => ({
      status: 429,
      body: fixture("error-429.json"),
      path: /^\/volumes$/,
    }));
    const { runtime } = fake({ failures: limited });
    const first = await connector().sync(context(), WINDOW, runtime);
    expect(first.done).toBe(false);
    // The next page hands the limit to the host before it sends anything.
    const still = fake();
    await expect(
      connector().sync(
        context(),
        { ...WINDOW, cursor: first.nextCursor },
        still.runtime,
      ),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(still.requests).toHaveLength(0);
    // After the reset it continues with the step that was limited.
    const later = fake();
    await connector(() => clock() + 2 * HOUR_MS).sync(
      context(),
      { ...WINDOW, cursor: first.nextCursor },
      later.runtime,
    );
    expect(later.requests[0]!.path).toBe("/volumes");
  });

  it("bounds the requests of every page", async () => {
    const data = { ...fixtureData(), servers: manyServers(120) };
    const { runtime, requests } = fake({ data });
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard += 1) {
      const before = requests.length;
      const page = await connector().sync(
        context(),
        { ...WINDOW, ...(cursor ? { cursor } : {}) },
        runtime,
      );
      expect(requests.length - before).toBeLessThanOrEqual(
        MAX_REQUESTS_PER_PAGE,
      );
      if (page.done) break;
      cursor = page.nextCursor;
    }
  });
});

describe("checkpoints and snapshots", () => {
  it("starts over when the token changed since the checkpoint", async () => {
    const { runtime } = fake();
    const first = await connector().sync(context(), WINDOW, runtime);
    expect(first.done).toBe(false);
    const other = fake({ token: "other-token" });
    await connector().sync(
      context({ credentials: { token: "other-token" } }),
      { ...WINDOW, cursor: first.nextCursor },
      other.runtime,
    );
    expect(other.requests[0]!.path).toBe("/pricing");
    expect(first.nextCursor).not.toContain(FAKE_TOKEN);
    expect(
      Buffer.from(first.nextCursor!.split(":")[1]!, "base64url").toString(
        "utf8",
      ),
    ).not.toContain(FAKE_TOKEN);
  });

  it("starts over for another connection", async () => {
    const { runtime } = fake();
    const first = await connector().sync(context(), WINDOW, runtime);
    const second = fake();
    await connector().sync(
      context({ connectionId: "another" }),
      { ...WINDOW, cursor: first.nextCursor },
      second.runtime,
    );
    expect(second.requests[0]!.path).toBe("/pricing");
  });

  it("leaves the snapshots as stored when a server disappears during the run", async () => {
    const { runtime } = fake({ gone: new Set([45]) });
    const { last, observations } = await syncAll(runtime);
    expect(last.receivedDatasets).toEqual([]);
    expect(last.datasetPages).toEqual([]);
    expect(last.freshness?.map((entry) => entry.stream)).not.toContain(
      SERVERS_STREAM,
    );
    expect(last.freshness?.map((entry) => entry.stream)).not.toContain(
      COST_STREAM,
    );
    expect(last.freshness?.some((entry) => entry.resource === "45")).toBe(
      false,
    );
    expect(costOf(observations)).toEqual({});
  });

  it("goes on past a server whose metrics are refused", async () => {
    const { runtime } = fake({ forbiddenMetrics: new Set([44]) });
    const { last } = await syncAll(runtime);
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    const metrics = last
      .freshness!.filter((entry) => entry.stream === METRICS_STREAM)
      .map((entry) => entry.resource);
    expect(metrics).toHaveLength(8);
    expect(metrics).not.toContain("44");
  });

  it("does not complete a snapshot from a listing that shifted between pages", async () => {
    const data = { ...fixtureData(), servers: manyServers(30) };
    const { runtime } = fake({
      data,
      maxPerPage: 10,
      beforeAnswer: (request, current) => {
        // A server is deleted after the first page was read.
        if (request.path === "/servers" && request.params.page === "2") {
          current.servers.splice(0, 1);
        }
      },
    });
    const { last, datasetPages } = await syncAll(runtime);
    expect(last.receivedDatasets).toEqual([]);
    expect(last.freshness?.map((entry) => entry.stream)).not.toContain(
      SERVERS_STREAM,
    );
    // No server row twice, whatever the shift did.
    const ids = rowsOf(datasetPages, "servers").map((row) => row.server_id);
    expect(new Set(ids).size).toBe(ids.length);
    // A server the shift left out has unread hours: the next window starts
    // where this one did.
    expect(last.nextFrom).toBe(WINDOW.from);
  });

  it("reports no cost for a resource the price list has no price for", async () => {
    const data = fixtureData();
    data.servers[2] = {
      ...data.servers[2]!,
      location: { id: 9, name: "sin", city: "Singapore", country: "SG" },
    };
    const { runtime } = fake({ data });
    const { last, observations, datasetPages } = await syncAll(runtime);
    expect(costOf(observations)["44"]).toBeUndefined();
    expect(costOf(observations)["42"]).toBe(947);
    expect(
      rowsOf(datasetPages, "cost_items").find((row) => row.item_id === "44"),
    ).toMatchObject({ monthly_net: null, monthly_gross: null });
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    expect(last.freshness?.map((entry) => entry.stream)).not.toContain(
      COST_STREAM,
    );
  });

  it("splits a large project into valid pages and results", async () => {
    const labels = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `team.example.com/label-${index}`,
        "x".repeat(60),
      ]),
    );
    const data = {
      ...fixtureData(),
      servers: manyServers(600, () => ({ labels })),
    };
    const { runtime } = fake({ data });
    const { datasetPages, pages, last } = await syncAll(runtime, {
      mode: "incremental",
      from: "2024-01-10T22:00:00.000Z",
      to: NOW,
    });
    expect(rowsOf(datasetPages, "servers")).toHaveLength(600);
    expect(
      new Set(rowsOf(datasetPages, "servers").map((r) => r.server_id)).size,
    ).toBe(600);
    for (const page of pages) {
      expect(page.datasetPages?.length ?? 0).toBeLessThanOrEqual(
        DATASET_LIMITS.datasets,
      );
    }
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    expect(
      last.freshness?.filter((entry) => entry.stream === METRICS_STREAM),
    ).toHaveLength(600);
  });

  it("stamps cost on the day the run started, rows when they were read", async () => {
    // The run starts at 23:55 UTC and its pages run past midnight.
    let at = Date.parse("2024-01-10T23:55:00.000Z");
    const now = () => at;
    const data = { ...fixtureData(), servers: manyServers(30) };
    const { runtime } = fake({
      data,
      maxPerPage: 5,
      beforeAnswer: () => {
        at += 60_000;
      },
    });
    const { observations, datasetPages } = await syncAll(
      runtime,
      { mode: "incremental", from: "2024-01-10T20:00:00.000Z", to: NOW },
      context(),
      now,
    );
    const stamps = new Set(
      observations
        .filter((o) => o.metricKey === METRICS.monthlyCost)
        .map((o) => o.sourceTimestamp),
    );
    expect([...stamps]).toEqual(["2024-01-10T00:00:00.000Z"]);
    const checked = new Set(
      rowsOf(datasetPages, "servers").map((row) => row.checked_at),
    );
    expect(checked.size).toBeGreaterThan(1);
    // Metrics only for hours complete when the run started.
    expect(
      observations
        .filter((o) => o.metricKey === METRICS.cpu)
        .every(
          (o) =>
            Date.parse(o.sourceTimestamp) <
            Date.parse("2024-01-10T23:00:00.000Z"),
        ),
    ).toBe(true);
  });
});

describe("review round 1 (#890)", () => {
  it("reports zero for a resource whose items left since the last run", async () => {
    const { runtime, data } = fake();
    const first = await syncAll(runtime);
    expect(costOf(first.observations).unattached).toBe(105);
    // Everything unattached is gone, and server 50 was deleted.
    data.volumes = data.volumes.filter((volume) => volume.id !== 4712);
    data.primary_ips = data.primary_ips.filter((ip) => ip.id !== 5003);
    data.images = data.images.filter((image) => image.id !== 8002);
    data.servers = data.servers.filter((server) => server.id !== 50);
    const second = await syncAll(
      runtime,
      {
        mode: "incremental",
        from: first.last.nextFrom!,
        to: NOW,
      },
      context(),
      clock,
      first.last.nextCursor,
    );
    const cost = costOf(second.observations);
    expect(cost.unattached).toBe(0);
    expect(cost["50"]).toBe(0);
    expect(cost["42"]).toBe(947);
  });

  it("keeps an unpriced resource unknown, not zero", async () => {
    const { runtime, data } = fake();
    const first = await syncAll(runtime);
    expect(costOf(first.observations)["44"]).toBe(379);
    data.servers[2] = {
      ...data.servers[2]!,
      location: { id: 9, name: "sin", city: "Singapore", country: "SG" },
    };
    const second = await syncAll(
      runtime,
      {
        mode: "incremental",
        from: first.last.nextFrom!,
        to: NOW,
      },
      context(),
      clock,
      first.last.nextCursor,
    );
    expect(costOf(second.observations)).not.toHaveProperty("44");
  });

  it("forgets the reported resources when the token changes", async () => {
    const { runtime } = fake();
    const first = await syncAll(runtime);
    const other = fake({
      token: "other-token",
      data: {
        servers: [],
        volumes: [],
        primary_ips: [],
        floating_ips: [],
        load_balancers: [],
        images: [],
      },
    });
    const second = await syncAll(
      other.runtime,
      { mode: "incremental", from: first.last.nextFrom!, to: NOW },
      context({ credentials: { token: "other-token" } }),
      clock,
      first.last.nextCursor,
    );
    expect(costOf(second.observations)).toEqual({});
  });

  it("gives up waiting for the rate limit within the check's deadline", async () => {
    const reset = String(Math.floor(clock() / 1000) + 3600);
    const { runtime, requests } = fake({
      rateHeaders: {
        "ratelimit-limit": "3600",
        "ratelimit-remaining": "10",
        "ratelimit-reset": reset,
      },
    });
    const waits: number[] = [];
    const check = createHetznerCloudConnector({
      now: clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).check(context(), runtime);
    // Ten requests short of the floor refill in ten seconds: more than a
    // check may wait (the host gives it 15 s for everything).
    await expect(check).rejects.toBeInstanceOf(RateLimitedError);
    expect(waits).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("reads a volume's assignee, and `server` only without one", async () => {
    const data = fixtureData();
    const { server: _, ...withoutServer } = data.volumes[0]!;
    data.volumes[0] = {
      ...withoutServer,
      assignee: { id: 43, type: "server" },
    };
    data.volumes[1] = { ...data.volumes[1]!, server: 44 };
    delete data.volumes[1]!.assignee;
    const { runtime } = fake({ data });
    const { datasetPages } = await syncAll(runtime);
    const volumes = rowsOf(datasetPages, "cost_items").filter(
      (row) => row.item_kind === "volume",
    );
    expect(volumes.map((row) => [row.item_id, row.resource_id])).toEqual([
      ["4711", "43"],
      ["4712", "44"],
    ]);
  });
});

describe("follow-ups of the final review (#893)", () => {
  /** Removes every unattached item and server 50 from the fixture data. */
  function shrink(data: ReturnType<typeof fixtureData>) {
    data.volumes = data.volumes.filter((volume) => volume.id !== 4712);
    data.primary_ips = data.primary_ips.filter((ip) => ip.id !== 5003);
    data.images = data.images.filter((image) => image.id !== 8002);
    data.servers = data.servers.filter((server) => server.id !== 50);
  }

  it("zeroes a resource that left before a history reload", async () => {
    const { runtime, data } = fake();
    const first = await syncAll(runtime);
    expect(costOf(first.observations).unattached).toBe(105);
    shrink(data);
    // A fresh backfill gets no cursor; the host hands it the stored one
    // only as the baseline of what was reported.
    const reload = await syncAll(runtime, {
      ...WINDOW,
      previousCursor: first.last.nextCursor!,
    });
    const cost = costOf(reload.observations);
    expect(cost.unattached).toBe(0);
    expect(cost["50"]).toBe(0);
    expect(cost["42"]).toBe(947);
    // The reload's own cursor keeps the baseline for the run after it.
    data.servers = data.servers.filter((server) => server.id !== 44);
    const next = await syncAll(
      runtime,
      { mode: "incremental", from: reload.last.nextFrom!, to: NOW },
      context(),
      clock,
      reload.last.nextCursor,
    );
    expect(costOf(next.observations)["44"]).toBe(0);
    expect(costOf(next.observations)).not.toHaveProperty("50");
  });

  it("takes the baseline from an unfinished run's checkpoint too", async () => {
    const { runtime, data } = fake();
    const first = await syncAll(runtime);
    // A second run stopped part-way; its checkpoint is what is stored.
    const partial = await connector().sync(
      context(),
      { mode: "incremental", from: first.last.nextFrom!, to: NOW },
      runtime,
    );
    expect(partial.done).toBe(false);
    shrink(data);
    const reload = await syncAll(runtime, {
      ...WINDOW,
      previousCursor: partial.nextCursor!,
    });
    expect(costOf(reload.observations).unattached).toBe(0);
    expect(costOf(reload.observations)["50"]).toBe(0);
  });

  it("ignores a baseline of another token", async () => {
    const { runtime, data } = fake();
    const first = await syncAll(runtime);
    shrink(data);
    const other = fake({ token: "other-token", data });
    const reload = await syncAll(
      other.runtime,
      { ...WINDOW, previousCursor: first.last.nextCursor! },
      context({ credentials: { token: "other-token" } }),
    );
    expect(costOf(reload.observations)).not.toHaveProperty("unattached");
    expect(costOf(reload.observations)).not.toHaveProperty("50");
  });

  it("does not complete a snapshot when a delete and a create between pages keep the total", async () => {
    const data = { ...fixtureData(), servers: manyServers(30) };
    let changed = false;
    const { runtime } = fake({
      data,
      maxPerPage: 10,
      beforeAnswer: (request, current) => {
        // After the first page: one server goes, another comes. The total
        // stays 30 and no ID repeats, but page 2 now starts one later.
        if (
          !changed &&
          request.path === "/servers" &&
          request.params.page === "2"
        ) {
          changed = true;
          current.servers.splice(0, 1);
          current.servers.push({ ...current.servers[0]!, id: 5_000 });
        }
      },
    });
    const { last } = await syncAll(runtime);
    expect(last.receivedDatasets).toEqual([]);
    const streams = last.freshness?.map((entry) => entry.stream) ?? [];
    expect(streams).not.toContain(SERVERS_STREAM);
    expect(streams).not.toContain(COST_STREAM);
    expect(last.nextFrom).toBe(WINDOW.from);
  });

  it("verifies the pages of a listing before it completes a snapshot", async () => {
    const data = { ...fixtureData(), servers: manyServers(30) };
    const { runtime, requests } = fake({ data, maxPerPage: 10 });
    const { last } = await syncAll(runtime);
    expect(last.receivedDatasets).toEqual(["servers", "cost_items"]);
    // Pages 1–3, then 1 and 2 again to check their boundaries.
    expect(
      requests
        .filter((request) => request.path === "/servers")
        .map((request) => request.params.page),
    ).toEqual(["1", "2", "3", "1", "2"]);
  });

  it("starts the snapshots over when the run's chain may have expired", async () => {
    const { runtime } = fake();
    const first = await connector().sync(context(), WINDOW, runtime);
    expect(first.done).toBe(false);
    const oldKeys = new Set(
      (first.datasetPages ?? []).map((page) => page.refreshKey),
    );
    expect(oldKeys.size).toBe(2);
    // The host stopped the run (a long outage, a paused connection) and
    // resumes it well past a dataset's shortest retention.
    const later = () => clock() + 13 * HOUR_MS;
    const resumed = await syncAll(
      runtime,
      WINDOW,
      context(),
      later,
      first.nextCursor,
    );
    expect(resumed.last.receivedDatasets).toEqual(["servers", "cost_items"]);
    for (const key of ["servers", "cost_items"]) {
      const pages = resumed.datasetPages.filter(
        (page) => page.datasetKey === key,
      );
      expect(pages[0]!.previousPageKey).toBeNull();
      expect(pages.some((page) => oldKeys.has(page.refreshKey))).toBe(false);
      expect(rowsOf(pages, key).length).toBeGreaterThan(0);
    }
  });

  it("re-reads a server's refused hours once its metrics are allowed again", async () => {
    const forbidden = new Set([44]);
    const { runtime } = fake({ forbiddenMetrics: forbidden });
    const first = await syncAll(runtime);
    forbidden.clear();
    const later = () => clock() + 2 * HOUR_MS;
    const second = await syncAll(
      runtime,
      {
        mode: "incremental",
        from: first.last.nextFrom!,
        to: new Date(later()).toISOString(),
      },
      context(),
      later,
      first.last.nextCursor,
    );
    const hours = (resource: string) =>
      second.observations.filter(
        (o) =>
          o.metricKey === METRICS.cpu && o.dimensions.resource === resource,
      );
    // Server 44: the 48 refused hours of the first run and the 2 new ones.
    expect(hours("44")).toHaveLength(50);
    expect(hours("44")[0]!.sourceTimestamp).toBe(WINDOW.from);
    // The other servers only read the new hours.
    expect(hours("42")).toHaveLength(2);
    expect(
      second.last.freshness?.some(
        (entry) => entry.stream === METRICS_STREAM && entry.resource === "44",
      ),
    ).toBe(true);
  });

  it("keeps a refused server's position across runs while it stays refused", async () => {
    const forbidden = new Set([44]);
    const { runtime } = fake({ forbiddenMetrics: forbidden });
    const first = await syncAll(runtime);
    const later = () => clock() + 2 * HOUR_MS;
    const second = await syncAll(
      runtime,
      {
        mode: "incremental",
        from: first.last.nextFrom!,
        to: new Date(later()).toISOString(),
      },
      context(),
      later,
      first.last.nextCursor,
    );
    forbidden.clear();
    const third = await syncAll(
      runtime,
      {
        mode: "incremental",
        from: second.last.nextFrom!,
        to: new Date(later()).toISOString(),
      },
      context(),
      later,
      second.last.nextCursor,
    );
    const hours = third.observations.filter(
      (o) => o.metricKey === METRICS.cpu && o.dimensions.resource === "44",
    );
    expect(hours).toHaveLength(50);
  });
});

describe("pages end before the host's deadline (#893, #901 item 1)", () => {
  /**
   * A clock the fake advances: `stepMs` per answer, every wait, and a
   * stalled request's whole time limit.
   */
  function timed(options: {
    stepMs?: number;
    stallAt?: number;
    limitedAt?: number[];
  }) {
    const api = fake();
    let t = clock();
    let count = 0;
    const runtime: ConnectorRuntime = {
      ...api.runtime,
      fetch: async (url, init) => {
        count += 1;
        if (count === options.stallAt) {
          // Hetzner never answers: the request ends at its time limit.
          t += init?.timeoutMs ?? 60_000;
          throw Object.assign(new Error("egress timeout"), {
            name: "EgressTimeoutError",
          });
        }
        t += options.stepMs ?? 1_000;
        if (options.limitedAt?.includes(count)) {
          // 257 requests an hour: one more in 14 s.
          return {
            status: 429,
            headers: {
              "ratelimit-limit": "257",
              "ratelimit-remaining": "0",
            },
            text: () => "",
            json: () => ({ error: { code: "rate_limit_exceeded" } }),
            bytes: () => new Uint8Array(),
          };
        }
        return api.runtime.fetch(url, init);
      },
    };
    const started = t;
    const hetzner = createHetznerCloudConnector({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    return { runtime, hetzner, elapsed: () => t - started };
  }

  it("a request that stalls late in a page ends in time to return the checkpoint", async () => {
    const { runtime, hetzner, elapsed } = timed({ stallAt: 10 });
    const page = await hetzner.sync(context(), WINDOW, runtime);
    expect(page.done).toBe(false);
    expectHostAccepts(page);
    expect(elapsed()).toBeLessThanOrEqual(45_000);
  });

  it("a rate-limit wait that would pass the deadline ends the page with its reset", async () => {
    // Nine answers take 19.8 s; the tenth step meets two 429s that ask
    // for 14 s each.
    const { runtime, hetzner, elapsed } = timed({
      stepMs: 2_200,
      limitedAt: [10, 11, 12],
    });
    const page = await hetzner.sync(context(), WINDOW, runtime);
    expect(page.done).toBe(false);
    expectHostAccepts(page);
    expect(elapsed()).toBeLessThanOrEqual(45_000);
    const error = await hetzner
      .sync(context(), { ...WINDOW, cursor: page.nextCursor! }, runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
  });

  it("bounds every request below the host's limit", async () => {
    const { runtime, requests } = fake();
    await connector().sync(context(), WINDOW, runtime);
    for (const request of requests) {
      expect(request.init?.timeoutMs).toBeLessThanOrEqual(20_000);
    }
  });
});

describe("client", () => {
  it("sends GET with the token and reads the documented headers", async () => {
    const { runtime, requests } = fake();
    const get = createHetznerClient(runtime, FAKE_TOKEN, { sleep: noSleep });
    await get("/servers", { page: 1, per_page: 50 });
    expect(requests[0]!.init).toMatchObject({ method: "GET" });
    expect(requests[0]!.url).toBe(
      "https://api.hetzner.cloud/v1/servers?page=1&per_page=50",
    );
  });
});
