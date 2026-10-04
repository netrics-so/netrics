import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConnectionStateView } from "@netrics/contracts";

import { connectionStatus, deviceTileNotice } from "./tile-status";

describe("deviceTileNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-29T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("words each status like the web tile", () => {
    expect(deviceTileNotice("ok", "2026-09-29T11:59:00.000Z", "en")).toBeNull();
    expect(deviceTileNotice("no_data", null, "en")).toBeNull();
    expect(deviceTileNotice("auth_failed", null, "en")).toBe(
      "Connection needs new credentials",
    );
    expect(deviceTileNotice("outage", null, "en")).toBe("Source unreachable");
    expect(deviceTileNotice("stale", null, "en")).toBe(
      "Waiting for the first sync",
    );
    expect(deviceTileNotice("stale", "2026-09-29T10:00:00.000Z", "en")).toBe(
      "Last sync 2 hours ago",
    );
  });

  it("words them in German", () => {
    expect(deviceTileNotice("outage", null, "de")).toBe(
      "Quelle nicht erreichbar",
    );
    expect(deviceTileNotice("stale", "2026-09-29T10:00:00.000Z", "de")).toBe(
      "Zuletzt synchronisiert vor 2 Stunden",
    );
  });
});

describe("connectionStatus (the server's rule for screens)", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const state = (
    overrides: Partial<ConnectionStateView> = {},
  ): { state: ConnectionStateView } => ({
    state: {
      health: "ok",
      authState: "ok",
      authReason: null,
      lastSuccessAt: "2026-10-04T11:55:00.000Z",
      nextDueAt: null,
      consecutiveFailures: 0,
      pollIntervalSeconds: 300,
      ...overrides,
    },
  });

  it("is ok while the last sync is recent", () => {
    expect(connectionStatus(state(), true, now)).toBe("ok");
  });

  it("is stale after three poll intervals (at least 15 minutes)", () => {
    const old = state({ lastSuccessAt: "2026-10-04T11:44:00.000Z" });
    expect(connectionStatus(old, true, now)).toBe("stale");
    expect(connectionStatus(state({ lastSuccessAt: null }), true, now)).toBe(
      "stale",
    );
  });

  it("names a failing connection before anything else", () => {
    expect(connectionStatus(state({ health: "auth_failed" }), false, now)).toBe(
      "auth_failed",
    );
    expect(
      connectionStatus(state({ health: "needs_reauthorization" }), true, now),
    ).toBe("auth_failed");
    expect(connectionStatus(state({ health: "outage" }), true, now)).toBe(
      "outage",
    );
  });

  it("is no_data without data or without the connection", () => {
    expect(connectionStatus(state(), false, now)).toBe("no_data");
    expect(connectionStatus(undefined, true, now)).toBe("no_data");
  });
});
