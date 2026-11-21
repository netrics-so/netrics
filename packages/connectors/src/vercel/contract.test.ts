import { readFileSync } from "node:fs";

import type {
  ConnectionContext,
  ConnectorResponse,
  ConnectorRuntime,
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import {
  expectValidFreshness,
  freshnessEntry,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import { RateLimitedError } from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import {
  TRAFFIC_STREAM,
  createVercelConnector,
  vercelManifest,
} from "./index.js";
import {
  FAKE_PROJECTS,
  FAKE_TOKEN,
  createFakeVercel,
  type FakeVercelOptions,
} from "./test-helpers.js";

const TODAY = "2024-12-31";
const noSleep = async () => {};
const clock = () => Date.parse(`${TODAY}T12:00:00.000Z`);

function connector() {
  return createVercelConnector({ now: clock, sleep: noSleep });
}

function context(
  overrides: Partial<ConnectionContext> = {},
): ConnectionContext {
  return {
    connectionId: "vercel-test",
    config: {},
    credentials: { token: FAKE_TOKEN },
    ...overrides,
  };
}

function fake(options: FakeVercelOptions = {}) {
  return createFakeVercel({ today: TODAY, ...options });
}

/** Runs every page of one sync the way the engine does. */
async function syncAll(
  runtime: ConnectorRuntime,
  request: SyncRequest,
  ctx = context(),
): Promise<{ pages: SyncResult[]; observations: Observation[] }> {
  const pages: SyncResult[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await connector().sync(
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

runConnectorContractTests(connector(), {
  context: context(),
  runtime: fake().runtime,
});

// ─── Recorded API responses (sanitized) ─────────────────────────────────────

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  );
}

function reply(status: number, body: unknown): ConnectorResponse {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {},
    text: () => text,
    json: () => JSON.parse(text) as unknown,
    bytes: () => new TextEncoder().encode(text),
  };
}

/** Answers each request with the recorded response for its query shape. */
function recordedRuntime(): ConnectorRuntime {
  return {
    signal: new AbortController().signal,
    fetch: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === "/v10/projects") {
        return reply(200, fixture("projects"));
      }
      const by = url.searchParams.getAll("by").join(",");
      if (url.pathname.endsWith("/events/aggregate")) {
        return reply(200, fixture("events-by-day-name"));
      }
      const name = {
        day: "visits-by-day",
        "day,route": "visits-by-day-route",
        "day,country": "visits-by-day-country",
      }[by];
      if (!name) throw new Error(`no recorded response for ${raw}`);
      return reply(200, fixture(name));
    },
  };
}

