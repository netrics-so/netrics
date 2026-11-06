import { describe, expect, it } from "vitest";

import { intervalLabel, relativeTime, relativeTimeIn } from "./relative-time";

describe("intervalLabel", () => {
  it.each([
    [21_600, "every 6 hours", "alle 6 Stunden"],
    [300, "every 5 minutes", "alle 5 Minuten"],
    [3_600, "every hour", "jede Stunde"],
    [86_400, "every day", "jeden Tag"],
    [90, "every 90 seconds", "alle 90 Sekunden"],
  ])("%s → %s / %s", (seconds, en, de) => {
    expect(intervalLabel(seconds, "en")).toBe(en);
    expect(intervalLabel(seconds, "de")).toBe(de);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const at = (offsetSeconds: number) =>
    new Date(now + offsetSeconds * 1000).toISOString();

  it.each([
    [-10, "just now", "gerade eben"],
    [-5 * 60, "5 minutes ago", "vor 5 Minuten"],
    [-60, "1 minute ago", "vor 1 Minute"],
    [2 * 3600, "in 2 hours", "in 2 Stunden"],
    [-3 * 86_400, "3 days ago", "vor 3 Tagen"],
  ])("%s s → %s / %s", (offset, en, de) => {
    expect(relativeTime(at(offset), "en", now)).toBe(en);
    expect(relativeTime(at(offset), "de", now)).toBe(de);
  });

  it("says never without a time", () => {
    expect(relativeTime(null, "en")).toBe("never");
    expect(relativeTime(null, "de")).toBe("nie");
  });
});

describe("relativeTimeIn, short (widget footers)", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  it.each([
    ["2026-10-04T11:55:00.000Z", "5 min. ago", "vor 5 Min."],
    ["2026-10-04T09:00:00.000Z", "3 hr. ago", "vor 3 Std."],
    ["2026-10-04T11:59:40.000Z", "now", "jetzt"],
  ])("%s", (iso, en, de) => {
    expect(relativeTimeIn(iso, "en", now, "short")).toBe(en);
    expect(relativeTimeIn(iso, "de", now, "short")).toBe(de);
  });

  it("is null without a time or one that does not parse", () => {
    expect(relativeTimeIn(null, "en", now, "short")).toBeNull();
    expect(relativeTimeIn("soon", "en", now, "short")).toBeNull();
  });
});
