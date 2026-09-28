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

import { createVercelConnector, vercelManifest } from "./index.js";
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
    expect(pages.map((page) => page.nextCursor)).toEqual([
      "2024-11-01T00:00:00.000Z",
      "2024-12-01T00:00:00.000Z",
      "2024-12-30T00:00:00.000Z",
    ]);
    const days = new Set(
      observations
        .filter((o) => o.metricKey === "vercel.pageviews")
        .map((o) => o.sourceTimestamp),
    );
    expect(days.size).toBe(78); // 15 Oct … 31 Dec
    expect([...days].sort()[0]).toBe("2024-10-15T00:00:00.000Z");
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

  it("gives up on a far rate-limit reset and on persistent outages", async () => {
    const far = fake({
      failures: [{ status: 429, headers: { "retry-after": "3600" } }],
    });
    await expect(connector().discover(context(), far.runtime)).rejects.toThrow(
      /429/,
    );
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