describe("vercel connector against recorded responses", () => {
  const request: SyncRequest = {
    mode: "backfill",
    from: "2026-09-14T00:00:00.000Z",
    to: "2026-09-29T00:00:00.000Z",
  };
  const recordedNow = () => Date.parse("2026-09-28T12:00:00.000Z");

  it("discovers projects with their Web Analytics state", async () => {
    const resources = await createVercelConnector().discover(
      context(),
      recordedRuntime(),
    );
    expect(resources).toEqual([
      {
        id: "prj_fixture00000000000000000000",
        name: "fixture-site",
        kind: "project",
        metadata: {
          accountId: "team_fixture000000000000000",
          webAnalytics: true,
        },
      },
    ]);
  });

  it("maps daily visits, routes, countries and events to observations", async () => {
    const result = await createVercelConnector({ now: recordedNow }).sync(
      context(),
      request,
      recordedRuntime(),
    );
    const resource = "prj_fixture00000000000000000000";
    const visits = fixture("visits-by-day") as {
      data: Array<{ timestamp: string; visitors: number; pageviews: number }>;
    };
    const first = visits.data[0]!;
    expect(result.observations).toContainEqual({
      metricKey: "vercel.pageviews",
      sourceTimestamp: "2026-09-14T00:00:00.000Z",
      value: first.pageviews,
      dimensions: { resource },
    });
    expect(result.observations).toContainEqual({
      metricKey: "vercel.visitors",
      sourceTimestamp: "2026-09-14T00:00:00.000Z",
      value: first.visitors,
      dimensions: { resource },
    });
    const byMetric = (key: string) =>
      result.observations.filter(
        (observation) => observation.metricKey === key,
      );
    expect(
      new Set(
        byMetric("vercel.route_pageviews").map((o) => o.dimensions.route),
      ),
    ).toContain("Others");
    expect(
      new Set(
        byMetric("vercel.country_visitors").map((o) => o.dimensions.country),
      ),
    ).toContain("SG");
    expect(byMetric("vercel.events")).toContainEqual({
      metricKey: "vercel.events",
      sourceTimestamp: "2026-09-14T00:00:00.000Z",
      value: 12,
      dimensions: { resource, event: "Signup" },
    });
    for (const observation of result.observations) {
      expect(observation.sourceTimestamp).toMatch(/T00:00:00\.000Z$/);
    }
  });

  it("fails clearly when Vercel changes a response shape", async () => {
    const runtime = recordedRuntime();
    const broken: ConnectorRuntime = {
      ...runtime,
      fetch: async (url, init) =>
        url.includes("/visits/aggregate")
          ? reply(200, {
              data: [{ timestamp: "2026-09-14T00:00:00.000Z", views: 3 }],
            })
          : runtime.fetch(url, init),
    };
    await expect(
      createVercelConnector({ now: recordedNow }).sync(
        context(),
        request,
        broken,
      ),
    ).rejects.toThrow(/visitors|pageviews/);
  });

  it("reads the recorded error bodies", async () => {
    const badToken = fixture("error-bad-token");
    const check = await createVercelConnector().check(context(), {
      signal: new AbortController().signal,
      fetch: async () => reply(403, badToken),
    });
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/expired or was revoked/);

    const listDenied = fixture("error-list-teams");
    const denied = await createVercelConnector().check(context(), {
      signal: new AbortController().signal,
      fetch: async () => reply(403, listDenied),
    });
    expect(denied).toEqual({
      ok: false,
      message: expect.stringMatching(/may not list projects/),
    });
  });
});

// ─── Behaviour against the fake API ─────────────────────────────────────────

