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
    expect(deviceTileNotice("ok", "2026-09-29T11:59:00.000Z")).toBeNull();
    expect(deviceTileNotice("no_data", null)).toBeNull();
    expect(deviceTileNotice("auth_failed", null)).toBe(
      "Connection needs new credentials",
    );
    expect(deviceTileNotice("outage", null)).toBe("Source unreachable");
    expect(deviceTileNotice("stale", null)).toBe("Waiting for the first sync");
    expect(deviceTileNotice("stale", "2026-09-29T10:00:00.000Z")).toBe(
      "Last sync 2 hours ago",
    );
  });
});
