import { describe, expect, it } from "vitest";

import { formatWarnings } from "./format-readability.js";
import {
  countdownDoneText,
  countdownLabel,
  countdownUnits,
} from "./i18n/shared/index.js";
import {
  STUDIO_TEXT_MINIMUMS,
  countdownLayout,
  countdownParts,
  countdownText,
  estimateTextWidth,
  parseCountdownTarget,
  widgetRect,
  widgetTypeScale,
  zonedInstant,
} from "./studio-layout.js";

// The countdown widget (ADR 0019 section 8): the target in its zone, the
// time left, the layout and the `countdown_passed` info warning.

const iso = (date: Date | null) => date?.toISOString() ?? null;

describe("parseCountdownTarget", () => {
  it("reads a local date and time in 2000–2100", () => {
    expect(parseCountdownTarget("2026-10-07T10:00")).toEqual({
      year: 2026,
      month: 10,
      day: 7,
      hour: 10,
      minute: 0,
    });
    expect(parseCountdownTarget("2000-01-01T00:00")).not.toBeNull();
    expect(parseCountdownTarget("2100-12-31T23:59")).not.toBeNull();
    expect(parseCountdownTarget("2028-02-29T12:00")).not.toBeNull();
  });

  it("refuses other shapes, days that do not exist and other years", () => {
    for (const target of [
      "1999-12-31T23:59",
      "2101-01-01T00:00",
      "2026-02-30T10:00",
      "2027-02-29T10:00",
      "2026-13-01T10:00",
      "2026-10-07T24:00",
      "2026-10-07T10:60",
      "2026-10-07 10:00",
      "2026-10-07T10:00:00",
      "2026-10-07T10:00Z",
      "",
    ]) {
      expect(parseCountdownTarget(target), target).toBeNull();
    }
  });
});