describe("vercel connector", () => {
  it("only reaches api.vercel.com, with the token in a header", async () => {
    expect(vercelManifest.outboundDomains).toEqual(["api.vercel.com"]);
    const api = fake();
    await syncAll(api.runtime, {
      mode: "backfill",
      from: "2024-11-20T00:00:00.000Z",
      to: "2024-12-05T00:00:00.000Z",
    });
    expect(api.requests.length).toBeGreaterThan(0);
    for (const { url, init } of api.requests) {
      expect(url.hostname).toBe("api.vercel.com");
      expect(url.toString()).not.toContain(FAKE_TOKEN);
      expect(init?.headers?.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    }
  });

  it("pages by calendar month and resumes incremental syncs a day back", async () => {
    const { pages, observations } = await syncAll(fake().runtime, {
      mode: "backfill",
      from: "2024-10-15T08:00:00.000Z",
      to: "2024-12-31T12:00:00.000Z",
    });
    // Page cursors carry where the run started reading (#765).
    expect(pages.map((page) => page.nextCursor)).toEqual([
      "2024-11-01T00:00:00.000Z|2024-10-15T00:00:00.000Z",
      "2024-12-01T00:00:00.000Z|2024-10-15T00:00:00.000Z",
      "2024-12-30T00:00:00.000Z",
    ]);
    expect(pages.at(-1)!.nextFrom).toBe("2024-12-30T00:00:00.000Z");
    const days = new Set(
      observations
        .filter((o) => o.metricKey === "vercel.pageviews")
        .map((o) => o.sourceTimestamp),
    );
    expect(days.size).toBe(78); // 15 Oct … 31 Dec
    expect([...days].sort()[0]).toBe("2024-10-15T00:00:00.000Z");
  });

  it("re-reads the lookback after resuming a checkpoint older than the window (#758)", async () => {
    // A connection that never succeeded, whose backfill died after a page:
    // the next incremental run gets the host's default window and the
    // backfill's checkpoint (a bare instant before #765).
    const { pages, observations } = await syncAll(fake().runtime, {
      mode: "incremental",
      from: "2024-12-31T06:00:00.000Z",
      to: "2024-12-31T12:00:00.000Z",
      cursor: "2024-12-10T00:00:00.000Z",
    });
    expect(pages).toHaveLength(1);
    const days = observations
      .filter((o) => o.metricKey === "vercel.pageviews")
      .map((o) => o.sourceTimestamp)
      .sort();
    expect(days[0]).toBe("2024-12-10T00:00:00.000Z");
    // The next run starts the lookback day back, not at this window's
    // `from`: 30 December was read while it could still change.
    expect(pages[0]!.done).toBe(true);
    expect(pages[0]!.nextFrom).toBe("2024-12-30T00:00:00.000Z");
    expect(pages[0]!.nextCursor).toBe("2024-12-30T00:00:00.000Z");
  });

  it("re-reads the lookback when a resumed run pages past a month start inside it (#765)", async () => {
    const window = {
      mode: "incremental",
      from: "2024-12-01T06:00:00.000Z",
      to: "2024-12-01T12:00:00.000Z",
    } as const;
    // The final page starts on 1 December, inside the lookback day: 30
    // November was read by the page before it.
    for (const cursor of [
      // A checkpoint from before #765, and one that carries its run start.
      "2024-11-10T00:00:00.000Z",
      "2024-11-10T00:00:00.000Z|2024-10-15T00:00:00.000Z",
    ]) {
      const { pages } = await syncAll(fake().runtime, { ...window, cursor });
      expect(pages.map((page) => page.done)).toEqual([false, true]);
      expect(pages[0]!.nextCursor).toBe(
        `2024-12-01T00:00:00.000Z|${cursor.split("|").at(-1)}`,
      );
      expect(pages[1]!.nextFrom).toBe("2024-11-30T00:00:00.000Z");
      expect(pages[1]!.nextCursor).toBe("2024-11-30T00:00:00.000Z");
    }
    // The last page resumed alone by a later run keeps the floor …
    const carried = await syncAll(fake().runtime, {
      ...window,
      cursor: "2024-12-01T00:00:00.000Z|2024-11-10T00:00:00.000Z",
    });
    expect(carried.pages).toHaveLength(1);
    expect(carried.pages[0]!.nextFrom).toBe("2024-11-30T00:00:00.000Z");
    // … which a bare checkpoint at the same position does not have.
    const bare = await syncAll(fake().runtime, {
      ...window,
      cursor: "2024-12-01T00:00:00.000Z",
    });
    expect(bare.pages[0]!.nextFrom).toBe("2024-12-01T00:00:00.000Z");
  });

  it("skips projects without Web Analytics and honours the selection", async () => {
    const request: SyncRequest = {
      mode: "incremental",
      from: "2024-12-01T00:00:00.000Z",
      to: "2024-12-03T00:00:00.000Z",
    };
    const all = await connector().sync(context(), request, fake().runtime);
    expect(new Set(all.observations.map((o) => o.dimensions.resource))).toEqual(
      new Set(["prj_alpha", "prj_beta"]),
    );
    const one = await connector().sync(
      context(),
      { ...request, resources: ["prj_beta"] },
      fake().runtime,
    );
    expect(new Set(one.observations.map((o) => o.dimensions.resource))).toEqual(
      new Set(["prj_beta"]),
    );
  });

  it("keeps a day's values whichever window asks for it", async () => {
    const wide = await syncAll(fake().runtime, {
      mode: "backfill",
      from: "2024-12-01T00:00:00.000Z",
      to: "2024-12-31T00:00:00.000Z",
    });
    const narrow = await syncAll(fake().runtime, {
      mode: "incremental",
      from: "2024-12-20T00:00:00.000Z",
      to: "2024-12-22T00:00:00.000Z",
    });
    for (const observation of narrow.observations) {
      expect(wide.observations).toContainEqual(observation);
    }
  });

  it("clamps a backfill to the days the plan keeps", async () => {
    const api = fake({ planDays: 30 });
    const { pages, observations } = await syncAll(api.runtime, {
      mode: "backfill",
      from: "2024-01-01T00:00:00.000Z",
      to: "2024-12-31T12:00:00.000Z",
    });
    const days = new Set(
      observations
        .filter((o) => o.metricKey === "vercel.pageviews")
        .map((o) => o.sourceTimestamp),
    );
    expect([...days].sort()[0]).toBe("2024-12-02T00:00:00.000Z");
    expect(days.size).toBe(30);
    // January learns the window and jumps straight to it.
    expect(pages.length).toBeLessThanOrEqual(3);
  });

  it("waits out a near rate limit and retries server errors", async () => {
    const waits: number[] = [];
    const api = fake({
      failures: [
        { status: 429, headers: { "retry-after": "2" } },
        { status: 503 },
        { status: 502 },
      ],
    });
    const result = await createVercelConnector({
      now: clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).discover(context(), api.runtime);
    expect(result).toHaveLength(FAKE_PROJECTS.length);
    expect(waits).toEqual([2000, 1000, 2000]);
  });

  it("hands a far rate-limit reset to the host as RateLimitedError (#781)", async () => {
    const far = fake({
      failures: [{ status: 429, headers: { "retry-after": "3600" } }],
    });
    const error = await connector()
      .discover(context(), far.runtime)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      new Date(clock() + 3600 * 1000).toISOString(),
    );
    expect((error as Error).message).toMatch(/429/);
    expect(far.requests).toHaveLength(1);

    // x-ratelimit-reset (UTC epoch seconds) when Vercel sends no retry-after.
    const resetAt = clock() + 40 * 60 * 1000;
    const byReset = fake({
      failures: [
        {
          status: 429,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetAt / 1000),
          },
        },
      ],
    });
    const sync = await connector()
      .sync(
        context(),
        {
          mode: "backfill",
          from: "2024-11-01T00:00:00.000Z",
          to: "2024-12-31T00:00:00.000Z",
        },
        byReset.runtime,
      )
      .catch((caught: unknown) => caught);
    expect(sync).toBeInstanceOf(RateLimitedError);
    expect((sync as RateLimitedError).retryAt).toBe(
      new Date(resetAt).toISOString(),
    );
  });

  it("stops before the window runs out: waits for a near reset, defers a far one (#781)", async () => {
    const waits: number[] = [];
    // Two requests left, the window resets in 20 s: the client waits.
    const near = fake({
      window: { remaining: 2, resetInMs: 20_000, now: clock },
    });
    await createVercelConnector({
      now: clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).discover(context(), near.runtime);
    expect(waits).toEqual([]);
    const projects = await createVercelConnector({
      now: clock,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).sync(
      context(),
      {
        mode: "incremental",
        from: "2024-12-30T00:00:00.000Z",
        to: "2024-12-31T00:00:00.000Z",
      },
      near.runtime,
    );
    expect(projects.done).toBe(true);
    expect(waits[0]).toBe(20_000);
    expect(waits.length).toBeGreaterThan(0);

    // An hour to the reset: no request is spent on a 429.
    const far = fake({
      window: { remaining: 2, resetInMs: 60 * 60 * 1000, now: clock },
    });
    const error = await connector()
      .sync(
        context(),
        {
          mode: "backfill",
          from: "2024-11-01T00:00:00.000Z",
          to: "2024-12-31T00:00:00.000Z",
        },
        far.runtime,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect((error as RateLimitedError).retryAt).toBe(
      new Date(clock() + 60 * 60 * 1000).toISOString(),
    );
    // Only the project list was asked; the analytics queries were not.
    expect(far.requests).toHaveLength(1);
  });

  it("gives up on persistent outages", async () => {
    const down = fake({
      failures: Array.from({ length: 4 }, () => ({ status: 500 })),
    });
    await expect(connector().discover(context(), down.runtime)).rejects.toThrow(
      /500/,
    );
  });

  it("follows project pagination", async () => {
    const resources = await connector().discover(
      context(),
      fake({ projectsPageSize: 1 }).runtime,
    );
    expect(resources.map((resource) => resource.id)).toEqual(
      FAKE_PROJECTS.map((project) => project.id),
    );
  });
});

describe("vercel connector check", () => {
  it("accepts a token that sees analytics-enabled projects", async () => {
    await expect(connector().check(context(), fake().runtime)).resolves.toEqual(
      {
        ok: true,
      },
    );
  });

  it("asks for a token when none is stored", async () => {
    const result = await connector().check(
      context({ credentials: {} }),
      fake().runtime,
    );
    expect(result).toEqual({
      ok: false,
      message: expect.stringMatching(/token/),
    });
  });

  it("reports a revoked token as an auth failure", async () => {
    const result = await connector().check(
      context({ credentials: { token: "revoked" } }),
      fake().runtime,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/expired or was revoked/);
    expect(result.message).not.toContain('revoked"');
  });

  it("names selected projects that are gone or lack Web Analytics", async () => {
    const gone = await connector().check(
      context({ config: { resourceSelection: ["prj_alpha", "prj_missing"] } }),
      fake().runtime,
    );
    expect(gone).toEqual({
      ok: false,
      message: expect.stringContaining("prj_missing"),
    });
    const disabled = await connector().check(
      context({ config: { resourceSelection: ["prj_gamma"] } }),
      fake().runtime,
    );
    expect(disabled).toEqual({
      ok: false,
      message: expect.stringMatching(/not enabled for gamma-docs/),
    });
  });

  it("explains an account without analytics or projects", async () => {
    const noAnalytics = await connector().check(
      context(),
      fake({ projects: [FAKE_PROJECTS[2]!] }).runtime,
    );
    expect(noAnalytics.message).toMatch(/Web Analytics enabled/);
    const empty = await connector().check(
      context(),
      fake({ projects: [] }).runtime,
    );
    expect(empty.message).toMatch(/cannot see any projects/);
  });

  it("throws (retryable) on an outage instead of blaming the token", async () => {
    const down = fake({
      failures: Array.from({ length: 4 }, () => ({ status: 503 })),
    });
    await expect(connector().check(context(), down.runtime)).rejects.toThrow(
      /503/,
    );
  });
});

// ─── Freshness (ADR 0025) ──────────────────────────────────────────────────

describe("vercel freshness", () => {
  it("reports the continuous traffic stream on the done page only", async () => {
    const { pages } = await syncAll(fake().runtime, {
      mode: "backfill",
      from: "2024-11-15T00:00:00.000Z",
      to: `${TODAY}T12:00:00.000Z`,
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.slice(0, -1).every((page) => !page.freshness)).toBe(true);
    const done = pages.at(-1)!;
    expectValidFreshness(vercelManifest, done);
    expect(done.freshness).toEqual([{ stream: TRAFFIC_STREAM }]);
    expect(freshnessEntry(done, TRAFFIC_STREAM)?.dataThrough).toBeUndefined();
  });

  it("reports no traffic when a selected project was not read", async () => {
    const window = {
      mode: "incremental" as const,
      from: "2024-12-30T00:00:00.000Z",
      to: `${TODAY}T12:00:00.000Z`,
    };
    // Web Analytics is off for gamma: nothing of it is read.
    for (const resources of [["prj_gamma"], ["prj_alpha", "prj_gamma"]]) {
      const { pages } = await syncAll(fake().runtime, { ...window, resources });
      expect(pages.at(-1)!.done).toBe(true);
      expect(pages.at(-1)!.freshness).toBeUndefined();
    }
    // A selected project the token no longer lists.
    const gone = await syncAll(fake().runtime, {
      ...window,
      resources: ["prj_alpha", "prj_deleted"],
    });
    expect(gone.pages.at(-1)!.freshness).toBeUndefined();
    const read = await syncAll(fake().runtime, {
      ...window,
      resources: ["prj_alpha", "prj_beta"],
    });
    expect(read.pages.at(-1)!.freshness).toEqual([{ stream: TRAFFIC_STREAM }]);
  });

  it("declares every metric in one continuous stream", () => {
    expect(vercelManifest.freshnessStreams).toEqual([
      expect.objectContaining({ key: TRAFFIC_STREAM, kind: "continuous" }),
    ]);
    expect(
      [...(vercelManifest.freshnessStreams?.[0]?.metrics ?? [])].sort(),
    ).toEqual(vercelManifest.metrics.map((metric) => metric.key).sort());
  });
});
