import {
  offlineRuntime,
  runConnectorContractTests,
} from "@netrics/connector-sdk/testing";
import type { ConnectionContext, SyncRequest } from "@netrics/connector-sdk";
import { describe, expect, it } from "vitest";

import { createDemoConnector, demoManifest } from "./index.js";

runConnectorContractTests(createDemoConnector());

const baseContext: ConnectionContext = {
  connectionId: "demo-test",
  config: {},
  credentials: {},
};

function window(from: string, to: string): SyncRequest {
  return { mode: "backfill", from, to };
}

describe("demo connector", () => {
  it("is stable across fresh instances (simulated processes)", async () => {
    const request = window(
      "2024-01-01T00:00:00.000Z",
      "2024-01-11T00:00:00.000Z",
    );
    const first = await createDemoConnector().sync(
      baseContext,
      request,
      offlineRuntime,
    );
    const second = await createDemoConnector().sync(
      baseContext,
      request,
      offlineRuntime,
    );
    expect(second).toEqual(first);
    expect(first.observations.length).toBeGreaterThan(0);
  });

  it("emits one observation per metric, resource, and day at UTC day boundaries", async () => {
    const context: ConnectionContext = {
      ...baseContext,
      config: { seed: 7, resources: 2 },
    };
    const result = await createDemoConnector().sync(
      context,
      window("2024-03-01T00:00:00.000Z", "2024-03-04T00:00:00.000Z"),
      offlineRuntime,
    );
    // March 1–3, plus March 4, which has begun in UTC+14 by `to` (#148).
    expect(result.observations).toHaveLength(4 * 2 * 2);
    for (const observation of result.observations) {
      expect(observation.sourceTimestamp.endsWith("T00:00:00.000Z")).toBe(true);
    }
    // The cursor stays at the UTC day containing `to`.
    expect(result.nextCursor).toBe("2024-03-04T00:00:00.000Z");
    expect(result.done).toBe(true);
  });

  it("changes the series with the seed but stays deterministic per seed", async () => {
    const request = window(
      "2024-01-01T00:00:00.000Z",
      "2024-01-03T00:00:00.000Z",
    );
    const seedA: ConnectionContext = { ...baseContext, config: { seed: 1 } };
    const seedB: ConnectionContext = { ...baseContext, config: { seed: 2 } };
    const a1 = await createDemoConnector().sync(seedA, request, offlineRuntime);
    const a2 = await createDemoConnector().sync(seedA, request, offlineRuntime);
    const b = await createDemoConnector().sync(seedB, request, offlineRuntime);
    expect(a2).toEqual(a1);
    expect(b.observations.map((o) => o.value)).not.toEqual(
      a1.observations.map((o) => o.value),
    );
  });

  it("honours the resources subset in the sync request", async () => {
    const result = await createDemoConnector().sync(
      baseContext,
      {
        ...window("2024-01-01T00:00:00.000Z", "2024-01-03T00:00:00.000Z"),
        resources: ["demo-site-2"],
      },
      offlineRuntime,
    );
    expect(
      new Set(result.observations.map((o) => o.dimensions.resource)),
    ).toEqual(new Set(["demo-site-2"]));
  });

  it("fails check with an actionable message on simulated bad credentials", async () => {
    const result = await createDemoConnector().check(
      {
        ...baseContext,
        config: { simulate: "bad-credentials" },
      },
      offlineRuntime,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/credentials/i);
  });

  it("throws a distinguishable error on simulated outage", async () => {
    const connector = createDemoConnector();
    const context: ConnectionContext = {
      ...baseContext,
      config: { simulate: "outage" },
    };
    await expect(connector.discover(context, offlineRuntime)).rejects.toThrow(
      /outage/,
    );
    await expect(connector.check(context, offlineRuntime)).resolves.toEqual({
      ok: true,
    });
  });

  it("exposes a manifest wired to the demo metrics", () => {
    expect(demoManifest.id).toBe("demo");
    expect(demoManifest.outboundDomains).toEqual([]);
    expect(demoManifest.metrics.map((metric) => metric.key)).toEqual([
      "demo.visitors",
      "demo.signups",
    ]);
  });
});

/** The civil date at `at` in an IANA zone, as YYYY-MM-DD. */
function civilDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

async function datesUpTo(to: string): Promise<string[]> {
  // A backfill as the engine requests it: 90 days up to `to`.
  const toMs = Date.parse(to);
  const result = await createDemoConnector().sync(
    baseContext,
    window(new Date(toMs - 90 * 24 * 60 * 60 * 1000).toISOString(), to),
    offlineRuntime,
  );
  return [
    ...new Set(result.observations.map((o) => o.sourceTimestamp.slice(0, 10))),
  ].sort();
}

// #148: the workspace-local "today" (and so "this month") has data in every
// time zone at any hour, around local and UTC midnight and the 1st.
describe("demo connector reporting dates across time zones", () => {
  const zones = [
    "Europe/Berlin",
    "Pacific/Kiritimati",
    "America/Los_Angeles",
    "UTC",
  ];
  const instants = [
    // Berlin midnight (CEST) is 22:00 UTC; the gap the issue reports.
    "2025-07-15T21:59:59.000Z",
    "2025-07-15T22:00:00.000Z",
    "2025-07-15T22:30:00.000Z",
    "2025-07-15T23:59:59.000Z",
    // UTC midnight, then Kiritimati midnight (10:00 UTC), then LA (07:00).
    "2025-07-16T00:00:00.000Z",
    "2025-07-16T00:30:00.000Z",
    "2025-07-16T06:59:59.000Z",
    "2025-07-16T07:00:00.000Z",
    "2025-07-16T09:59:59.000Z",
    "2025-07-16T10:00:00.000Z",
    "2025-07-16T10:30:00.000Z",
    // The 1st of a month: already August/February east of UTC, not yet in
    // UTC or Los Angeles; winter time in Berlin.
    "2025-07-31T10:00:00.000Z",
    "2025-07-31T22:30:00.000Z",
    "2025-08-01T00:30:00.000Z",
    "2025-08-01T08:00:00.000Z",
    "2026-01-31T23:30:00.000Z",
    "2026-02-28T10:30:00.000Z",
  ];

  it.each(instants)("covers today in every zone at %s", async (at) => {
    const dates = await datesUpTo(at);
    for (const zone of zones) {
      const today = civilDate(new Date(at), zone);
      expect(dates, `${zone} today ${today}`).toContain(today);
      // "This month" starts on the 1st, which is covered whenever it is
      // within the backfill window, as every 1st up to today is.
      expect(dates, `${zone} 1st`).toContain(`${today.slice(0, 7)}-01`);
    }
    // Nothing past the latest calendar date anywhere (UTC+14).
    expect(dates.at(-1)).toBe(civilDate(new Date(at), "Pacific/Kiritimati"));
  });

  it("keeps each date's value independent of when it is synced", async () => {
    const early = await createDemoConnector().sync(
      baseContext,
      window("2025-07-15T00:00:00.000Z", "2025-07-15T22:30:00.000Z"),
      offlineRuntime,
    );
    const late = await createDemoConnector().sync(
      baseContext,
      window("2025-07-15T00:00:00.000Z", "2025-07-17T00:00:00.000Z"),
      offlineRuntime,
    );
    const ahead = early.observations.filter((o) =>
      o.sourceTimestamp.startsWith("2025-07-16"),
    );
    expect(ahead.length).toBeGreaterThan(0);
    for (const observation of ahead) {
      expect(late.observations).toContainEqual(observation);
    }
    expect(early.nextCursor).toBe("2025-07-15T00:00:00.000Z");
  });
});
