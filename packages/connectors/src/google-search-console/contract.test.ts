import { readFileSync } from "node:fs";

import type {
  ConnectionContext,
  ConnectorResponse,
  ConnectorRuntime,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { runConnectorContractTests } from "@netrics/connector-sdk/testing";
import { describe, expect, it } from "vitest";

import {
  DATA_STATE,
  INCREMENTAL_LOOKBACK_DAYS,
  MAX_ROWS_PER_DAY,
  PAGE_ROWS,
  WEBMASTERS_READONLY_SCOPE,
  createSearchConsoleConnector,
  oldestAvailableDay,
  parseConfig,
  searchConsoleManifest,
} from "./index.js";
import {
  FAKE_TOKEN,
  createFakeSearchConsole,
  type FakeSearchConsoleOptions,
} from "./test-helpers.js";

const TODAY = "2024-01-20";
const SITE = "https://www.example.com/";
const DAY_MS = 24 * 60 * 60 * 1000;
const noSleep = async () => {};
const clock = () => Date.parse(`${TODAY}T12:00:00.000Z`);
const PREFIX = "google-search-console";

function connector(now: () => number = clock) {
  return createSearchConsoleConnector({ now, sleep: noSleep });
}

function context(
  config: Record<string, unknown> = { siteUrl: SITE },
  credentials: Record<string, unknown> = { accessToken: FAKE_TOKEN },
): ConnectionContext {
  return { connectionId: "gsc-test", config, credentials };
}

function fake(options: FakeSearchConsoleOptions = {}) {
  return createFakeSearchConsole({ today: TODAY, ...options });
}

/** Runs every page of one sync the way the engine does. */
async function syncAll(
  runtime: ConnectorRuntime,
  request: SyncRequest,
  ctx = context(),
  now: () => number = clock,
): Promise<{ pages: SyncResult[]; observations: Observation[] }> {
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await connector(now).sync(
      ctx,
      { ...request, ...(cursor ? { cursor } : {}) },
      runtime,
    );
    pages.push(page);
    if (page.done) break;
    cursor = page.nextCursor;
  }
  return { pages, observations: pages.flatMap((page) => page.observations) };
}

const of = (observations: Observation[], metric: string) =>
  observations.filter((o) => o.metricKey === `${PREFIX}.${metric}`);

runConnectorContractTests(connector(), {
  context: context({ siteUrl: SITE, dimensions: "query,device" }),
  runtime: fake().runtime,
});

// ─── Recorded API responses (sanitized) ─────────────────────────────────────

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

function reply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers,
    text: () => text,
    json: () => JSON.parse(text) as unknown,
  };
}

/** Answers each request with the recorded response for its shape. */
function recordedRuntime(
  override?: (
    url: URL,
    body: Record<string, unknown>,
  ) => ConnectorResponse | undefined,
): ConnectorRuntime {
  return {
    signal: new AbortController().signal,
    fetch: async (raw, init) => {
      const url = new URL(raw);
      const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      const answer = override?.(url, body);
      if (answer) return answer;
      if (url.pathname === "/webmasters/v3/sites") {
        return reply(200, fixture("sites"));
      }
      const dimensions = ((body.dimensions as string[] | undefined) ?? []).join(
        ",",
      );
      const name = {
        "": "analytics-empty",
        date: "analytics-by-date",
        "query,device": "analytics-by-query-device",
      }[dimensions];
      if (!name) throw new Error(`no recorded response for ${raw}`);
      return reply(200, fixture(name));
    },
  };
}

