import { describe, expect, it } from "vitest";

import { formatWarnings } from "./format-readability.js";
import { goalPercent, goalReached, goalTimeText } from "./goals.js";
import {
  GAUGE_SPACING,
  STUDIO_MIN_WIDGET_SIZE,
  gaugeLayout,
  hasWidgetLabel,
  widgetTypeScale,
} from "./studio-layout.js";
import { WIDGET_TYPES, dataWidgetCost } from "./studio.js";

// The goal widget (ADR 0019 section 5, #339): a full ring with the value
// inside, its time line computed on the client, and the Studio's warning
// when its goal is gone.

const BERLIN = "Europe/Berlin";

// A 3 × 3 widget's content box at 16:9 with the header.
const MIN_BOX = { width: 404, height: 294.65 };

describe("the gauge type", () => {
  it("is a 3 × 3 widget with a label that counts as one data widget", () => {
    expect(WIDGET_TYPES).toContain("gauge");
    expect(STUDIO_MIN_WIDGET_SIZE.gauge).toEqual({ w: 3, h: 3 });
    expect(hasWidgetLabel("gauge")).toBe(true);
    expect(dataWidgetCost("gauge")).toBe(1);
    expect(dataWidgetCost("metric")).toBe(1);
    expect(dataWidgetCost("clock")).toBe(0);
    expect(
      widgetTypeScale("gauge", { x: 0, y: 0, w: 3, h: 3 }, { fontScale: 1.3 }),
    ).toMatchObject({ title: 30 * 1.3, change: 28 * 1.3, valueMin: 64 * 1.3 });
  });
});

describe("gaugeLayout", () => {
  it("fits label, target line, a 160 u ring and the progress line at 3 × 3", () => {
    const layout = gaugeLayout({
      label: "Monthly downloads",
      ...MIN_BOX,
      value: { full: "83", compact: "83" },
      suffix: "%",
      progress: "2,520 to go · 9 days left",
    });
    expect(layout.orientation).toBe("stack");
    expect(layout.showTarget).toBe(true);
    // The footer appears from 3 × 4.
    expect(layout.showFooter).toBe(false);
    expect(layout.fits).toBe(true);
    expect(layout.ring.diameter).toBeGreaterThanOrEqual(GAUGE_SPACING.ringMin);
    expect(layout.ring.stroke).toBeCloseTo(
      Math.max(16, layout.ring.diameter * 0.1),
      9,
    );
    // The percent inside the ring keeps the value minimum.
    expect(layout.sizes.value).toBeGreaterThanOrEqual(64);
    expect(layout.compact).toBe(false);
  });

  it("drops the footer first, then the target line", () => {
    const tall = gaugeLayout({
      label: "Monthly downloads",
      width: 404,
      height: 414.2,
    });
    expect([tall.showTarget, tall.showFooter]).toEqual([true, true]);
    const scaled = gaugeLayout({
      label: "Monthly downloads",
      ...MIN_BOX,
      fontScale: 1.3,
    });
    expect([scaled.showTarget, scaled.showFooter]).toEqual([false, false]);
    expect(scaled.fits).toBe(true);
  });

  it("puts the ring right of the text from a 1.6:1 content box", () => {
    const wide = gaugeLayout({
      label: "Monthly downloads",
      width: 872,
      height: 294.65,
    });
    expect(wide.orientation).toBe("side");
    expect(wide.ring.diameter).toBeCloseTo(294.65, 9);
    expect(wide.textWidth).toBeCloseTo(872 - 294.65 - GAUGE_SPACING.side, 9);
    const square = gaugeLayout({ label: "x", width: 560, height: 414.2 });
    expect(square.orientation).toBe("stack");
    // The ring is never wider than the content.
    const narrow = gaugeLayout({ label: "x", width: 200, height: 900 });
    expect(narrow.ring.diameter).toBe(200);
  });

  it("uses the compact value when the full one does not fit the ring", () => {
    const layout = gaugeLayout({
      label: "Revenue",
      ...MIN_BOX,
      value: { full: "€1,234,567", compact: "€1.2M" },
    });
    expect(layout.compact).toBe(true);
    const roomy = gaugeLayout({
      label: "Revenue",
      width: 1808,
      height: 892.4,
      value: { full: "612", compact: "612" },
    });
    expect(roomy.compact).toBe(false);
    expect(roomy.sizes.value).toBeGreaterThan(64);
  });

  it("reports a ring under its minimum", () => {
    const small = gaugeLayout({
      label: "Monthly downloads",
      width: 250,
      height: 175,
    });
    expect(small.fits).toBe(false);
    expect([small.showTarget, small.showFooter]).toEqual([false, false]);
  });
});

