import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deviceTileNotice } from "./tile-status";

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
