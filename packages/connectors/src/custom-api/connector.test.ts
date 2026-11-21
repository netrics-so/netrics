import {
  RateLimitedError,
  syncResultSchema,
  validateDatasetPage,
  type ConnectionContext,
  type Connector,
  type DatasetPage,
  type SyncRequest,
} from "@netrics/connector-sdk";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import {
  recordingLogger,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import { afterAll, describe, expect, it } from "vitest";

import {
  CUSTOM_API_LIMIT_ERROR,
  CUSTOM_API_MESSAGES,
  createCustomApiConnector,
  decodeCursor,
  type CustomApiCredentials,
} from "./index.js";
import { pinFor } from "./test-helpers.js";
import {
  FIXTURE_SECRETS,
  fixtureDefinition,
  fixtureRuntime,
  startCustomApiFixtureServer,
  type FixtureDefinitionName,
} from "./testing/index.js";

const fixture = await startCustomApiFixtureServer();
afterAll(() => fixture.close());
const host = `127.0.0.1:${fixture.port}`;
const NOW = Date.parse("2024-06-01T12:00:00Z");
const runtime = fixtureRuntime(["127.0.0.1"]);

function connector(definition: CustomApiDefinition, now = () => NOW) {
  return createCustomApiConnector({ definition, pin: pinFor(definition), now });
}
function def(name: FixtureDefinitionName) {
  return fixtureDefinition(name, fixture.origin);
}
function ctx(
  credentials: Partial<Record<string, string>> = {},
): ConnectionContext {
  return {
    connectionId: "c1",
    config: {},
    credentials: { host, ...credentials } as CustomApiCredentials,
  };
}
const BACKFILL: SyncRequest = {
  mode: "backfill",
  from: "2024-01-01T00:00:00.000Z",
  to: "2024-03-15T12:00:00.000Z",
};

/** Runs sync calls until done; validates every result and dataset page. */
async function syncAll(
  target: Connector,
  request: SyncRequest = BACKFILL,
  context: ConnectionContext = ctx(),
  log = recordingLogger(),
) {
  const pages: DatasetPage[] = [];
  let cursor: string | undefined;
  for (let calls = 1; ; calls++) {
    const result = syncResultSchema.parse(
      await target.sync(
        context,
        { ...request, ...(cursor ? { cursor } : {}) },
        { ...runtime, log },
      ),
    );
    for (const page of result.datasetPages ?? []) {
      const dataset = target.manifest.datasets!.find(
        (d) => d.key === page.datasetKey,
      )!;
      validateDatasetPage(dataset, page);
      pages.push(page);
    }
    if (result.done) return { pages, result, calls, log };
    expect(result.nextCursor).not.toBe(cursor);
    cursor = result.nextCursor;
  }
}

runConnectorContractTests(connector(def("pages")), {
  name: "custom-api (page numbers)",
  context: ctx(),
  runtime,
  cursorOrder: "changing",
});

describe("custom-api connector", () => {
  it.each<FixtureDefinitionName>([
    "pages",
    "offset",
    "cursor",
    "next_body",
    "next_link",
  ])("syncs %s into one complete refresh per stream", async (name) => {
    const { pages, result } = await syncAll(connector(def(name)));
    const refreshKeys = new Set(pages.map((page) => page.refreshKey));
    expect(refreshKeys.size).toBe(1);
    expect(pages.at(-1)!.complete).toBe(true);
    expect(pages.filter((page) => page.complete)).toHaveLength(1);
    expect(pages.map((page) => page.pageKey)).toEqual(
      pages.map((_, index) => `p${index}`),
    );
    expect(pages[1]!.previousPageKey).toBe("p0");
    const ids = pages.flatMap((page) =>
      page.records.map((record) => record.values.id),
    );
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(pages[0]!.records[1]!.values).toEqual({
      id: 2,
      name: "Item 2",
      created: "2024-01-01T02:00:00.000Z",
      price: "2.50",
    });
    expect(result.receivedDatasets).toEqual(["items"]);
  });

  it("reads a single object as one record", async () => {
    const { pages } = await syncAll(connector(def("stats")));
    expect(pages).toHaveLength(1);
    expect(pages[0]!.records).toEqual([
      { values: { as_of: "2024-01-01", visitors: 1234 } },
    ]);
  });

  it("reads daily windows in steps and returns nextFrom on incremental runs", async () => {
    const daily = connector(def("daily"));
    const { pages } = await syncAll(daily);
    // Backfill 2024-01-01 .. 2024-03-15 → three chunks of 31, 31, 13 days.
    expect(new Set(pages.map((page) => page.refreshKey)).size).toBe(3);
    const days = pages.flatMap((page) =>
      page.records.map((record) => record.values.day),
    );
    expect(days[0]).toBe("2024-01-01");
    expect(days.at(-1)).toBe("2024-03-15");
    expect(days).toHaveLength(75);
    expect(pages[0]!.records[0]!.values).toEqual({
      day: "2024-01-01",
      orders: 1,
      revenue: "1.50",
      currency: "EUR",
    });
    const { result } = await syncAll(daily, {
      mode: "incremental",
      from: "2024-03-10T00:00:00.000Z",
      to: "2024-03-15T12:00:00.000Z",
    });
    expect(result.nextFrom).toBe("2024-03-12T00:00:00.000Z");
  });

  it("reads unix-second dates", async () => {
    const { pages } = await syncAll(connector(def("daily_unix")), {
      mode: "incremental",
      from: "2024-03-10T00:00:00.000Z",
      to: "2024-03-12T12:00:00.000Z",
    });
    expect(
      pages.flatMap((page) => page.records.map((r) => r.values.day)),
    ).toEqual(["2024-03-10", "2024-03-11", "2024-03-12"]);
  });

  it("emits replace_window pages with the chunk window and drops records outside it", async () => {
    const base = def("daily_replace");
    const stream = base.streams[0]!;
    const definition: CustomApiDefinition = {
      ...base,
      // No upper bound: the API answers every day from the start on.
      streams: [
        {
          ...stream,
          request: { ...stream.request, query: { from: "{{window.start}}" } },
        },
      ],
    };
    const { pages } = await syncAll(connector(definition));
    expect(pages.map((page) => page.window)).toEqual([
      { from: "2024-01-01", toExclusive: "2024-02-01", partition: {} },
      { from: "2024-02-01", toExclusive: "2024-03-03", partition: {} },
      { from: "2024-03-03", toExclusive: "2024-03-16", partition: {} },
    ]);
    expect(pages.map((page) => page.records.length)).toEqual([31, 31, 13]);
    expect(pages.every((page) => page.complete)).toBe(true);
  });

  it.each<[FixtureDefinitionName, Record<string, string>]>([
    ["api_key_header", { apiKey: FIXTURE_SECRETS.apiKey }],
    ["api_key_query", { apiKey: FIXTURE_SECRETS.apiKey }],
    ["bearer", { token: FIXTURE_SECRETS.token }],
    ["bearer_custom", { token: FIXTURE_SECRETS.token }],
    [
      "basic",
      {
        username: FIXTURE_SECRETS.username,
        password: FIXTURE_SECRETS.password,
      },
    ],
  ])("checks and syncs with %s", async (name, credentials) => {
    const target = connector(def(name));
    expect(await target.check(ctx(credentials), runtime)).toEqual({ ok: true });
    const { pages } = await syncAll(target, BACKFILL, ctx(credentials));
    expect(pages[0]!.records).toHaveLength(3);
  });

  it("checks 401 and 403 as actionable refusals", async () => {
    const target = connector(def("api_key_header"));
    expect(await target.check(ctx({ apiKey: "wrong" }), runtime)).toEqual({
      ok: false,
      message: CUSTOM_API_MESSAGES.unauthorized,
    });
    expect(
      await target.check(ctx({ apiKey: "forbidden-key" }), runtime),
    ).toEqual({ ok: false, message: CUSTOM_API_MESSAGES.forbidden });
    const error = await syncAll(
      target,
      BACKFILL,
      ctx({ apiKey: "wrong" }),
    ).catch((e: Error) => e);
    expect(error).toMatchObject({
      name: "CustomApiAuthError",
      message: CUSTOM_API_MESSAGES.unauthorized,
    });
  });

  it("refuses credentials entered for another host", async () => {
    const target = connector(def("bearer"));
    fixture.reset();
    expect(
      await target.check(
        { ...ctx(), credentials: { host: "api.example.com", token: "t0k3n" } },
        runtime,
      ),
    ).toEqual({ ok: false, message: CUSTOM_API_MESSAGES.hostChanged });
    expect(fixture.requests).toHaveLength(0);
  });

  it("checks a response that is not JSON", async () => {
    expect(await connector(def("not_json")).check(ctx(), runtime)).toEqual({
      ok: false,
      message: CUSTOM_API_MESSAGES.notJson,
    });
    await expect(syncAll(connector(def("deep")))).rejects.toThrow(
      CUSTOM_API_MESSAGES.notJson,
    );
  });

  it("ends the run with a limit error after 200 pages, keeping earlier pages", async () => {
    fixture.reset();
    const target = connector(def("endless"));
    const pages: DatasetPage[] = [];
    let cursor: string | undefined;
    let error: Error | undefined;
    for (let call = 0; call < 250 && !error; call++) {
      try {
        const result = await target.sync(
          ctx(),
          { ...BACKFILL, ...(cursor ? { cursor } : {}) },
          runtime,
        );
        pages.push(...(result.datasetPages ?? []));
        cursor = result.nextCursor;
      } catch (caught) {
        error = caught as Error;
      }
    }
    expect(error?.name).toBe(CUSTOM_API_LIMIT_ERROR);
    expect(error?.message).toBe(CUSTOM_API_MESSAGES.pageLimit);
    expect(fixture.requests).toHaveLength(200);
    expect(pages).toHaveLength(200);
    expect(pages.some((page) => page.complete)).toBe(false);
    // A later run (another window) starts the stream again.
    const later = await target.sync(
      ctx(),
      { ...BACKFILL, to: "2024-03-16T12:00:00.000Z", cursor },
      runtime,
    );
    expect(later.datasetPages![0]!.pageKey).toBe("p0");
    expect(decodeCursor(later.nextCursor)!.run.pages).toBe(1);
  });

  it("ends the run after 30 minutes", async () => {
    let now = NOW;
    const target = connector(def("pages"), () => now);
    const first = await target.sync(ctx(), BACKFILL, runtime);
    now += 30 * 60 * 1000;
    await expect(
      target.sync(ctx(), { ...BACKFILL, cursor: first.nextCursor }, runtime),
    ).rejects.toMatchObject({
      name: CUSTOM_API_LIMIT_ERROR,
      message: CUSTOM_API_MESSAGES.durationLimit,
    });
  });

  it("never puts the api key into an error", async () => {
    const error = (await syncAll(
      connector(def("api_key_query_400")),
      BACKFILL,
      ctx({ apiKey: FIXTURE_SECRETS.apiKey }),
    ).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain(FIXTURE_SECRETS.apiKey);
    expect(error.message).toBe(
      `HTTP 400 from ${fixture.origin}/auth/api-key-query?bad=1&api_key=[redacted] (stream items)`,
    );
  });

  it("throws RateLimitedError with the Retry-After time", async () => {
    const error = await syncAll(connector(def("rate_limited"))).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      new Date(NOW + 120_000).toISOString(),
    );
  });

  it("logs skipped records and nulled values by count only", async () => {
    const { pages, log } = await syncAll(connector(def("bad_values")));
    expect(pages[0]!.records).toHaveLength(3);
    expect(log.entries).toEqual([
      {
        level: "warn",
        message: "records skipped",
        fields: { stream: "values", skipped: 1, "nulled.orders": 2 },
      },
    ]);
  });

  it("does not follow a redirect itself", async () => {
    await expect(syncAll(connector(def("redirect_off_host")))).rejects.toThrow(
      /^HTTP 302 from /,
    );
  });

  it("refuses a next page link on another host", async () => {
    fixture.reset();
    await expect(syncAll(connector(def("next_off_host")))).rejects.toThrow(
      CUSTOM_API_MESSAGES.nextUrlOffHost,
    );
    expect(fixture.requests.map((request) => request.host)).toEqual([host]);
  });

  it("keeps no API key in a stored next link and sends it again", async () => {
    fixture.reset();
    const target = connector(def("api_key_query_echo"));
    const context = ctx({ apiKey: FIXTURE_SECRETS.apiKey });
    const first = await target.sync(context, BACKFILL, runtime);
    expect(first.nextCursor).toBeDefined();
    const raw = Buffer.from(
      first.nextCursor!.slice("cav1.".length),
      "base64url",
    ).toString("utf8");
    expect(raw).not.toContain(FIXTURE_SECRETS.apiKey);
    expect(decodeCursor(first.nextCursor)!.page).toEqual({
      type: "next_url",
      url: `${fixture.origin}/auth/api-key-query-echo?after=10`,
    });
    const error = (await target
      .sync(context, { ...BACKFILL, cursor: first.nextCursor }, runtime)
      .catch((e: unknown) => e)) as Error;
    expect(fixture.requests[1]!.query).toEqual({
      after: "10",
      api_key: FIXTURE_SECRETS.apiKey,
    });
    expect(error.message).not.toContain(FIXTURE_SECRETS.apiKey);
  });

  it("ends on a next link to the same page, with the key placed first", async () => {
    fixture.reset();
    const { result } = await syncAll(
      connector(def("api_key_self_link")),
      BACKFILL,
      ctx({ apiKey: FIXTURE_SECRETS.apiKey }),
    );
    // Page 1, then page 2 links to itself: two requests, not the page cap.
    expect(fixture.requests.map((request) => request.query.after)).toEqual([
      undefined,
      "10",
    ]);
    expect(result.done).toBe(true);
  });

  it("ends on a next link to the same page with its parameters reordered", async () => {
    fixture.reset();
    const { result } = await syncAll(connector(def("next_reorder")));
    expect(fixture.requests.map((request) => request.query)).toEqual([
      {},
      { x: "1", y: "2" },
    ]);
    expect(result.done).toBe(true);
  });

  it("ends on a next link back to a page read before (a cycle)", async () => {
    fixture.reset();
    const { result } = await syncAll(connector(def("next_cycle")));
    expect(fixture.requests.map((request) => request.query.p)).toEqual([
      undefined,
      "a",
      "b",
    ]);
    expect(result.done).toBe(true);
  });

  it("starts every stream again when a later run gets another window", async () => {
    const pages = def("pages");
    const endless = def("endless");
    const twoStreams: CustomApiDefinition = {
      ...pages,
      streams: [pages.streams[0]!, { ...endless.streams[0]!, key: "endless" }],
    };
    const target = connector(twoStreams);
    // Run 1: the first stream completes, the second hits the page limit.
    let cursor: string | undefined;
    let error: Error | undefined;
    const received: string[] = [];
    for (let call = 0; call < 260 && !error; call++) {
      try {
        const result = await target.sync(
          ctx(),
          { ...BACKFILL, ...(cursor ? { cursor } : {}) },
          runtime,
        );
        received.push(...(result.datasetPages ?? []).map((p) => p.datasetKey));
        expect(result.done).toBe(false);
        cursor = result.nextCursor;
      } catch (caught) {
        error = caught as Error;
      }
    }
    expect(error?.name).toBe(CUSTOM_API_LIMIT_ERROR);
    expect(decodeCursor(cursor)!.stream).toBe(1);
    // Run 2, a later window, with run 1's last cursor: stream A first.
    fixture.reset();
    const later = { ...BACKFILL, to: "2024-03-16T12:00:00.000Z", cursor };
    const result = await target.sync(ctx(), later, runtime);
    expect(fixture.requests[0]!.path).toBe("/items/pages");
    expect(result.datasetPages![0]!.datasetKey).toBe("items");
    expect(result.done).toBe(false);
    expect(decodeCursor(result.nextCursor)).toMatchObject({
      stream: 0,
      run: { pages: 1 },
    });
  });
});
