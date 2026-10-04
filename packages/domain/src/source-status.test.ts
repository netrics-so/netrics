import { describe, expect, it } from "vitest";

import {
  sortSourceItems,
  sourceItemStatus,
  statusCounts,
  type SourceStateInput,
} from "./source-status.js";

const NOW = Date.parse("2026-10-04T12:00:00Z");

function state(patch: Partial<SourceStateInput> = {}): SourceStateInput {
  return {
    health: "ok",
    lastSuccessAt: "2026-10-04T11:50:00Z",
    pollIntervalSeconds: 300,
    setupPending: false,
    ...patch,
  };
}

describe("sourceItemStatus (ADR 0019 section 7)", () => {
  it("is ok within three poll intervals, at least 15 minutes", () => {
    expect(sourceItemStatus(state(), NOW)).toBe("ok");
    // 3 × 300 s = 15 min: 14 minutes are fine, 16 are stale.
    expect(
      sourceItemStatus(state({ lastSuccessAt: "2026-10-04T11:46:00Z" }), NOW),
    ).toBe("ok");
    expect(
      sourceItemStatus(state({ lastSuccessAt: "2026-10-04T11:44:00Z" }), NOW),
    ).toBe("stale");
    // Hourly polling: three hours.
    expect(
      sourceItemStatus(
        state({
          lastSuccessAt: "2026-10-04T09:30:00Z",
          pollIntervalSeconds: 3600,
        }),
        NOW,
      ),
    ).toBe("ok");
  });

  it("is stale when healthy but never synced", () => {
    expect(sourceItemStatus(state({ lastSuccessAt: null }), NOW)).toBe("stale");
  });

  it("is backfilling while the first sync is pending or a backfill runs", () => {
    expect(
      sourceItemStatus(state({ health: "pending", lastSuccessAt: null }), NOW),
    ).toBe("backfilling");
    expect(sourceItemStatus(state({ backfilling: true }), NOW)).toBe(
      "backfilling",
    );
  });

  it("is auth_failed for failed credentials, reauthorization and unfinished setup", () => {
    expect(sourceItemStatus(state({ health: "auth_failed" }), NOW)).toBe(
      "auth_failed",
    );
    expect(
      sourceItemStatus(state({ health: "needs_reauthorization" }), NOW),
    ).toBe("auth_failed");
    expect(
      sourceItemStatus(
        state({ health: "pending", lastSuccessAt: null, setupPending: true }),
        NOW,
      ),
    ).toBe("auth_failed");
  });

  it("is outage when the source is unreachable, before a backfill", () => {
    expect(
      sourceItemStatus(state({ health: "outage", backfilling: true }), NOW),
    ).toBe("outage");
  });
});

describe("sortSourceItems", () => {
  it("lists attention first, then by name", () => {
    const items = [
      { connectionId: "1", name: "Vercel", status: "ok" },
      { connectionId: "2", name: "app store connect", status: "ok" },
      { connectionId: "3", name: "Search Console", status: "stale" },
      { connectionId: "4", name: "Stripe", status: "auth_failed" },
      { connectionId: "5", name: "Plausible", status: "backfilling" },
      { connectionId: "6", name: "Analytics", status: "outage" },
      { connectionId: "7", name: "Billing", status: "ok" },
    ];
    expect(sortSourceItems(items).map((item) => item.name)).toEqual([
      "Stripe",
      "Analytics",
      "Search Console",
      "Plausible",
      "app store connect",
      "Billing",
      "Vercel",
    ]);
  });

  it("is stable for equal names and does not change its input", () => {
    const items = [
      { connectionId: "b", name: "Vercel", status: "ok" },
      { connectionId: "a", name: "Vercel", status: "ok" },
    ];
    expect(sortSourceItems(items).map((item) => item.connectionId)).toEqual([
      "a",
      "b",
    ]);
    expect(items[0]!.connectionId).toBe("b");
  });
});

describe("statusCounts", () => {
  it("counts every source, the delayed and the failing ones", () => {
    expect(
      statusCounts([
        { status: "ok" },
        { status: "stale" },
        { status: "auth_failed" },
        { status: "outage" },
        { status: "backfilling" },
      ]),
    ).toEqual({ connected: 5, delayed: 1, failing: 2 });
    expect(statusCounts([])).toEqual({ connected: 0, delayed: 0, failing: 0 });
  });
});
