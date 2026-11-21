import { describe, expect, it } from "vitest";

import { waitsForSync } from "./connection-refresh";

// The connection page refreshes itself while it waits for a sync (#834):
// a new custom API connection stayed "Pending" until a manual reload.

describe("waitsForSync", () => {
  const base = {
    setupPending: false,
    loginMissing: false,
    health: "ok" as const,
    backfill: "idle" as const,
    runs: [{ status: "succeeded" as const }],
  };

  it("waits for a new connection's first run and a queued or running backfill", () => {
    expect(waitsForSync({ ...base, health: "pending", runs: [] })).toBe(true);
    expect(waitsForSync({ ...base, backfill: "queued" })).toBe(true);
    expect(waitsForSync({ ...base, runs: [{ status: "running" }] })).toBe(true);
  });

  it("does not wait when nothing syncs or everything ran", () => {
    expect(waitsForSync(base)).toBe(false);
    expect(
      waitsForSync({ ...base, health: "pending", setupPending: true }),
    ).toBe(false);
    expect(
      waitsForSync({ ...base, health: "pending", loginMissing: true }),
    ).toBe(false);
  });
});