describe("goalPercent and goalReached", () => {
  it("rounds the percent down, never 100 % before the goal is reached", () => {
    expect(goalPercent(0.832)).toBe(83);
    expect(goalPercent(0.29)).toBe(29);
    expect(goalPercent(0.9999)).toBe(99);
    expect(goalPercent(1)).toBe(100);
    expect(goalPercent(1.224)).toBe(122);
    expect(goalPercent(0)).toBe(0);
    expect(goalPercent(null)).toBeNull();
    expect(goalReached(0.9999)).toBe(false);
    expect(goalReached(1)).toBe(true);
    expect(goalReached(null)).toBe(false);
  });
});

describe("goalTimeText", () => {
  const month = {
    period: "this_month",
    periodEnd: "2026-11-01T00:00:00+01:00",
    reachedAt: null,
    progress: 0.83,
    timeZone: BERLIN,
  };

  it("counts whole days after today, and the last day", () => {
    // Thursday 22 October, 15:00 in Berlin: 23–31 October are left.
    expect(
      goalTimeText({ ...month, now: new Date("2026-10-22T13:00:00Z") }),
    ).toEqual({ kind: "days", days: 9 });
    // Just after midnight across the DST change still counts dates.
    expect(
      goalTimeText({ ...month, now: new Date("2026-10-21T22:30:00Z") }),
    ).toEqual({ kind: "days", days: 9 });
    expect(
      goalTimeText({ ...month, now: new Date("2026-10-31T22:59:00Z") }),
    ).toEqual({ kind: "last_day" });
    // After the end (an old payload): nothing.
    expect(
      goalTimeText({ ...month, now: new Date("2026-10-31T23:00:00Z") }),
    ).toBeNull();
  });

  it("counts hours for today", () => {
    const today = {
      ...month,
      period: "today",
      periodEnd: "2026-10-23T00:00:00+02:00",
    };
    expect(
      goalTimeText({ ...today, now: new Date("2026-10-22T16:30:00Z") }),
    ).toEqual({ kind: "hours", hours: 5 });
    expect(
      goalTimeText({ ...today, now: new Date("2026-10-22T21:20:00Z") }),
    ).toEqual({ kind: "under_hour" });
  });

  it("says how many days early a goal was reached", () => {
    const reached = {
      ...month,
      period: "this_week",
      periodEnd: "2026-10-26T00:00:00+01:00",
      progress: 1.22,
      // Thursday 22 October (the bucket's start in Berlin).
      reachedAt: "2026-10-21T22:00:00.000Z",
      now: new Date("2026-10-24T10:00:00Z"),
    };
    // Friday 23 to Sunday 25 October.
    expect(goalTimeText(reached)).toEqual({ kind: "early", days: 3 });
    expect(goalTimeText({ ...reached, reachedAt: null })).toBeNull();
    // Reached on the last day: no "early".
    expect(
      goalTimeText({ ...reached, reachedAt: "2026-10-24T23:00:00.000Z" }),
    ).toBeNull();
    expect(
      goalTimeText({ ...reached, period: "today", progress: 1.5 }),
    ).toBeNull();
    expect(goalTimeText({ ...reached, progress: null })).toBeNull();
  });
});

describe("goal_missing", () => {
  it("warns in every format when a goal widget's goal is gone", () => {
    const context = {
      primaryFormat: "16x9" as const,
      fontScale: 1,
      showHeader: false,
      dashboardName: "Overview",
      logoAspect: null,
    };
    const gauge = (goalMissing: boolean) => ({
      name: null,
      layouts: {},
      widgets: [
        {
          id: "g",
          type: "gauge" as const,
          x: 0,
          y: 0,
          w: 3,
          h: 3,
          label: "Monthly downloads",
          goalMissing,
        },
      ],
    });
    const warnings = formatWarnings(gauge(true), "16x9", context);
    expect(warnings).toMatchObject([
      { code: "goal_missing", severity: "attention", widgetId: "g" },
    ]);
    expect(formatWarnings(gauge(false), "16x9", context)).toEqual([]);
  });
});
