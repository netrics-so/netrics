import { describe, expect, it } from "vitest";

import {
  formatChange,
  formatCompactValue,
  formatValue,
  localCompactNumber,
  sparkBucketLabel,
} from "./format-metric";
import { relativeTimeIn } from "./relative-time";
import { clockText } from "./studio-clock";
import { connectionNotice, deviceTileNotice } from "./tile-status";

// Screens in German (ADR 0016, #256): numbers, dates and notices in the
// screen's language; English stays as it was.

const NOW = Date.parse("2026-10-04T10:00:00Z");

describe("numbers in German", () => {
  it("groups and separates like German", () => {
    expect(formatValue(1284, "count", "de")).toBe("1.284");
    expect(formatValue(1284, "count")).toBe("1,284");
    expect(formatValue(12.5, "percent", "de")).toBe("12,5%");
    // Intl puts a no-break space before the euro sign.
    expect(formatValue(123456, "EUR_minor", "de")).toBe("1.234,56\u00a0€");
    expect(formatChange(10, 0.125, "count", "higher", "de")?.text).toBe("+13%");
    expect(formatChange(-2.5, null, "count", "higher", "de")?.text).toBe(
      "−2,5",
    );
  });

  it("keeps the shared compact form with a German decimal comma", () => {
    expect(localCompactNumber(12_300, "de")).toBe("12,3K");
    expect(localCompactNumber(12_300, "en")).toBe("12.3K");
    expect(localCompactNumber(-4_200_000, "de")).toBe("-4,2M");
    expect(formatCompactValue(12_300, "count", "de")).toBe("12,3K");
  });

  it("names chart buckets in German", () => {
    expect(
      sparkBucketLabel(
        "2026-09-28T00:00:00.000Z",
        "last_90_days",
        "Europe/Berlin",
        "de",
      ),
    ).toBe("Woche ab 28. Sept.");
    expect(
      sparkBucketLabel(
        "2026-09-28T00:00:00.000Z",
        "last_90_days",
        "Europe/Berlin",
      ),
    ).toBe("Week of Sep 28");
  });
});

describe("clock and notices in German", () => {
  it("writes the date in German, English as before", () => {
    const date = new Date("2026-10-03T12:05:00Z");
    expect(
      clockText(date, {
        timeZone: "Europe/Berlin",
        showDate: true,
        locale: "de",
      }),
    ).toEqual({ time: "14:05", date: "Sa., 3. Okt." });
    expect(
      clockText(date, { timeZone: "Europe/Berlin", showDate: true }),
    ).toEqual({ time: "14:05", date: "Sat 3 Oct" });
  });

  it("says how long ago with Intl", () => {
    expect(relativeTimeIn("2026-10-04T09:55:00Z", "de", NOW)).toBe(
      "vor 5 Minuten",
    );
    expect(relativeTimeIn("2026-10-04T09:59:50Z", "de", NOW)).toBe("jetzt");
    expect(relativeTimeIn("2026-10-02T10:00:00Z", "de", NOW)).toBe(
      "vorgestern",
    );
    expect(relativeTimeIn(null, "de", NOW)).toBeNull();
  });

  it("words tile notices in German", () => {
    expect(deviceTileNotice("auth_failed", null, "de")).toBe(
      "Verbindung braucht neue Zugangsdaten",
    );
    expect(deviceTileNotice("outage", null, "de")).toBe(
      "Quelle nicht erreichbar",
    );
    expect(deviceTileNotice("stale", null, "de")).toBe(
      "Warte auf die erste Synchronisierung",
    );
    expect(
      deviceTileNotice(
        "stale",
        new Date(Date.now() - 2 * 3600_000).toISOString(),
        "de",
      ),
    ).toBe("Zuletzt synchronisiert vor 2 Stunden");
    expect(deviceTileNotice("ok", null, "de")).toBeNull();
    expect(connectionNotice(undefined, NOW, "de")).toBe("Verbindung entfernt");
    expect(connectionNotice(undefined, NOW)).toBe("Connection removed");
  });
});
