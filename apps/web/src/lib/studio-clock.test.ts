import { describe, expect, it } from "vitest";

import { CLOCK_DATE_SAMPLES, estimateTextWidth } from "@netrics/domain";

import { clockText, msUntilNextMinute } from "./studio-clock";

const at = new Date("2026-10-04T12:05:30Z");

describe("clockText", () => {
  it("shows 24-hour time in the workspace's zone", () => {
    expect(clockText(at, { timeZone: "Europe/Berlin" })).toEqual({
      time: "14:05",
      date: null,
      zone: null,
    });
    expect(clockText(at, { timeZone: "America/New_York" }).time).toBe("08:05");
  });

  it("shows 12-hour time and the date when asked", () => {
    expect(
      clockText(at, { timeZone: "Asia/Tokyo", hour12: true, showDate: true }),
    ).toEqual({ time: "9:05 PM", date: "Sun 4 Oct", zone: null });
  });

  it("shows the long date in English and German", () => {
    const summer = new Date("2026-10-03T12:00:00Z");
    expect(
      clockText(summer, {
        timeZone: "Europe/Berlin",
        showDate: true,
        dateStyle: "long",
      }).date,
    ).toBe("Saturday, 3 October");
    expect(
      clockText(summer, {
        timeZone: "Europe/Berlin",
        showDate: true,
        dateStyle: "long",
        locale: "de",
      }).date,
    ).toBe("Samstag, 3. Oktober");
  });

  it("shows the zone line with the offset of the day", () => {
    expect(
      clockText(at, { timeZone: "Europe/Berlin", showZone: true }).zone,
    ).toBe("Berlin \u00b7 UTC+2");
    expect(
      clockText(new Date("2026-12-04T12:00:00Z"), {
        timeZone: "Europe/Berlin",
        showZone: true,
      }).zone,
    ).toBe("Berlin \u00b7 UTC+1");
  });

  it("never shows a date wider than the layout's sample", () => {
    for (const style of ["short", "long"] as const) {
      const sample = estimateTextWidth(CLOCK_DATE_SAMPLES[style], 1);
      for (const locale of ["en", "de"]) {
        for (let day = 0; day < 366; day++) {
          const date = new Date(Date.UTC(2026, 0, 1 + day, 12));
          const text = clockText(date, {
            timeZone: "UTC",
            showDate: true,
            dateStyle: style,
            locale,
          }).date!;
          expect(estimateTextWidth(text, 1), text).toBeLessThanOrEqual(sample);
        }
      }
    }
  });

  it("falls back to UTC for a zone the browser does not know", () => {
    expect(clockText(at, { timeZone: "Mars/Olympus" }).time).toBe("12:05");
  });
});

describe("msUntilNextMinute", () => {
  it("ticks on the minute", () => {
    expect(msUntilNextMinute(at.getTime())).toBe(30_000);
  });
});
