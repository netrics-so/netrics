import type {
  ConnectionContext,
  ConnectorFetchInit,
  ConnectorLogFields,
  ConnectorResponse,
  ConnectorRuntime,
  DatasetPage,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import {
  ConnectorError,
  configuredHostsOf,
  configuredHostsChanged,
  configuredUrlsFollowSameHostOnly,
  syncResultSchema,
  validateDatasetPage,
} from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  checkId,
  parseExpectedStatus,
  parseHeaders,
  readChecks,
} from "./checks.js";
import {
  CHECKS_STREAM,
  CONCURRENCY,
  DOWN_REASONS,
  HEADERS_INVALID_CODE,
  MAX_BODY_BYTES,
  MAX_CHECKS,
  METRICS,
  MIN_ROUND_GAP_MS,
  NAME_DUPLICATE_CODE,
  NO_CHECKS_CODE,
  RUN_MAX_AGE_MS,
  STATUS_INVALID_CODE,
  TEXT_INVALID_CODE,
  URL_FRAGMENT_CODE,
  URL_INVALID_CODE,
  URL_SECRET_CODE,
  USER_AGENT,
  checksDataset,
  createHttpCheckConnector,
  httpCheckManifest,
  type DownReason,
} from "./index.js";
import { failureReason, receivedStatus } from "./probe.js";

// Offline: a fake runtime.fetch answers per URL the way the host's egress
// guard does (SDK 0.2.21): a response, or an error named and shaped like
// the runtime's (EgressDeniedError with a reason, EgressTimeoutError) or
// undici's (TypeError("fetch failed") with a coded cause). The real guard
// is covered in apps/server/src/http-check-sync.test.ts.

const NOW = Date.parse("2026-11-24T10:00:00.000Z");
const SECRET_BODY = "SECRET-BODY-MARKER do not echo";

function response(status: number, body = ""): ConnectorResponse {
  return {
    status,
    headers: { "content-type": "text/plain" },
    text: () => body,
    json: () => JSON.parse(body) as unknown,
    bytes: () => new TextEncoder().encode(body),
  };
}

function named(name: string, message: string, extra: object = {}): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, extra);
}

function network(code: string): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error(`${code} ${SECRET_BODY}`), { code }),
  });
}

type Answer = (init: ConnectorFetchInit) => ConnectorResponse | Error;

const ANSWERS: Record<string, Answer> = {
  "https://up.example.com/health": () => response(200, "ok all good"),
  "https://status.example.com/": () => response(503, SECRET_BODY),
  "https://text.example.com/": () => response(200, SECRET_BODY),
  "https://slow.example.com/": () =>
    named("EgressTimeoutError", "egress timeout: slow.example.com"),
  "https://nx.example.com/": () => network("ENOTFOUND"),
  "https://tls.example.com/": () => network("ERR_TLS_CERT_ALTNAME_INVALID"),
  "https://refused.example.com/": () => network("ECONNREFUSED"),
  "https://reset.example.com/": () => network("ECONNRESET"),
  "https://big.example.com/": () =>
    named("EgressDeniedError", "egress denied: response exceeds", {
      reason: "size",
    }),
  "https://moved.example.com/": () =>
    named("EgressDeniedError", "egress denied: redirect to another host", {
      reason: "redirect_host",
    }),
  "https://private.example.com/": () =>
    named("EgressDeniedError", "egress denied: resolves to a non-public", {
      reason: "address",
    }),
};

interface Fake {
  runtime: ConnectorRuntime;
  calls: Array<{ url: string; init: ConnectorFetchInit }>;
  logs: Array<{ message: string; fields?: ConnectorLogFields }>;
  inFlight: { now: number; max: number };
}

