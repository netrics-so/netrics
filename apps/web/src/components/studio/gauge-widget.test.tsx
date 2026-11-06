import { describe, expect, it } from "vitest";

import type { DashboardWidget, DeviceWidget } from "@netrics/contracts";

import { ScrollGaugeCard } from "@/components/scroll/scroll-widgets";
import { renderI18n } from "@/lib/i18n/test-render";
import { dataWidgetCount, type StudioDocument } from "@/lib/studio-document";
import { draftFormatWarnings } from "@/lib/studio-formats";
import { gaugeLabel, gaugeTexts, type GaugeReading } from "@/lib/studio-gauge";
import { newWidget } from "@/lib/studio-new-widget";

import { DeviceWidgetView, deviceGaugeReading } from "./device-widget";

// The goal widget on the web (ADR 0019 section 5, #339).

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const BERLIN = "Europe/Berlin";
// Thursday 22 October 2026, 15:00 in Berlin.
const NOW = new Date("2026-10-22T13:00:00Z");

const monthly: GaugeReading = {
  period: "this_month",
  value: 12_480,
  target: 15_000,
  progress: 0.832,
  reachedAt: null,
  periodEnd: "2026-11-01T00:00:00+01:00",
  unit: "count",
};

const weekly: GaugeReading = {
  period: "this_week",
  value: 612,
  target: 500,
  progress: 1.224,
  reachedAt: "2026-10-19T22:00:00.000Z",
  periodEnd: "2026-10-26T00:00:00+01:00",
  unit: "count",
};

describe("gaugeTexts", () => {
  it("says the percent rounded down, what is left and the days left", () => {
    expect(
      gaugeTexts(monthly, { showTimeLeft: true }, NOW, BERLIN, "en"),
    ).toMatchObject({
      reached: false,
      value: { full: "83", compact: "83" },
      suffix: "%",
      target: "Goal 15,000",
      progress: "2,520 to go · 9 days left",
    });
    expect(
      gaugeTexts(
        { ...monthly, progress: 0.9999, value: 14_999 },
        { showTimeLeft: false },
        NOW,
        BERLIN,
        "en",
      ),
    ).toMatchObject({ value: { full: "99" }, progress: "1 to go" });
    expect(
      gaugeTexts(monthly, { showTimeLeft: true }, NOW, BERLIN, "de"),
    ).toMatchObject({
      target: "Ziel 15.000",
      progress: "noch 2.520 · noch 9 Tage",
    });
  });

  it("says when and how early the goal was reached", () => {
    const texts = gaugeTexts(weekly, { showTimeLeft: true }, NOW, BERLIN, "en");
    expect(texts).toMatchObject({
      reached: true,
      fill: 1,
      value: { full: "612" },
      suffix: null,
      progress: "✓ Reached · 122 % · 5 days early",
    });
    expect(
      gaugeTexts(weekly, { showTimeLeft: false }, NOW, BERLIN, "de").progress,
    ).toBe("✓ Erreicht · 122 %");
  });

  it("names an untitled gauge after its goal, else 'Goal'", () => {
    expect(
      gaugeLabel({ title: null, goalName: "Monthly downloads" }, "en"),
    ).toBe("Monthly downloads");
    expect(gaugeLabel({ title: " Launch ", goalName: "X" }, "en")).toBe(
      "Launch",
    );
    expect(gaugeLabel({ title: null, goalName: null }, "de")).toBe("Ziel");
  });
});

function deviceGauge(
  data: Partial<Extract<DeviceWidget, { type: "gauge" }>["data"]>,
  size = { w: 3, h: 3 },
): Extract<DeviceWidget, { type: "gauge" }> {
  return {
    type: "gauge",
    id: ID(1),
    x: 0,
    y: 0,
    ...size,
    label: "Monthly downloads",
    options: { showTimeLeft: true },
    data: {
      period: "this_month",
      aggregation: "sum",
      unit: "count",
      conversion: null,
      kind: "delta",
      granularity: "day",
      better: "higher",
      status: "ok",
      updatedAt: "2026-10-22T12:55:00Z",
      goal: { id: ID(2), name: "Monthly downloads" },
      value: 12_480,
      target: 15_000,
      progress: 0.832,
      reachedAt: null,
      periodEnd: "2026-11-01T00:00:00+01:00",
      ...data,
    },
  };
}

const env = {
  timeZone: BERLIN,
  fontScale: 1,
  showHeader: true,
  images: new Map(),
};

