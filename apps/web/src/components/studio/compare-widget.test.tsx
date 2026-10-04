import { describe, expect, it } from "vitest";

import type { DeviceWidget } from "@netrics/contracts";

import { ScrollCompareCard } from "@/components/scroll/scroll-widgets";
import { renderI18n } from "@/lib/i18n/test-render";
import {
  compareChangeText,
  compareFooterCandidates,
  compareRatioText,
  compareWidgetLayout,
  type CompareReading,
} from "@/lib/studio-compare";

import { olderSync, worseStatus } from "./compare-widget";
import { CompareWidgetView } from "./compare-widget";
import { DeviceWidgetView, deviceCompareReading } from "./device-widget";

// The compare widget (ADR 0019 section 10, #336).

/** Every font size the markup sets, in units. */
function fontSizes(html: string): number[] {
  return [...html.matchAll(/font-size:calc\(var\(--u\) \* ([\d.]+)\)/g)].map(
    (match) => Number(match[1]),
  );
}

const reading: CompareReading = {
  numerator: { label: "Downloads", value: 12_500, unit: "count" },
  denominator: { label: "Visitors", value: 38_200, unit: "visitors" },
  ratio: { value: 0.327, previousValue: 0.308 },
  unit: null,
  better: "higher",
};

const props = {
  label: "Downloads vs visitors",
  period: "last_7_days" as const,
  options: {
    format: "percent" as const,
    ratioLabel: "conversion",
    showChange: true,
  },
  reading,
  notice: null,
  placement: { x: 0, y: 0, w: 4, h: 3 },
  showHeader: true,
  fontScale: 1,
};

describe("compare texts", () => {
  it("shows a percentage with its change in points", () => {
    expect(compareRatioText(0.327, "percent", null, "en")).toBe("32.7%");
    expect(compareChangeText(reading.ratio, "percent", "higher", "en")).toEqual(
      { text: "▲ 1.9 pt", tone: "good" },
    );
    expect(
      compareChangeText(
        { value: 0.308, previousValue: 0.327 },
        "percent",
        "higher",
        "de",
      ),
    ).toEqual({ text: "▼ 1,9 Pp.", tone: "bad" });
  });

  it("shows a ratio as a number or an amount per unit, with a relative change", () => {
    // Review stars over reviews: the average rating.
    expect(compareRatioText(4.62, "ratio", null, "en")).toBe("4.62");
    expect(compareRatioText(42, "ratio", "EUR_minor", "en")).toBe("€0.42");
    expect(
      compareChangeText(
        { value: 4.62, previousValue: 4.4 },
        "ratio",
        "higher",
        "en",
      ),
    ).toEqual({ text: "▲ +5%", tone: "good" });
    expect(
      compareChangeText(
        { value: 3, previousValue: 0 },
        "ratio",
        "higher",
        "en",
      ),
    ).toBeNull();
  });

  it("shows a dash, never infinity, without a ratio", () => {
    expect(compareRatioText(null, "percent", null, "en")).toBe("–");
    expect(
      compareRatioText(Number.POSITIVE_INFINITY, "ratio", null, "en"),
    ).toBe("–");
  });

  it("puts “derived” before the footer", () => {
    expect(compareFooterCandidates(["updated 2 min ago"], "en")).toEqual([
      "derived · updated 2 min ago",
      "derived",
    ]);
    expect(compareFooterCandidates([], "de")).toEqual(["abgeleitet"]);
  });

  it("ranks the sides' statuses and takes the older sync", () => {
    expect(worseStatus("ok", "stale")).toBe("stale");
    expect(worseStatus("auth_failed", "no_data")).toBe("auth_failed");
    expect(olderSync("2026-10-04T09:00:00Z", "2026-10-04T08:00:00Z")).toBe(
      "2026-10-04T08:00:00Z",
    );
    expect(olderSync(null, "2026-10-04T08:00:00Z")).toBeNull();
  });
});

