import { describe, expect, it } from "vitest";

import type { DashboardWidget } from "@netrics/contracts";

import { fitCheck, metricValueSize } from "./studio-fit-check";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const metric = (w: number, h: number) =>
  ({
    type: "metric",
    id: ID(11),
    x: 0,
    y: 0,
    w,
    h,
    title: null,
    connectionId: ID(9),
    metricKey: "downloads",
    aggregation: "sum",
    period: "last_30_days",
    dimensions: {},
    displayCurrency: null,
    resourceName: null,
    allResourcesName: null,
    options: { showSparkline: false, showChange: true },
  }) as Extract<DashboardWidget, { type: "metric" }>;

const base = { label: "Downloads", fontScale: 1, showHeader: true } as const;

describe("fit check", () => {
  it("draws a larger widget's value larger", () => {
    const small = metricValueSize(metric(3, 2), "Downloads", 1, true, "en");
    const large = metricValueSize(metric(6, 4), "Downloads", 1, true, "en");
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it("says the label fits, with the value's size for a metric", () => {
    const widget = metric(4, 3);
    const size = metricValueSize(widget, "Downloads", 1, true, "en");
    expect(
      fitCheck({ ...base, widget, unreadable: undefined, locale: "en" }),
    ).toEqual({
      state: "fits",
      text: `Label fits at 1080p · value ${size} px`,
    });
    expect(
      fitCheck({ ...base, widget, unreadable: undefined, locale: "de" })?.text,
    ).toBe(`Beschriftung passt bei 1080p · Wert ${size} px`);
  });

  it("takes the canvas's warning when the label is cut off", () => {
    const widget = metric(2, 2);
    expect(
      fitCheck({
        ...base,
        widget,
        locale: "en",
        unreadable: {
          kind: "label",
          slideId: ID(2),
          widgetId: widget.id,
          label: "Downloads",
          fit: { fits: false, titleLines: 3, resourceLines: 0 },
          fitsAtWidth: 4,
          hint: "The title is cut off on TVs.",
        },
      }),
    ).toEqual({ state: "cut", text: "The title is cut off on TVs." });
  });

  it("checks text widgets and leaves clocks and images out", () => {
    const text = {
      type: "text",
      id: ID(12),
      x: 0,
      y: 0,
      w: 4,
      h: 2,
      title: null,
      text: "Hello",
      options: { size: "body", align: "start" },
    } as DashboardWidget;
    expect(
      fitCheck({ ...base, widget: text, unreadable: undefined, locale: "en" }),
    ).toEqual({ state: "fits", text: "Text fits at 1080p" });
    const clock = {
      type: "clock",
      id: ID(13),
      x: 0,
      y: 0,
      w: 2,
      h: 2,
      title: null,
      options: { timeZone: null, hour12: false, showDate: false },
    } as DashboardWidget;
    expect(
      fitCheck({ ...base, widget: clock, unreadable: undefined, locale: "en" }),
    ).toBeNull();
  });

  it("says which clock lines are left out for room (ADR 0019 §9)", () => {
    const clock = (w: number, h: number, options: object) =>
      ({
        type: "clock",
        id: ID(14),
        x: 0,
        y: 0,
        w,
        h,
        title: null,
        options: {
          timeZone: null,
          hour12: false,
          showDate: true,
          dateStyle: "long",
          showZone: true,
          ...options,
        },
      }) as DashboardWidget;
    const check = (widget: DashboardWidget, locale: "en" | "de" = "en") =>
      fitCheck({
        ...base,
        widget,
        unreadable: undefined,
        locale,
        timeZone: "Europe/Berlin",
      });
    expect(check(clock(2, 1, {}))).toEqual({
      state: "partial",
      text: "The date and time zone do not fit, so they are left out. A larger clock shows more.",
    });
    expect(check(clock(2, 1, { showZone: false }), "de")).toEqual({
      state: "partial",
      text: "Das Datum passt nicht und wird weggelassen. Eine größere Uhr zeigt mehr.",
    });
    expect(check(clock(3, 3, {}))).toEqual({
      state: "fits",
      text: "Everything the clock shows fits at 1080p",
    });
  });
});