describe("the goal widget on screens", () => {
  it("draws a full ring with the percent inside", () => {
    const html = renderI18n(
      <DeviceWidgetView widget={deviceGauge({})} env={env} />,
    );
    expect(html).toContain("sw-gauge sw-gauge--stack");
    expect(html).toContain("Goal 15,000");
    // The time left from the screen's own clock.
    expect(html).toMatch(/2,520 to go( · (\d+ days? left|last day))?</);
    expect(html).toContain(">83<");
    expect(html).toContain('class="sw-gauge-suffix"');
    // The fill over its pathLength, from 12 o'clock.
    expect(html).toMatch(/class="sw-gauge-fill"[^>]*pathLength="100"/);
    expect(html).toContain("--gauge-p:83.200");
    expect(html).not.toContain("sw-gauge--reached");
  });

  it("shows the reached state, but never on stale data", () => {
    const reached = deviceGauge({
      value: 612,
      target: 500,
      progress: 1.224,
      period: "this_week",
      reachedAt: "2026-10-19T22:00:00.000Z",
      periodEnd: "2026-10-26T00:00:00+01:00",
    });
    const html = renderI18n(<DeviceWidgetView widget={reached} env={env} />);
    expect(html).toContain("sw-gauge--reached");
    expect(html).toContain(">612<");
    expect(html).toContain("✓ Reached");
    const stale = renderI18n(
      <DeviceWidgetView
        widget={{ ...reached, data: { ...reached.data, status: "stale" } }}
        env={env}
      />,
    );
    expect(stale).toContain("sw--stale");
    expect(stale).not.toContain("sw-gauge--reached");
  });

  it("puts the ring beside the text in a wide widget", () => {
    const html = renderI18n(
      <DeviceWidgetView widget={deviceGauge({}, { w: 6, h: 3 })} env={env} />,
    );
    expect(html).toContain("sw-gauge--side");
  });

  it("says 'Goal deleted' when the goal is gone", () => {
    const html = renderI18n(
      <DeviceWidgetView
        widget={{
          ...deviceGauge({
            goal: null,
            period: null,
            aggregation: null,
            unit: null,
            status: "no_data",
            value: null,
            target: null,
            progress: null,
            periodEnd: null,
          }),
          label: "Goal",
        }}
        env={env}
      />,
    );
    expect(html).toContain("Goal deleted");
    expect(html).toContain("sw--empty");
    expect(html).not.toContain("sw-gauge-ring");
  });

  it("keeps a card in the scroll view", () => {
    const html = renderI18n(
      <ScrollGaugeCard
        {...deviceGaugeReading(deviceGauge({}), BERLIN, "en")}
        width={358}
        rootPx={16}
      />,
    );
    expect(html).toContain("scroll-card--gauge");
    expect(html).toContain(">83<");
  });
});

describe("goal widgets in the Studio", () => {
  const gauge: DashboardWidget = {
    type: "gauge",
    id: ID(3),
    x: 0,
    y: 0,
    w: 3,
    h: 3,
    title: null,
    goalId: null,
    goalName: null,
    options: { showTimeLeft: true },
  };

  it("needs a goal to add one", () => {
    expect(
      newWidget("gauge", { metrics: [], imageIds: [], locale: "en" }),
    ).toEqual({ reason: "Create a goal first (Goals page)." });
    expect(
      newWidget("gauge", {
        metrics: [],
        imageIds: [],
        locale: "en",
        goals: [{ id: ID(2), name: "Monthly downloads" }],
      }),
    ).toEqual({
      widget: {
        type: "gauge",
        title: null,
        goalId: ID(2),
        goalName: "Monthly downloads",
        options: { showTimeLeft: true },
      },
    });
  });

  it("warns goal_missing in every format and counts as a data widget", () => {
    const warnings = draftFormatWarnings(
      { id: ID(4), name: null, widgets: [gauge] },
      {
        primaryFormat: "16x9",
        fontScale: 1,
        showHeader: true,
        dashboardName: "Goals",
        logoAspect: null,
        labelOf: (widget) =>
          widget.type === "gauge" ? gaugeLabel(widget, "en") : null,
      },
    );
    expect(
      warnings.filter((warning) => warning.code === "goal_missing").length,
    ).toBe(5);
    const document = {
      slides: [{ widgets: [gauge, { ...gauge, id: ID(5), goalId: ID(2) }] }],
    } as unknown as StudioDocument;
    expect(dataWidgetCount(document)).toBe(2);
  });
});
