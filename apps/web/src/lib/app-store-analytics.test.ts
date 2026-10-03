import { describe, expect, it } from "vitest";

import {
  ADMIN_KEY_GUIDE,
  adminKeyIdOf,
  analyticsStatusLabel,
  needsEnablement,
  pausedApps,
} from "./app-store-analytics";

describe("App Store analytics card", () => {
  it("labels each status, with the latency of a fresh request", () => {
    expect(analyticsStatusLabel("not_enabled", null)).toBe("Not enabled");
    expect(analyticsStatusLabel("stopped", null)).toBe(
      "App Store analytics paused — enable again",
    );
    expect(analyticsStatusLabel("requested", null)).toBe(
      "Requested — data pending (the first reports take 1–2 days)",
    );
    expect(analyticsStatusLabel("available", "2026-09-29")).toBe(
      "Available through 2026-09-29",
    );
    expect(analyticsStatusLabel("unknown", null)).toBe(
      "Status unknown right now",
    );
  });

  it("asks for the Admin step only when an app is not or no longer requested", () => {
    expect(
      needsEnablement([{ status: "requested" }, { status: "available" }]),
    ).toBe(false);
    expect(
      needsEnablement([{ status: "available" }, { status: "not_enabled" }]),
    ).toBe(true);
    expect(needsEnablement([{ status: "stopped" }])).toBe(true);
    expect(
      pausedApps([{ status: "stopped" }, { status: "requested" }]),
    ).toEqual([{ status: "stopped" }]);
  });

  it("reminds of the temporary key by its ID, and says to revoke it", () => {
    expect(adminKeyIdOf({ keyId: " 4dm1nk3y01 " })).toBe("4DM1NK3Y01");
    expect(adminKeyIdOf({ keyId: "short" })).toBeNull();
    expect(ADMIN_KEY_GUIDE.steps.at(-1)).toMatch(
      /^Revoke the key right afterwards/,
    );
  });
});