describe("zonedInstant", () => {
  it("resolves the target in its zone", () => {
    expect(iso(zonedInstant("2026-10-07T10:00", "Europe/Berlin"))).toBe(
      "2026-10-07T08:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-12-24T18:00", "Europe/Berlin"))).toBe(
      "2026-12-24T17:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-10-07T10:00", "America/New_York"))).toBe(
      "2026-10-07T14:00:00.000Z",
    );
    expect(iso(zonedInstant("2026-10-07T10:00", "Asia/Kathmandu"))).toBe(
      "2026-10-07T04:15:00.000Z",
    );
    expect(iso(zonedInstant("2026-10-07T10:00", "UTC"))).toBe(
      "2026-10-07T10:00:00.000Z",
    );
  });

  it("moves a time in a spring-forward gap forward by the gap", () => {
    // Berlin goes from 02:00 to 03:00 on 29 March 2026: 02:30 is 03:30.
    expect(iso(zonedInstant("2026-03-29T02:30", "Europe/Berlin"))).toBe(
      "2026-03-29T01:30:00.000Z",
    );
    expect(iso(zonedInstant("2026-03-29T03:00", "Europe/Berlin"))).toBe(
      "2026-03-29T01:00:00.000Z",
    );
    // New York, 8 March 2026, 02:00 → 03:00.
    expect(iso(zonedInstant("2026-03-08T02:15", "America/New_York"))).toBe(
      "2026-03-08T07:15:00.000Z",
    );
  });

  it("takes the earlier offset for a time that exists twice", () => {
    // Berlin falls back from 03:00 to 02:00 on 25 October 2026: the first
    // 02:30 is still summer time (UTC+2).
    expect(iso(zonedInstant("2026-10-25T02:30", "Europe/Berlin"))).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(iso(zonedInstant("2026-11-01T01:30", "America/New_York"))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("is null for a target that does not parse, UTC for an unknown zone", () => {
    expect(zonedInstant("2026-02-30T10:00", "Europe/Berlin")).toBeNull();
    expect(iso(zonedInstant("2026-10-07T10:00", "Mars/Olympus"))).toBe(
      "2026-10-07T10:00:00.000Z",
    );
  });
});

describe("countdownParts", () => {
  const target = new Date("2026-10-07T08:00:00Z");
  const at = (text: string) =>
    countdownText(countdownParts(new Date(text), target).groups);

  it("shows days, hours and minutes, then fewer groups", () => {
    expect(at("2026-10-04T17:55:00Z")).toBe("2 d 14 h 05 m");
    expect(at("2026-10-06T07:00:00Z")).toBe("1 d 01 h 00 m");
    expect(at("2026-10-06T17:55:00Z")).toBe("14 h 05 m");
    expect(at("2026-10-07T07:00:00Z")).toBe("1 h 00 m");
    expect(at("2026-10-07T07:19:00Z")).toBe("41 m");
    expect(at("2026-10-07T07:59:00Z")).toBe("1 m");
    expect(at("2026-10-07T07:59:30Z")).toBe("< 1 m");
  });

  it("counts a tick just after the minute as on it", () => {
    expect(at("2026-10-07T07:00:00.300Z")).toBe("1 h 00 m");
    expect(at("2026-10-07T07:58:59.000Z")).toBe("1 m");
  });

  it("is done at and after the target", () => {
    expect(countdownParts(target, target)).toEqual({ done: true, groups: [] });
    expect(countdownParts(new Date("2026-10-08T00:00:00Z"), target).done).toBe(
      true,
    );
    expect(
      countdownParts(new Date("2026-10-07T07:59:59.999Z"), target).done,
    ).toBe(false);
  });

  it("switches to done at 10:00 in Berlin across a DST change", () => {
    // Counting down from the summer to 10:00 after the clocks went back.
    const after = zonedInstant("2026-10-27T10:00", "Europe/Berlin")!;
    expect(after.toISOString()).toBe("2026-10-27T09:00:00.000Z");
    expect(
      countdownText(
        countdownParts(new Date("2026-10-24T08:00:00Z"), after).groups,
      ),
    ).toBe("3 d 01 h 00 m");
    expect(countdownParts(new Date("2026-10-27T08:59:00Z"), after).done).toBe(
      false,
    );
    expect(countdownParts(new Date("2026-10-27T09:00:00Z"), after).done).toBe(
      true,
    );
  });

  it("writes the unit letters of the language", () => {
    const parts = countdownParts(new Date("2026-10-04T17:55:00Z"), target);
    expect(countdownText(parts.groups, countdownUnits("de"))).toBe(
      "2 T 14 Std 05 Min",
    );
    expect(countdownText(parts.groups, countdownUnits("en"))).toBe(
      "2 d 14 h 05 m",
    );
  });
});

describe("countdown words", () => {
  it("labels without a title and says what happens at the target", () => {
    expect(countdownLabel(null, "en")).toBe("Countdown");
    expect(countdownLabel("  ", "de")).toBe("Countdown");
    expect(countdownLabel("Launch in", "de")).toBe("Launch in");
    expect(countdownDoneText(null, "en")).toBe("Now");
    expect(countdownDoneText(null, "de")).toBe("Jetzt");
    expect(countdownDoneText("We are live", "de")).toBe("We are live");
  });
});

describe("countdownLayout", () => {
  const boxOf = (w: number, h: number) => {
    const rect = widgetRect(
      { x: 0, y: 0, w, h },
      { width: 1920, height: 1080 },
      true,
    );
    return { width: rect.width - 48, height: rect.height - 48 };
  };
  const groups = [
    { value: "2", unit: "d" },
    { value: "14", unit: "h" },
    { value: "05", unit: "m" },
  ];
  const layout = (
    w: number,
    h: number,
    options: Partial<Parameters<typeof countdownLayout>[0]> = {},
  ) =>
    countdownLayout({
      placement: { x: 0, y: 0, w, h },
      box: boxOf(w, h),
      label: "Launch in",
      groups,
      target: "Wed 7 Oct · 10:00",
      doneText: null,
      ...options,
    });

  it("fits title, target line and value in its 3 × 2 minimum", () => {
    const box = boxOf(3, 2);
    expect(box.width).toBeCloseTo(404, 0);
    const result = layout(3, 2);
    expect(result.showTarget).toBe(true);
    expect(result.titleLines).toBe(1);
    expect(result.sizes.value).toBeGreaterThanOrEqual(
      STUDIO_TEXT_MINIMUMS.value,
    );
    expect(result.sizes.unit).toBeGreaterThanOrEqual(
      STUDIO_TEXT_MINIMUMS.change,
    );
    expect(result.sizes.target).toBe(24);
    // Every text at least 24 units.
    for (const size of Object.values(result.sizes)) {
      expect(size).toBeGreaterThanOrEqual(24);
    }
  });

  it("grows the numbers with the widget and keeps letters a third", () => {
    const small = layout(3, 2);
    const large = layout(6, 4);
    expect(large.sizes.value).toBeGreaterThan(small.sizes.value);
    expect(large.sizes.unit).toBeCloseTo(large.sizes.value / 3, 9);
    expect(large.unitGap).toBeCloseTo(large.sizes.value * 0.08, 9);
    expect(large.groupGap).toBeCloseTo(large.sizes.value * 0.3, 9);
  });

  it("fits the time left in the width, on its widest digits", () => {
    const result = layout(6, 4);
    const box = boxOf(6, 4);
    const width = groups.reduce(
      (sum, group, index) =>
        sum +
        estimateTextWidth(
          group.value.replace(/\d/g, "0"),
          result.sizes.value,
          "semibold",
        ) +
        result.unitGap +
        estimateTextWidth(group.unit, result.sizes.unit) +
        (index > 0 ? result.groupGap : 0),
      0,
    );
    expect(width).toBeLessThanOrEqual(box.width + 1e-6);
    // The same size whatever the digits.
    expect(
      layout(6, 4, {
        groups: [
          { value: "8", unit: "d" },
          { value: "11", unit: "h" },
          { value: "11", unit: "m" },
        ],
      }).sizes.value,
    ).toBeCloseTo(result.sizes.value, 9);
  });

  it("leaves the target line out where the numbers need the room", () => {
    expect(layout(3, 2, { fontScale: 1.3 }).showTarget).toBe(false);
    expect(layout(3, 2, { target: null }).showTarget).toBe(false);
  });

  it("shows the text when reached at heading size, smaller only to fit", () => {
    const done = layout(4, 2, { groups: [], doneText: "Now" });
    expect(done.sizes.done).toBe(STUDIO_TEXT_MINIMUMS.heading);
    expect(done.doneLines).toBe(1);
    expect(done.showTarget).toBe(true);
    const long = layout(3, 2, {
      groups: [],
      doneText: "We launched, thank you all for your help",
    });
    expect(long.sizes.done).toBeLessThan(STUDIO_TEXT_MINIMUMS.heading);
    expect(long.sizes.done).toBeGreaterThanOrEqual(24);
    expect(layout(3, 2).doneLines).toBe(0);
  });

  it("uses the countdown's type scale", () => {
    expect(
      widgetTypeScale(
        "countdown",
        { x: 0, y: 0, w: 3, h: 2 },
        { fontScale: 1.3 },
      ),
    ).toMatchObject({
      any: 24 * 1.3,
      title: 30 * 1.3,
      change: 28 * 1.3,
      heading: 56 * 1.3,
      valueMin: 64 * 1.3,
    });
  });
});

describe("countdown_passed", () => {
  const widget = (targetAt: string | null) => ({
    id: "c",
    type: "countdown" as const,
    x: 0,
    y: 0,
    w: 3,
    h: 2,
    label: "Launch in",
    countdown: { targetAt },
  });
  const context = {
    primaryFormat: "16x9" as const,
    fontScale: 1,
    showHeader: true,
    dashboardName: "Launch",
    logoAspect: null,
    now: new Date("2026-10-07T08:00:00Z"),
  };
  const slide = (targetAt: string | null) => ({
    name: null,
    widgets: [widget(targetAt)],
    layouts: {},
  });

  it("says once, as info, in the primary that the target has passed", () => {
    const passed = formatWarnings(
      slide("2026-10-07T08:00:00.000Z"),
      "16x9",
      context,
    );
    expect(passed).toEqual([
      {
        format: "16x9",
        code: "countdown_passed",
        severity: "info",
        widgetId: "c",
        pages: null,
        rows: null,
      },
    ]);
    expect(
      formatWarnings(slide("2026-10-07T08:00:00.000Z"), "9x16", context),
    ).toEqual([]);
  });

  it("says nothing before the target, without one, or without a time", () => {
    expect(
      formatWarnings(slide("2026-10-07T08:01:00.000Z"), "16x9", context),
    ).toEqual([]);
    expect(formatWarnings(slide(null), "16x9", context)).toEqual([]);
    const { now: _now, ...timeless } = context;
    expect(
      formatWarnings(slide("2020-01-01T00:00:00.000Z"), "16x9", timeless),
    ).toEqual([]);
  });

  it("checks the label like every type with one", () => {
    const warnings = formatWarnings(
      {
        name: null,
        widgets: [
          {
            ...widget(null),
            label:
              "Bis zum Start der neuen Version unserer Anwendung für alle Kundinnen und Kunden",
          },
        ],
        layouts: {},
      },
      "16x9",
      context,
    );
    expect(warnings.map((warning) => warning.code)).toEqual(["label_cut"]);
  });
});