describe("search console connector against recorded responses", () => {
  const recordedNow = () => Date.parse("2026-09-25T12:00:00.000Z");
  const request: SyncRequest = {
    mode: "backfill",
    from: "2026-09-14T00:00:00.000Z",
    to: "2026-09-21T00:00:00.000Z",
  };

  it("discovers verified properties, domain properties included", async () => {
    const resources = await connector().discover(context(), recordedRuntime());
    expect(resources).toEqual([
      {
        id: "https://shop.example.com/",
        name: "https://shop.example.com/",
        kind: "url_prefix_property",
        metadata: {
          siteUrl: "https://shop.example.com/",
          permissionLevel: "siteRestrictedUser",
        },
      },
      {
        id: "https://www.example.com/",
        name: "https://www.example.com/",
        kind: "url_prefix_property",
        metadata: {
          siteUrl: "https://www.example.com/",
          permissionLevel: "siteFullUser",
        },
      },
      {
        id: "sc-domain:example.com",
        name: "example.com",
        kind: "domain_property",
        metadata: {
          siteUrl: "sc-domain:example.com",
          permissionLevel: "siteOwner",
        },
      },
    ]);
  });

  it("maps daily totals and a breakdown to observations", async () => {
    const result = await connector(recordedNow).sync(
      context({ siteUrl: SITE, dimensions: "query,device" }),
      request,
      recordedRuntime(),
    );
    const resource = SITE;
    expect(result.observations).toContainEqual({
      metricKey: `${PREFIX}.clicks`,
      sourceTimestamp: "2026-09-15T00:00:00.000Z",
      value: 455,
      dimensions: { resource },
    });
    expect(result.observations).toContainEqual({
      metricKey: `${PREFIX}.impressions`,
      sourceTimestamp: "2026-09-15T00:00:00.000Z",
      value: 16620,
      dimensions: { resource },
    });
    expect(result.observations).toContainEqual({
      metricKey: `${PREFIX}.position`,
      sourceTimestamp: "2026-09-15T00:00:00.000Z",
      value: 8.21005,
      dimensions: { resource },
    });
    const ctr = of(result.observations, "ctr").find(
      (o) => o.sourceTimestamp === "2026-09-15T00:00:00.000Z",
    );
    expect(ctr?.value).toBeCloseTo(455 / 16620, 12);
    const positionSum = of(result.observations, "position_sum").find(
      (o) => o.sourceTimestamp === "2026-09-15T00:00:00.000Z",
    );
    expect(positionSum?.value).toBeCloseTo(8.21005 * 16620, 6);
    expect(of(result.observations, "clicks")).toHaveLength(7);

    expect(result.observations).toContainEqual({
      metricKey: `${PREFIX}.breakdown_clicks`,
      sourceTimestamp: "2026-09-14T00:00:00.000Z",
      value: 96,
      dimensions: { resource, query: "example", device: "MOBILE" },
    });
    expect(result.observations).toContainEqual({
      metricKey: `${PREFIX}.breakdown_impressions`,
      sourceTimestamp: "2026-09-20T00:00:00.000Z",
      value: 12,
      dimensions: { resource, query: "example api docs", device: "TABLET" },
    });
    // 5 recorded rows × 3 metrics × 7 days.
    expect(
      result.observations.filter((o) => o.metricKey.includes(".breakdown_")),
    ).toHaveLength(5 * 3 * 7);
    for (const observation of result.observations) {
      expect(observation.sourceTimestamp).toMatch(/T00:00:00\.000Z$/);
    }
  });

  it("reads an empty answer (no final data yet) as no observations", async () => {
    const result = await connector(recordedNow).sync(
      context({ siteUrl: SITE, dimensions: "query,device" }),
      request,
      recordedRuntime((url) =>
        url.pathname.endsWith("/query")
          ? reply(200, fixture("analytics-empty"))
          : undefined,
      ),
    );
    expect(result.observations).toEqual([]);
    expect(result.done).toBe(true);
  });

  it("fails clearly when Google changes a response shape", async () => {
    await expect(
      connector(recordedNow).sync(
        context(),
        request,
        recordedRuntime((url) =>
          url.pathname.endsWith("/query")
            ? reply(200, { rows: [{ keys: ["2026-09-14"], clickCount: 3 }] })
            : undefined,
        ),
      ),
    ).rejects.toThrow(/clicks/);
  });

  it("reports a property the account lost access to as a failed check", async () => {
    const denied = fixture("error-permission-denied");
    const result = await connector(recordedNow).check(
      context(),
      recordedRuntime((url) =>
        url.pathname.endsWith("/query") ? reply(403, denied) : undefined,
      ),
    );
    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(
        /refused access to https:\/\/www\.example\.com\//,
      ),
    });
  });

  it("reports a grant without the Search Console scope as a failed check", async () => {
    const scope = fixture("error-insufficient-scope");
    const result = await connector(recordedNow).check(context(), {
      signal: new AbortController().signal,
      fetch: async () => reply(403, scope),
    });
    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/Reconnect Google/),
    });
  });

  it("throws on a rejected access token so the host refreshes it", async () => {
    const unauthenticated = fixture("error-unauthenticated");
    const error: unknown = await connector(recordedNow)
      .check(context(), {
        signal: new AbortController().signal,
        fetch: async () => reply(401, unauthenticated),
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AccessTokenRejectedError");
    expect((error as Error).message).toMatch(/401/);
  });

  it("waits out the recorded quota answers and gives up on the daily quota", async () => {
    const waits: number[] = [];
    let calls = 0;
    const answers = [
      reply(429, fixture("error-load-quota")),
      reply(403, fixture("error-user-rate-limit")),
    ];
    const discovered = await createSearchConsoleConnector({
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).discover(
      context(),
      recordedRuntime(() => {
        calls += 1;
        return answers.shift();
      }),
    );
    expect(discovered).toHaveLength(3);
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 2000]);

    let daily = 0;
    await expect(
      connector().discover(
        context(),
        recordedRuntime(() => {
          daily += 1;
          return reply(403, fixture("error-daily-quota"));
        }),
      ),
    ).rejects.toThrow(/quota is used up.*dailyLimitExceeded/);
    expect(daily).toBe(1);
  });

  it("surfaces a rejected query with Google's reason", async () => {
    await expect(
      connector(recordedNow).sync(
        context(),
        request,
        recordedRuntime((url) =>
          url.pathname.endsWith("/query")
            ? reply(400, fixture("error-bad-dimension"))
            : undefined,
        ),
      ),
    ).rejects.toThrow(/400 INVALID_ARGUMENT/);
  });
});