function fake(answers: Record<string, Answer> = ANSWERS): Fake {
  const calls: Fake["calls"] = [];
  const logs: Fake["logs"] = [];
  const inFlight = { now: 0, max: 0 };
  const controller = new AbortController();
  const runtime: ConnectorRuntime = {
    signal: controller.signal,
    log: {
      debug: (message, fields) => logs.push({ message, fields }),
      info: (message, fields) => logs.push({ message, fields }),
      warn: (message, fields) => logs.push({ message, fields }),
      error: (message, fields) => logs.push({ message, fields }),
    },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight.now -= 1;
      const answer = answers[url] ?? (() => response(200, "default answer"));
      const result = answer(init);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { runtime, calls, logs, inFlight };
}

/** A clock that moves 7 ms per reading: a lone response takes 7 ms. */
function steppingClock(): () => number {
  let at = 0;
  return () => (at += 7);
}

/** Response times of 0 ms, so identical calls give identical results. */
function connector(now = NOW, clock: () => number = () => 0) {
  return createHttpCheckConnector({ now: () => now, clock });
}

const CHECKS = [
  { name: "Site", url: "https://up.example.com/health" },
  {
    name: "Status",
    url: "https://status.example.com/",
    expectedStatus: "200",
  },
  {
    name: "Text",
    url: "https://text.example.com/",
    expectedText: "welcome",
  },
  { name: "Slow", url: "https://slow.example.com/", timeoutSeconds: 2 },
  { name: "Nx", url: "https://nx.example.com/" },
  { name: "Tls", url: "https://tls.example.com/" },
  { name: "Refused", url: "https://refused.example.com/" },
  { name: "Reset", url: "https://reset.example.com/" },
  { name: "Big", url: "https://big.example.com/", expectedText: "x" },
  { name: "Moved", url: "https://moved.example.com/" },
  { name: "Private", url: "https://private.example.com/" },
  { name: "Head", url: "https://up.example.com/health", method: "HEAD" },
];

function context(
  checks: unknown = CHECKS,
  connectionId = "conn-1",
): ConnectionContext {
  return { connectionId, config: { checks }, credentials: {} };
}

function request(cursor?: string): SyncRequest {
  return {
    mode: "incremental",
    from: "2026-11-24T09:59:00.000Z",
    to: "2026-11-24T10:00:00.000Z",
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Both pages of a run. */
async function run(
  ctx: ConnectionContext,
  cursor?: string,
  now = NOW,
  answers?: Record<string, Answer>,
): Promise<{ first: SyncResult; last: SyncResult; fake: Fake }> {
  const f = fake(answers);
  const c = connector(now);
  const first = syncResultSchema.parse(
    await c.sync(ctx, request(cursor), f.runtime),
  );
  const last = syncResultSchema.parse(
    await c.sync(ctx, request(first.nextCursor), f.runtime),
  );
  return { first, last, fake: f };
}

function rows(page: DatasetPage) {
  return Object.fromEntries(
    page.records.map((record) => [
      record.values?.name as string,
      record.values as Record<string, unknown>,
    ]),
  );
}

runConnectorContractTests(connector(), {
  context: context(),
  runtime: fake().runtime,
  cursorOrder: "changing",
});

describe("HTTP check manifest", () => {
  it("reaches only the checks' hosts, on the same host only", () => {
    expect(httpCheckManifest.outboundDomains).toEqual([]);
    expect(httpCheckManifest.configuredHosts).toEqual(["checks[].url"]);
    expect(configuredUrlsFollowSameHostOnly(httpCheckManifest)).toBe(true);
    expect(
      configuredHostsOf(httpCheckManifest, context().config).sort(),
    ).toEqual(
      [
        "up.example.com",
        "status.example.com",
        "text.example.com",
        "slow.example.com",
        "nx.example.com",
        "tls.example.com",
        "refused.example.com",
        "reset.example.com",
        "big.example.com",
        "moved.example.com",
        "private.example.com",
      ].sort(),
    );
  });

  it("carries no credentials, so its checks may name new hosts", () => {
    expect(httpCheckManifest.authStrategies).toEqual([{ strategy: "none" }]);
    expect(
      configuredHostsChanged(
        httpCheckManifest,
        context().config,
        context([{ name: "Other", url: "https://other.example.org/" }]).config,
      ),
    ).toBe(false);
  });

  it("runs once a minute, at most 20 checks, with a continuous stream", () => {
    expect(httpCheckManifest.minRefreshIntervalSeconds).toBe(60);
    expect(MAX_CHECKS).toBe(20);
    const checks = (
      httpCheckManifest.configSchema.properties as Record<
        string,
        { maxItems: number }
      >
    ).checks!;
    expect(checks.maxItems).toBe(MAX_CHECKS);
    expect(httpCheckManifest.freshnessStreams).toEqual([
      expect.objectContaining({
        key: CHECKS_STREAM,
        kind: "continuous",
        datasets: [checksDataset.key],
      }),
    ]);
    expect(
      httpCheckManifest.metrics.map((metric) => [
        metric.key,
        metric.granularity,
      ]),
    ).toEqual([
      [METRICS.up, "instant"],
      [METRICS.responseMs, "instant"],
    ]);
  });
});

describe("configuration", () => {
  it("reads checks with defaults and a stable id per name", () => {
    const [check] = readChecks({
      checks: [{ name: " Site ", url: "https://Up.example.com/health" }],
    });
    expect(check).toEqual({
      id: checkId("site"),
      name: "Site",
      url: "https://up.example.com/health",
      host: "up.example.com",
      method: "GET",
      expectedStatus: "200-399",
      statusRanges: [[200, 399]],
      expectedText: null,
      timeoutMs: 10_000,
      headers: {},
    });
    expect(checkId("Site")).toBe(checkId(" site"));
    expect(checkId("Site")).not.toBe(checkId("Site 2"));
  });

  it("parses expected statuses", () => {
    expect(parseExpectedStatus("200")).toEqual([[200, 200]]);
    expect(parseExpectedStatus("200-299, 301,4xx")).toEqual([
      [200, 299],
      [301, 301],
      [400, 499],
    ]);
    for (const invalid of ["", "20", "600", "299-200", "6xx", "ok", "1,2"]) {
      expect(parseExpectedStatus(invalid), invalid).toBeNull();
    }
  });

  it("parses headers and refuses secrets and reserved names", () => {
    expect(parseHeaders("Accept: text/html\nX-Probe: netrics")).toEqual({
      accept: "text/html",
      "x-probe": "netrics",
    });
    for (const refused of [
      "Authorization: Bearer x",
      "Cookie: a=b",
      "X-Api-Key: k",
      "X-Auth-Token: t",
      "Host: example.com",
      "no colon",
      "Bad Name: x",
      "A: 1\na: 2",
      Array.from({ length: 11 }, (_, i) => `X-${i}: v`).join("\n"),
    ]) {
      expect(parseHeaders(refused), refused).toBeNull();
    }
  });

  it.each([
    [{ checks: [] }, NO_CHECKS_CODE],
    [
      {
        checks: [
          { name: "a", url: "https://a.example.com/health?api_key=k123" },
        ],
      },
      URL_SECRET_CODE,
    ],
    [
      {
        checks: [
          {
            name: "a",
            url: "https://bucket.example.com/f?X-Amz-Signature=abc&X-Amz-Credential=x",
          },
        ],
      },
      URL_SECRET_CODE,
    ],
    [
      { checks: [{ name: "a", url: "https://a.example.com/?token=t" }] },
      URL_SECRET_CODE,
    ],
    [
      { checks: [{ name: "a", url: "https://a.example.com/?sig=s&v=1" }] },
      URL_SECRET_CODE,
    ],
    [
      { checks: [{ name: "a", url: "https://a.example.com/?Password=p" }] },
      URL_SECRET_CODE,
    ],
    // A fragment never reaches the site and may carry a token (#898):
    // refused, never stripped.
    [
      {
        checks: [
          {
            name: "a",
            url: "https://a.example.com/callback#access_token=FRAGMENT-TOKEN",
          },
        ],
      },
      URL_FRAGMENT_CODE,
    ],
    [
      { checks: [{ name: "a", url: "https://a.example.com/health#top" }] },
      URL_FRAGMENT_CODE,
    ],
    [
      { checks: [{ name: "a", url: "https://a.example.com/health#" }] },
      URL_FRAGMENT_CODE,
    ],
    [{}, NO_CHECKS_CODE],
    [
      {
        checks: Array.from({ length: 21 }, (_, i) => ({
          name: `c${i}`,
          url: "https://a.example.com/",
        })),
      },
      NO_CHECKS_CODE,
    ],
    [
      { checks: [{ name: "a", url: "http://a.example.com/" }] },
      URL_INVALID_CODE,
    ],
    [{ checks: [{ name: "a", url: "https://localhost/" }] }, URL_INVALID_CODE],
    [
      { checks: [{ name: "a", url: "https://u:p@a.example.com/" }] },
      URL_INVALID_CODE,
    ],
    [
      {
        checks: [
          { name: "Same", url: "https://a.example.com/" },
          { name: "same ", url: "https://b.example.com/" },
        ],
      },
      NAME_DUPLICATE_CODE,
    ],
    [
      {
        checks: [
          { name: "a", url: "https://a.example.com/", expectedStatus: "abc" },
        ],
      },
      STATUS_INVALID_CODE,
    ],
    [
      {
        checks: [
          {
            name: "a",
            url: "https://a.example.com/",
            method: "HEAD",
            expectedText: "x",
          },
        ],
      },
      TEXT_INVALID_CODE,
    ],
    [
      {
        checks: [
          {
            name: "a",
            url: "https://a.example.com/",
            headers: "Authorization: Bearer secret",
          },
        ],
      },
      HEADERS_INVALID_CODE,
    ],
  ])("refuses %j with its reason code", async (config, code) => {
    const result = await connector().check(
      { connectionId: "c", config, credentials: {} },
      fake().runtime,
    );
    expect(result).toEqual({ ok: false, message: expect.any(String), code });
    expect(result.message).not.toContain("Bearer");
    expect(result.message).not.toContain("FRAGMENT-TOKEN");
    await expect(
      connector().sync(
        { connectionId: "c", config, credentials: {} },
        request(),
        fake().runtime,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ConnectorError && error.code === code,
    );
  });

  it("checks the configuration without requesting anything", async () => {
    const f = fake();
    expect(await connector().check(context(), f.runtime)).toEqual({
      ok: true,
    });
    const resources = await connector().discover(context(), f.runtime);
    expect(resources).toHaveLength(CHECKS.length);
    expect(resources[0]).toEqual({
      id: checkId("Site"),
      name: "Site",
      kind: "check",
      metadata: { host: "up.example.com", method: "GET" },
    });
    expect(f.calls).toEqual([]);
  });
});

describe("a run", () => {
  it("records every reason as data, never failing the sync", async () => {
    const { first, last, fake: f } = await run(context());
    expect(first.done).toBe(false);
    const snapshot = rows(first.datasetPages![0]!);
    const expected: Record<string, [string, DownReason | null, number | null]> =
      {
        Site: ["up", null, 200],
        Status: ["down", "unexpected_status", 503],
        Text: ["down", "text_missing", 200],
        Slow: ["down", "timeout", null],
        Nx: ["down", "dns", null],
        Tls: ["down", "tls", null],
        Refused: ["down", "refused", null],
        Reset: ["down", "connection", null],
        Big: ["down", "too_large", null],
        Moved: ["down", "redirect", null],
        Private: ["down", "egress_refused", null],
        Head: ["up", null, 200],
      };
    for (const [name, [state, reason, status]] of Object.entries(expected)) {
      expect(snapshot[name], name).toMatchObject({
        state,
        reason,
        status_code: status,
        checked_at: "2026-11-24T10:00:00.000Z",
        last_change_at: null,
      });
      expect(snapshot[name]!.response_ms, name).toBe(
        status === null ? null : 0,
      );
    }
    // Every reason, and none of the checked sites' answers.
    expect(new Set(Object.values(snapshot).map((row) => row.reason))).toEqual(
      new Set([null, ...DOWN_REASONS]),
    );
    const everything = JSON.stringify([first, last, f.logs]);
    expect(everything).not.toContain("SECRET-BODY-MARKER");
    expect(f.logs).toEqual([
      { message: "checks requested", fields: { checks: 12, down: 10 } },
    ]);

    // Observations: up for every check, a response time for an answer.
    const up = first.observations.filter((o) => o.metricKey === METRICS.up);
    expect(up).toHaveLength(CHECKS.length);
    expect(up.every((o) => o.sourceTimestamp === "2026-11-24T10:00:00.000Z"));
    expect(
      up.find((o) => o.dimensions.resource === checkId("Site"))?.value,
    ).toBe(1);
    expect(up.find((o) => o.dimensions.resource === checkId("Nx"))?.value).toBe(
      0,
    );
    const times = first.observations.filter(
      (o) => o.metricKey === METRICS.responseMs,
    );
    expect(times.map((o) => o.dimensions.resource).sort()).toEqual(
      [
        checkId("Site"),
        checkId("Status"),
        checkId("Text"),
        checkId("Head"),
      ].sort(),
    );
  });

  it("keeps the status of an answer whose body could not be read (#898)", async () => {
    const answers: Record<string, Answer> = {
      // A 503 whose body is too large, or stalls: down for its status.
      "https://down-big.example.com/": () =>
        named("EgressDeniedError", "egress denied: response exceeds", {
          reason: "size",
          status: 503,
        }),
      "https://down-slow.example.com/": () =>
        named("EgressTimeoutError", "egress timeout: down-slow.example.com", {
          status: 503,
        }),
      // An expected status whose body fails: down for the body, with it.
      "https://big.example.com/": () =>
        named("EgressDeniedError", "egress denied: response exceeds", {
          reason: "size",
          status: 200,
        }),
      "https://slow.example.com/": () =>
        named("EgressTimeoutError", "egress timeout: slow.example.com", {
          status: 200,
        }),
    };
    const checks = ["down-big", "down-slow", "big", "slow"].map((host) => ({
      name: host,
      url: `https://${host}.example.com/`,
      expectedText: "healthy",
    }));
    const { first } = await run(context(checks), undefined, NOW, answers);
    const snapshot = rows(first.datasetPages![0]!);
    const outcome = (name: string) => [
      snapshot[name]?.reason,
      snapshot[name]?.status_code,
      snapshot[name]?.response_ms,
    ];
    expect(outcome("down-big")).toEqual(["unexpected_status", 503, null]);
    expect(outcome("down-slow")).toEqual(["unexpected_status", 503, null]);
    expect(outcome("big")).toEqual(["too_large", 200, null]);
    expect(outcome("slow")).toEqual(["timeout", 200, null]);
    // Only the runtime's egress errors carry a status worth reading.
    expect(receivedStatus(named("TypeError", "x", { status: 503 }))).toBe(null);
    expect(
      receivedStatus(named("EgressTimeoutError", "x", { status: 42 })),
    ).toBe(null);
  });

  it("measures the time until the answer", async () => {
    const result = await connector(NOW, steppingClock()).sync(
      context([{ name: "Site", url: "https://up.example.com/health" }]),
      request(),
      fake().runtime,
    );
    expect(rows(result.datasetPages![0]!).Site!.response_ms).toBe(7);
    expect(
      result.observations.find((o) => o.metricKey === METRICS.responseMs)
        ?.value,
    ).toBe(7);
  });

  it("sends the configured request: method, headers, limits", async () => {
    const f = fake();
    await connector().sync(
      context([
        {
          name: "Get",
          url: "https://up.example.com/health",
          headers: "Accept: application/json",
          timeoutSeconds: 3,
          expectedText: "ok",
        },
        { name: "Head", url: "https://up.example.com/health", method: "HEAD" },
      ]),
      request(),
      f.runtime,
    );
    expect(f.calls).toEqual([
      {
        url: "https://up.example.com/health",
        init: {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": USER_AGENT,
            "cache-control": "no-cache",
          },
          timeoutMs: 3_000,
          maxResponseBytes: MAX_BODY_BYTES,
        },
      },
      {
        url: "https://up.example.com/health",
        init: {
          method: "HEAD",
          headers: { "user-agent": USER_AGENT, "cache-control": "no-cache" },
          timeoutMs: 10_000,
          discardBody: true,
        },
      },
    ]);
  });

  it("completes the snapshot only on a final page that carries nothing else", async () => {
    const { first, last } = await run(context());
    expect(first.datasetPages).toHaveLength(1);
    expect(first.datasetPages![0]!.complete).toBe(false);
    expect(first.receivedDatasets).toBeUndefined();
    expect(first.freshness).toBeUndefined();
    expect(last).toMatchObject({ done: true, observations: [] });
    expect(last.datasetPages).toEqual([
      expect.objectContaining({
        datasetKey: checksDataset.key,
        records: [],
        complete: true,
        refreshKey: first.datasetPages![0]!.refreshKey,
        previousPageKey: first.datasetPages![0]!.pageKey,
      }),
    ]);
    expect(last.receivedDatasets).toEqual([checksDataset.key]);
    for (const page of [...first.datasetPages!, ...last.datasetPages!]) {
      validateDatasetPage(checksDataset, page);
    }
    expectValidFreshness(httpCheckManifest, last);
    expect(last.freshness).toEqual(
      CHECKS.map((check) => ({
        stream: CHECKS_STREAM,
        resource: checkId(check.name),
      })),
    );
  });

  it("runs the maximum of checks, ten at a time", async () => {
    const many = Array.from({ length: MAX_CHECKS }, (_, i) => ({
      name: `Check ${i}`,
      url: `https://host${i}.example.com/`,
    }));
    const { first, last, fake: f } = await run(context(many));
    expect(f.calls).toHaveLength(MAX_CHECKS);
    expect(f.inFlight.max).toBe(CONCURRENCY);
    expect(first.datasetPages![0]!.records).toHaveLength(MAX_CHECKS);
    expect(first.observations).toHaveLength(MAX_CHECKS * 2);
    expect(last.freshness).toHaveLength(MAX_CHECKS);
  });

  it("knows since when a state holds from the previous run", async () => {
    const one = [{ name: "Flip", url: "https://flip.example.com/" }];
    let status = 200;
    const answers = {
      "https://flip.example.com/": () => response(status),
    };
    const a = await run(context(one), undefined, NOW, answers);
    expect(rows(a.first.datasetPages![0]!).Flip!.last_change_at).toBeNull();
    const b = await run(context(one), a.last.nextCursor, NOW + 60_000, answers);
    expect(rows(b.first.datasetPages![0]!).Flip!.last_change_at).toBeNull();
    status = 500;
    const c = await run(
      context(one),
      b.last.nextCursor,
      NOW + 120_000,
      answers,
    );
    expect(rows(c.first.datasetPages![0]!).Flip).toMatchObject({
      state: "down",
      last_change_at: "2026-11-24T10:02:00.000Z",
    });
    const d = await run(
      context(one),
      c.last.nextCursor,
      NOW + 180_000,
      answers,
    );
    expect(rows(d.first.datasetPages![0]!).Flip!.last_change_at).toBe(
      "2026-11-24T10:02:00.000Z",
    );
    // Another URL under the same name starts without a previous state.
    const moved = [{ name: "Flip", url: "https://flip.example.com/v2" }];
    const e = await run(context(moved), d.last.nextCursor, NOW + 240_000);
    expect(rows(e.first.datasetPages![0]!).Flip!.last_change_at).toBeNull();
  });

  it("binds the run cursor to the connection and the check list", async () => {
    const f = fake();
    const first = await connector().sync(context(), request(), f.runtime);
    const callsAfterFirst = f.calls.length;
    // Another connection, or a changed check list: a new run, not a finish.
    for (const other of [
      context(CHECKS, "conn-2"),
      context(CHECKS.slice(0, 2)),
      { ...context(), credentials: { token: "t" } },
    ]) {
      const result = await connector().sync(
        other,
        request(first.nextCursor),
        f.runtime,
      );
      expect(result.done).toBe(false);
      expect(result.datasetPages![0]!.complete).toBe(false);
    }
    expect(f.calls.length).toBeGreaterThan(callsAfterFirst);
    // The cursor holds no secret, URL or answer.
    const decoded = Buffer.from(
      first.nextCursor!.split(":")[1]!,
      "base64url",
    ).toString("utf8");
    expect(decoded).not.toContain("example.com");
    expect(decoded).not.toContain("SECRET");
  });

  it("starts over instead of finishing a run that is too old", async () => {
    const f = fake();
    const first = await connector().sync(context(), request(), f.runtime);
    const late = await connector(NOW + RUN_MAX_AGE_MS + 1).sync(
      context(),
      request(first.nextCursor),
      f.runtime,
    );
    expect(late.done).toBe(false);
    expect(late.freshness).toBeUndefined();
    expect(late.datasetPages![0]!.records).toHaveLength(CHECKS.length);
    // In time, the same cursor finishes the run.
    const finished = await connector(NOW + RUN_MAX_AGE_MS).sync(
      context(),
      request(first.nextCursor),
      f.runtime,
    );
    expect(finished.done).toBe(true);
  });

  it("keeps ordinary query parameters", () => {
    expect(
      readChecks({
        checks: [
          { name: "a", url: "https://a.example.com/health?full=1&region=eu" },
        ],
      })[0]!.url,
    ).toBe("https://a.example.com/health?full=1&region=eu");
  });

  it("starts no new round within the interval floor, even when asked (#874 review)", async () => {
    const { last } = await run(context());
    for (const later of [1_000, 30_000, MIN_ROUND_GAP_MS - 1]) {
      const f = fake();
      const result = await connector(NOW + later).sync(
        context(),
        request(last.nextCursor),
        f.runtime,
      );
      expect(f.calls, String(later)).toEqual([]);
      // Marked as skipped (SDK 0.2.23, #898): the host keeps the next
      // due time instead of moving it a whole interval on.
      expect(syncResultSchema.parse(result)).toEqual({
        observations: [],
        datasetPages: [],
        nextCursor: last.nextCursor,
        skipped: true,
        done: true,
      });
    }
    // At the floor a new round starts, and its run finishes as usual.
    const f = fake();
    const next = await connector(NOW + MIN_ROUND_GAP_MS).sync(
      context(),
      request(last.nextCursor),
      f.runtime,
    );
    expect(f.calls).toHaveLength(CHECKS.length);
    expect(next.done).toBe(false);
    // A changed list waits for the floor too: an edit is no way around it.
    const g = fake();
    await connector(NOW + 1_000).sync(
      context(CHECKS.slice(0, 1)),
      request(last.nextCursor),
      g.runtime,
    );
    expect(g.calls).toEqual([]);
  });

  it("ignores cursors it cannot read", async () => {
    for (const cursor of [
      "garbage",
      "http-check.run1:!!!",
      "http-check.done1:e30",
    ]) {
      const result = await connector().sync(
        context(),
        request(cursor),
        fake().runtime,
      );
      expect(result.done).toBe(false);
    }
  });

  it("fails the sync when the host ends the call", async () => {
    const controller = new AbortController();
    const runtime: ConnectorRuntime = {
      signal: controller.signal,
      fetch: async () => {
        controller.abort();
        throw named("AbortError", "This operation was aborted");
      },
    };
    await expect(
      connector().sync(context(), request(), runtime),
    ).rejects.toThrow(/aborted/);
  });
});

describe("failureReason", () => {
  it("reads names, reasons and codes, never message text", () => {
    expect(failureReason(network("EAI_AGAIN"))).toBe("dns");
    expect(failureReason(network("UND_ERR_CONNECT_TIMEOUT"))).toBe("timeout");
    expect(failureReason(network("CERT_HAS_EXPIRED"))).toBe("tls");
    expect(failureReason(network("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe("tls");
    expect(failureReason(network("EHOSTUNREACH"))).toBe("connection");
    expect(
      failureReason(named("EgressDeniedError", "x", { reason: "redirects" })),
    ).toBe("redirect");
    expect(
      failureReason(named("EgressDeniedError", "x", { reason: "host" })),
    ).toBe("egress_refused");
    expect(failureReason(new Error("ENOTFOUND in the text only"))).toBe(
      "connection",
    );
    expect(failureReason("not an error")).toBe("connection");
  });
});
