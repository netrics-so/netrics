import { describe, expect, it } from "vitest";

import type { ConnectionStateRow } from "@netrics/database";

import { toStateView } from "./present.js";

function row(overrides: Partial<ConnectionStateRow>): ConnectionStateRow {
  return {
    connectionId: "00000000-0000-4000-8000-000000000001",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    lastSuccessAt: new Date("2026-11-19T08:00:00.000Z"),
    nextDueAt: new Date("2026-11-19T10:40:00.000Z"),
    pollIntervalSeconds: 900,
    cursor: null,
    cursorMidRun: false,
    nextFrom: null,
    backfillJobId: null,
    authState: "ok",
    authReason: null,
    consecutiveFailures: 0,
    rateLimitedUntil: null,
    customApiTestUntil: null,
    backfilledDatasets: null,
    backfillJobDatasets: null,
    backfillRequestedDatasets: null,
    backfillRequestedAt: null,
    backfillRequestCount: 0,
    historyReloadRequestedAt: null,
    historyFrom: null,
    backfillFailedAt: null,
    ...overrides,
  };
}

describe("a connection's state view (#781)", () => {
  const now = new Date("2026-11-19T10:00:00.000Z");

  it("says until when the provider's limit holds, healthy otherwise", () => {
    const view = toStateView(
      row({ rateLimitedUntil: new Date("2026-11-19T10:40:00.000Z") }),
      now,
    );
    expect(view).toMatchObject({
      health: "ok",
      authState: "ok",
      rateLimitedUntil: "2026-11-19T10:40:00.000Z",
    });
  });

  it("leaves out a reset that has passed", () => {
    expect(
      toStateView(
        row({ rateLimitedUntil: new Date("2026-11-19T09:59:00.000Z") }),
        now,
      ).rateLimitedUntil,
    ).toBeNull();
    expect(toStateView(null, now).rateLimitedUntil).toBeNull();
  });
});
