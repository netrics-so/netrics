import { describe, expect, it } from "vitest";

import {
  adminKeyGuide,
  adminKeyIdOf,
  analyticsStatusLabel,
  needsEnablement,
  pausedApps,
} from "./app-store-analytics";

describe("App Store analytics card", () => {
  it("labels each status, with the latency of a fresh request", () => {
    expect(analyticsStatusLabel("not_enabled", null, "en")).toBe("Not enabled");
    expect(analyticsStatusLabel("stopped", null, "en")).toBe(
      "App Store analytics paused — enable again",
    );
    expect(analyticsStatusLabel("requested", null, "en")).toBe(
      "Requested — data pending (the first reports take 1–2 days)",
    );
    expect(analyticsStatusLabel("available", "2026-09-29", "en")).toBe(
      "Available through Sep 29, 2026",
    );
    expect(analyticsStatusLabel("unknown", null, "en")).toBe(
      "Status unknown right now",
    );
  });

  it("speaks German, with the day as a German date", () => {
    expect(analyticsStatusLabel("available", "2026-09-29", "de")).toBe(
      "Verfügbar bis 29.09.2026",
    );
    expect(analyticsStatusLabel("not_enabled", null, "de")).toBe(
      "Nicht aktiviert",
    );
    expect(adminKeyGuide("de").steps.at(-1)).toMatch(/^Widerruf den Schlüssel/);
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
    expect(adminKeyGuide("en").steps.at(-1)).toMatch(
      /^Revoke the key right afterwards/,
    );
  });
});