describe("compare widget", () => {
  it("shows both operands, the ratio and its change (design 4b)", () => {
    const html = renderI18n(<CompareWidgetView {...props} />);
    expect(html).toContain("Downloads vs visitors");
    expect(html).toContain("Last 7 days");
    expect(html).toContain(">12.5K</span>");
    expect(html).toContain(">38.2K</span>");
    expect(html).toContain(
      'class="sw-compare-separator" aria-hidden="true">/<',
    );
    expect(html).toContain(">Downloads</span>");
    expect(html).toContain(">Visitors</span>");
    expect(html).toContain(">32.7%</span>");
    expect(html).toContain(">conversion</span>");
    expect(html).toContain(
      'class="sw-compare-change sw-change good">▲ 1.9 pt</span>',
    );
    expect(Math.min(...fontSizes(html))).toBeGreaterThanOrEqual(24);
    const layout = compareWidgetLayout({ ...props, locale: "en" });
    expect(layout.compare.sizes.ratio).toBeGreaterThanOrEqual(64);
    expect(layout.compare.sizes.operand).toBe(48);
  });

  it("shows a dash for a zero denominator, and “ratio” without a label", () => {
    const html = renderI18n(
      <CompareWidgetView
        {...props}
        options={{ format: "percent", ratioLabel: null, showChange: true }}
        reading={{
          ...reading,
          denominator: { ...reading.denominator, value: 0 },
          ratio: { value: null, previousValue: 0.308 },
        }}
      />,
    );
    expect(html).toContain(">–</span>");
    expect(html).toContain(">ratio</span>");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain("sw-compare-change");
  });

  it("speaks German", () => {
    const html = renderI18n(
      <CompareWidgetView
        {...props}
        options={{ format: "percent", ratioLabel: null, showChange: true }}
      />,
      "de",
    );
    expect(html).toContain("Letzte 7 Tage");
    expect(html).toContain(">32,7%</span>");
    expect(html).toContain(">Verhältnis</span>");
    expect(html).toContain("▲ 1,9 Pp.");
  });

  it("shows the data states of metric widgets", () => {
    const html = renderI18n(
      <CompareWidgetView {...props} reading={null} status="backfilling" />,
    );
    expect(html).toContain("sw-compare sw--empty");
    const stale = renderI18n(
      <CompareWidgetView
        {...props}
        status="stale"
        notice="Last sync 3 h ago"
      />,
    );
    expect(stale).toContain("sw-compare sw--stale");
    expect(stale).toContain("Last sync 3 h ago");
  });

  it("renders a payload compare widget", () => {
    const widget = {
      type: "compare",
      id: "00000000-0000-4000-8000-000000000001",
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      label: "Rating · Wurfel",
      options: { format: "ratio", ratioLabel: "average", showChange: true },
      data: {
        period: "last_30_days",
        aggregation: "sum",
        unit: null,
        conversion: null,
        kind: "delta",
        granularity: "day",
        better: "higher",
        status: "ok",
        updatedAt: "2026-10-04T09:00:00.000Z",
        numerator: { label: "Review stars", value: 2310, unit: "stars" },
        denominator: { label: "Reviews", value: 500, unit: "reviews" },
        ratio: { value: 4.62, previousValue: 4.4, format: "ratio" },
      },
    } as const satisfies DeviceWidget;
    expect(deviceCompareReading(widget, "en").reading?.ratio).toEqual({
      value: 4.62,
      previousValue: 4.4,
    });
    const env = {
      timeZone: "UTC",
      fontScale: 1,
      showHeader: true,
      images: new Map(),
    };
    const html = renderI18n(<DeviceWidgetView widget={widget} env={env} />);
    expect(html).toContain(">4.62</span>");
    expect(html).toContain(">▲ +5%</span>");
    expect(html).toContain(">2,310</span>");
  });
});

describe("compare card in scroll view", () => {
  it("shows the operands, the ratio and its change", () => {
    const html = renderI18n(
      <ScrollCompareCard {...props} width={360} rootPx={16} />,
    );
    expect(html).toContain(">32.7%</span>");
    expect(html).toContain("▲ 1.9 pt");
    expect(html).toContain(">Visitors</span>");
  });
});