// ─── Behaviour against the fake API ─────────────────────────────────────────

describe("search console connector", () => {
  it("asks only for the read-only Search Console scope", () => {
    expect(searchConsoleManifest.authStrategies).toEqual([
      {
        strategy: "oauth2",
        provider: "google",
        scopes: [WEBMASTERS_READONLY_SCOPE],
      },
    ]);
    expect(WEBMASTERS_READONLY_SCOPE).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly",
    );
  });

  it("only reaches searchconsole.googleapis.com, with the token in a header", async () => {
    expect(searchConsoleManifest.outboundDomains).toEqual([
      "searchconsole.googleapis.com",
    ]);
    const api = fake();
    const ctx = context({
      siteUrl: "sc-domain:example.org",
      dimensions: "page",
    });
    await connector().check(ctx, api.runtime);
    await connector().discover(ctx, api.runtime);
    await syncAll(
      api.runtime,
      {
        mode: "backfill",
        from: "2023-12-01T00:00:00.000Z",
        to: "2024-01-20T12:00:00.000Z",
      },
      ctx,
    );
    expect(api.requests.length).toBeGreaterThan(0);
    for (const { url, init } of api.requests) {
      expect(url.hostname).toBe("searchconsole.googleapis.com");
      expect(url.toString()).not.toContain(FAKE_TOKEN);
      expect(init?.headers?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    }
    // Domain properties are addressed by their encoded sc-domain: id.
    expect(
      api.requests.some(({ url }) =>
        url.pathname.includes("/sites/sc-domain%3Aexample.org/"),
      ),
    ).toBe(true);
  });

  it("reads final data only, from web search", async () => {
    const api = fake();
    await syncAll(
      api.runtime,
      {
        mode: "incremental",
        from: "2024-01-10T00:00:00.000Z",
        to: "2024-01-20T12:00:00.000Z",
      },
      context({ siteUrl: SITE, dimensions: "country" }),
    );
    expect(api.queries.length).toBeGreaterThan(0);
    for (const query of api.queries) {
      expect(query.dataState).toBe(DATA_STATE);
      expect(DATA_STATE).toBe("final");
      expect(query.type).toBe("web");
    }
  });

  it("pages by week and resumes incremental syncs a few days back", async () => {
    const { pages, observations } = await syncAll(fake().runtime, {
      mode: "backfill",
      from: "2023-12-20T08:00:00.000Z",
      to: "2024-01-20T12:00:00.000Z",
    });
    expect(pages.map((page) => [page.nextCursor, page.done])).toEqual([
      ["2023-12-25T00:00:00.000Z", false],
      ["2024-01-01T00:00:00.000Z", false],
      ["2024-01-08T00:00:00.000Z", false],
      ["2024-01-15T00:00:00.000Z", false],
      // 20 January − INCREMENTAL_LOOKBACK_DAYS
      ["2024-01-15T00:00:00.000Z", true],
    ]);
    expect(INCREMENTAL_LOOKBACK_DAYS).toBe(5);
    const days = of(observations, "clicks").map((o) => o.sourceTimestamp);
    // 20 December … 17 January: final data trails today by three days.
    expect(days).toHaveLength(29);
    expect(days[0]).toBe("2023-12-20T00:00:00.000Z");
    expect(days.at(-1)).toBe("2024-01-17T00:00:00.000Z");
  });

  it("picks up days once Google finalizes them, keeping earlier values", async () => {
    const first = await syncAll(fake().runtime, {
      mode: "incremental",
      from: "2024-01-10T00:00:00.000Z",
      to: "2024-01-20T12:00:00.000Z",
    });
    const cursor = first.pages.at(-1)!.nextCursor!;
    expect(cursor).toBe("2024-01-15T00:00:00.000Z");
    // Two days later: the engine starts the next incremental sync at the cursor.
    const later = "2024-01-22";
    const laterClock = () => Date.parse(`${later}T12:00:00.000Z`);
    const second = await syncAll(
      fake({ today: later }).runtime,
      { mode: "incremental", from: cursor, to: `${later}T12:00:00.000Z` },
      context(),
      laterClock,
    );
    const firstDays = of(first.observations, "clicks").map(
      (o) => o.sourceTimestamp,
    );
    const secondDays = of(second.observations, "clicks").map(
      (o) => o.sourceTimestamp,
    );
    expect(firstDays.at(-1)).toBe("2024-01-17T00:00:00.000Z");
    expect(secondDays).toEqual([
      "2024-01-15T00:00:00.000Z",
      "2024-01-16T00:00:00.000Z",
      "2024-01-17T00:00:00.000Z",
      "2024-01-18T00:00:00.000Z",
      "2024-01-19T00:00:00.000Z",
    ]);
    for (const observation of second.observations) {
      const earlier = first.observations.find(
        (o) =>
          o.metricKey === observation.metricKey &&
          o.sourceTimestamp === observation.sourceTimestamp,
      );
      if (earlier) expect(observation.value).toBe(earlier.value);
    }
  });

  it("never asks for data older than 16 months", async () => {
    const api = fake();
    const now = clock();
    // The engine's backfill window (backfillDays), and a far older one.
    for (const days of [searchConsoleManifest.backfillDays!, 900]) {
      const { pages, observations } = await syncAll(api.runtime, {
        mode: "backfill",
        from: new Date(now - days * DAY_MS).toISOString(),
        to: new Date(now).toISOString(),
      });
      expect(pages.length).toBeLessThanOrEqual(100);
      const days0 = of(observations, "clicks").map((o) => o.sourceTimestamp);
      expect(days0[0]).toBe("2022-09-20T00:00:00.000Z");
    }
    const oldest = new Date(
      oldestAvailableDay(Date.parse(`${TODAY}T00:00:00.000Z`)),
    )
      .toISOString()
      .slice(0, 10);
    expect(oldest).toBe("2022-09-20");
    expect(api.queries.length).toBeGreaterThan(0);
    for (const query of api.queries) {
      expect(query.startDate >= oldest).toBe(true);
    }
  });

  it("clamps 16 months to the end of shorter months", () => {
    const at = (date: string) =>
      new Date(oldestAvailableDay(Date.parse(`${date}T00:00:00.000Z`)))
        .toISOString()
        .slice(0, 10);
    expect(at("2024-03-31")).toBe("2022-11-30");
    expect(at("2024-06-30")).toBe("2023-02-28");
    expect(at("2024-01-01")).toBe("2022-09-01");
  });

  it("keeps a day's breakdown to the configured rows, highest clicks first", async () => {
    const api = fake({ pageCount: 3_000 });
    const { observations } = await syncAll(
      api.runtime,
      {
        mode: "incremental",
        from: "2024-01-16T00:00:00.000Z",
        to: "2024-01-17T00:00:00.000Z",
      },
      context({ siteUrl: SITE, dimensions: "page", rowLimit: 2_600 }),
    );
    const breakdown = api.queries.filter((query) =>
      query.dimensions.includes("page"),
    );
    expect(breakdown.map((query) => [query.startRow, query.rowLimit])).toEqual([
      [0, PAGE_ROWS],
      [PAGE_ROWS, 2_600 - PAGE_ROWS],
    ]);
    const clicks = of(observations, "breakdown_clicks");
    expect(clicks).toHaveLength(2_600);
    const values = clicks.map((o) => o.value);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    expect(new Set(clicks.map((o) => o.dimensions.page)).size).toBe(2_600);
  });

  it("stops paging when a day has fewer rows than the limit", async () => {
    const api = fake({ pageCount: 3_000 });
    const { observations } = await syncAll(
      api.runtime,
      {
        mode: "incremental",
        from: "2024-01-16T00:00:00.000Z",
        to: "2024-01-17T00:00:00.000Z",
      },
      context({
        siteUrl: SITE,
        dimensions: "page",
        rowLimit: MAX_ROWS_PER_DAY,
      }),
    );
    const breakdown = api.queries.filter((query) =>
      query.dimensions.includes("page"),
    );
    expect(breakdown.map((query) => [query.startRow, query.rowLimit])).toEqual([
      [0, PAGE_ROWS],
      [PAGE_ROWS, PAGE_ROWS],
    ]);
    expect(of(observations, "breakdown_clicks")).toHaveLength(3_000);
  });

  it("queries at most two dimensions besides date and 5,000 rows a day", async () => {
    const api = fake();
    await syncAll(
      api.runtime,
      {
        mode: "backfill",
        from: "2023-12-01T00:00:00.000Z",
        to: "2024-01-20T12:00:00.000Z",
      },
      context({ siteUrl: SITE, dimensions: "query,country", rowLimit: 5_000 }),
    );
    const breakdowns = api.queries.filter(
      (query) =>
        !query.dimensions.includes("date") && query.dimensions.length > 0,
    );
    expect(breakdowns.length).toBeGreaterThan(0);
    for (const query of api.queries) {
      expect(
        query.dimensions.filter((dimension) => dimension !== "date").length,
      ).toBeLessThanOrEqual(2);
    }
    for (const query of breakdowns) {
      // One day per breakdown query, never more than the cap.
      expect(query.startDate).toBe(query.endDate);
      expect(query.startRow + query.rowLimit).toBeLessThanOrEqual(5_000);
      expect(query.dimensions).toEqual(["query", "country"]);
    }
  });

  it("rejects a breakdown with three dimensions or more than 5,000 rows", async () => {
    expect(parseConfig({ dimensions: "page,query,country" })).toEqual({
      ok: false,
      message: expect.stringMatching(/at most 2 dimensions/),
    });
    expect(parseConfig({ rowLimit: 5_001 })).toEqual({
      ok: false,
      message: expect.stringMatching(/1 to 5000/),
    });
    expect(parseConfig({ dimensions: "page,pages" }).ok).toBe(false);
    expect(parseConfig({ dimensions: "page,page" }).ok).toBe(false);
    expect(parseConfig({ rowLimit: 0 }).ok).toBe(false);
    expect(parseConfig({ rowLimit: 2.5 }).ok).toBe(false);
    expect(parseConfig({ siteUrl: SITE, dimensions: "device,query" })).toEqual({
      ok: true,
      config: {
        siteUrl: SITE,
        dimensions: ["device", "query"],
        rowLimit: 1000,
      },
    });

    const api = fake();
    const three = context({ siteUrl: SITE, dimensions: "page,query,device" });
    await expect(connector().check(three, api.runtime)).resolves.toEqual({
      ok: false,
      message: expect.stringMatching(/at most 2 dimensions/),
    });
    await expect(
      connector().sync(
        three,
        {
          mode: "incremental",
          from: "2024-01-10T00:00:00.000Z",
          to: "2024-01-20T00:00:00.000Z",
        },
        api.runtime,
      ),
    ).rejects.toThrow(/at most 2 dimensions/);
    const many = context({ siteUrl: SITE, rowLimit: 10_000 });
    await expect(connector().check(many, api.runtime)).resolves.toMatchObject({
      ok: false,
    });
    expect(api.requests).toHaveLength(0);
  });

  it("declares limits the API's config validation enforces", () => {
    const properties = searchConsoleManifest.configSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.rowLimit).toMatchObject({ minimum: 1, maximum: 5_000 });
    const choices = properties.dimensions!.enum as string[];
    expect(choices).toHaveLength(1 + 4 + 6);
    for (const choice of choices) {
      expect(parseConfig({ dimensions: choice }).ok).toBe(true);
      expect(choice.split(",").length).toBeLessThanOrEqual(2);
    }
  });

  it("keeps CTR and position out of sums across days and rows", () => {
    const byKey = new Map(
      searchConsoleManifest.metrics.map((metric) => [metric.key, metric]),
    );
    for (const key of ["ctr", "position"]) {
      const metric = byKey.get(`${PREFIX}.${key}`)!;
      expect(metric.kind).toBe("gauge");
      expect(metric.dimensions).toEqual(["resource"]);
      expect(metric.aggregations).not.toContain("sum");
      expect(metric.aggregations).not.toContain("avg");
    }
    // Breakdowns carry only additive values.
    for (const metric of searchConsoleManifest.metrics) {
      if (metric.key.includes(".breakdown_")) {
        expect(metric.kind).toBe("delta");
      }
    }
  });

  it("emits position sums that weight the average by impressions", async () => {
    const { observations } = await syncAll(
      fake().runtime,
      {
        mode: "incremental",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-01-08T00:00:00.000Z",
      },
      context({ siteUrl: SITE, dimensions: "device" }),
    );
    for (const prefix of ["", "breakdown_"]) {
      const impressions = of(observations, `${prefix}impressions`);
      const sums = of(observations, `${prefix}position_sum`);
      expect(sums).toHaveLength(impressions.length);
      for (const sum of sums) {
        const match = impressions.find(
          (o) =>
            o.sourceTimestamp === sum.sourceTimestamp &&
            JSON.stringify(o.dimensions) === JSON.stringify(sum.dimensions),
        )!;
        const average = sum.value / match.value;
        expect(average).toBeGreaterThanOrEqual(1);
        expect(average).toBeLessThan(42);
      }
    }
    const positions = of(observations, "position");
    const totals = of(observations, "position_sum");
    for (const position of positions) {
      const impressions = of(observations, "impressions").find(
        (o) => o.sourceTimestamp === position.sourceTimestamp,
      )!;
      const total = totals.find(
        (o) => o.sourceTimestamp === position.sourceTimestamp,
      )!;
      expect(total.value).toBeCloseTo(position.value * impressions.value, 6);
    }
  });

  it("emits only the totals without a breakdown", async () => {
    const api = fake();
    const { observations } = await syncAll(api.runtime, {
      mode: "incremental",
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-01-08T00:00:00.000Z",
    });
    expect(new Set(observations.map((o) => o.metricKey))).toEqual(
      new Set(
        ["clicks", "impressions", "ctr", "position", "position_sum"].map(
          (key) => `${PREFIX}.${key}`,
        ),
      ),
    );
    // One query per weekly chunk.
    expect(api.queries).toHaveLength(1);
  });

  it("syncs nothing for a property outside the engine's resource selection", async () => {
    const api = fake();
    const result = await connector().sync(
      context(),
      {
        mode: "incremental",
        from: "2024-01-01T00:00:00.000Z",
        to: "2024-01-08T00:00:00.000Z",
        resources: ["sc-domain:example.org"],
      },
      api.runtime,
    );
    expect(result.observations).toEqual([]);
    expect(result.done).toBe(true);
    expect(api.requests).toHaveLength(0);
  });

  it("waits out rate limits and retries server errors", async () => {
    const waits: number[] = [];
    const api = fake({
      failures: [
        { status: 429, headers: { "retry-after": "2" } },
        { status: 503 },
        { status: 502 },
      ],
    });
    const result = await createSearchConsoleConnector({
      now: clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).discover(context(), api.runtime);
    expect(result).toHaveLength(3);
    expect(waits).toEqual([2000, 2000, 4000]);
  });

  it("gives up on a far rate-limit reset and on persistent outages", async () => {
    const far = fake({
      failures: [{ status: 429, headers: { "retry-after": "3600" } }],
    });
    await expect(connector().discover(context(), far.runtime)).rejects.toThrow(
      /quota is used up/,
    );
    const down = fake({
      failures: Array.from({ length: 4 }, () => ({ status: 500 })),
    });
    await expect(connector().discover(context(), down.runtime)).rejects.toThrow(
      /not answering right now \(500\)/,
    );
  });
});

describe("search console connector check", () => {
  it("accepts a verified property the account can read", async () => {
    await expect(connector().check(context(), fake().runtime)).resolves.toEqual(
      { ok: true },
    );
    await expect(
      connector().check(
        context({ siteUrl: "sc-domain:example.org" }),
        fake().runtime,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("asks to reconnect when no access token is handed over", async () => {
    const api = fake();
    await expect(
      connector().check(context({ siteUrl: SITE }, {}), api.runtime),
    ).resolves.toEqual({
      ok: false,
      message: expect.stringMatching(/Reconnect Google/),
    });
    expect(api.requests).toHaveLength(0);
  });

  it("asks for a property while the connection is in setup", async () => {
    await expect(
      connector().check(context({}), fake().runtime),
    ).resolves.toEqual({
      ok: false,
      message: expect.stringMatching(/Choose a Search Console property/),
    });
  });

  it("fails for unverified, unknown and no longer readable properties", async () => {
    for (const siteUrl of [
      "https://unverified.example.com/",
      "https://unknown.example.com/",
    ]) {
      const result = await connector().check(
        context({ siteUrl }),
        fake().runtime,
      );
      expect(result).toEqual({
        ok: false,
        message: expect.stringContaining(`no verified access to ${siteUrl}`),
      });
    }
    const removed = await connector().check(
      context(),
      fake({ forbiddenSites: [SITE] }).runtime,
    );
    expect(removed).toEqual({
      ok: false,
      message: expect.stringMatching(/refused access/),
    });
  });

  it("throws (retryable) for a rejected token instead of failing the check", async () => {
    await expect(
      connector().check(
        context({ siteUrl: SITE }, { accessToken: "expired" }),
        fake().runtime,
      ),
    ).rejects.toMatchObject({ name: "AccessTokenRejectedError" });
  });
});
