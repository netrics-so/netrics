import { describe, expect, it } from "vitest";

import {
  STUDIO_TEXT_MINIMUMS,
  estimateTextWidth,
  wrappedLineCount,
} from "@netrics/domain";

import {
  chartWidgetLayout,
  contentBox,
  fitLabel,
  fitValue,
  labelLayout,
  metricWidgetLayout,
  typeScaleFor,
  u,
  widgetBoxStyle,
} from "./studio-render";
import { studioVectors } from "./studio-vectors.test-helper";

const pct = (value: string) => Number.parseFloat(value.replace("%", ""));

describe("widget boxes", () => {
  it("place every widget where the shared vectors do, at any canvas size", () => {
    for (const vector of studioVectors.rects) {
      const box = widgetBoxStyle(vector.placement, vector.showHeader);
      const { canvas, rect } = vector;
      // 16:9 canvases only: the percentages scale linearly with them.
      if (Math.abs(canvas.width / canvas.height - 16 / 9) > 1e-9) continue;
      expect(pct(box.left)).toBeCloseTo((rect.x / canvas.width) * 100, 2);
      expect(pct(box.top)).toBeCloseTo((rect.y / canvas.height) * 100, 2);
      expect(pct(box.width)).toBeCloseTo((rect.width / canvas.width) * 100, 2);
      expect(pct(box.height)).toBeCloseTo(
        (rect.height / canvas.height) * 100,
        2,
      );
    }
  });

  it("expresses sizes in canvas units", () => {
    expect(u(30)).toBe("calc(var(--u) * 30)");
    expect(u(34.499)).toBe("calc(var(--u) * 34.5)");
  });

  it("uses the type scale of the shared vectors", () => {
    for (const vector of studioVectors.typeScales) {
      expect(
        typeScaleFor(
          vector.type,
          { x: 0, y: 0, w: vector.w, h: vector.h },
          vector.fontScale,
          vector.showHeader,
        ),
      ).toEqual(vector.sizes);
    }
  });
});

describe("fitLabel", () => {
  it("keeps a label that fits at its size", () => {
    expect(fitLabel("Downloads", 400, { size: 30, floor: 30 })).toEqual({
      text: "Downloads",
      size: 30,
      lines: 1,
      truncated: false,
    });
  });

  it("wraps to two lines before anything else", () => {
    const text = "Paperstand – Magazine reader";
    const fitted = fitLabel(text, 300, { size: 30, floor: 30 });
    expect(fitted).toMatchObject({ lines: 2, truncated: false, size: 30 });
  });

  it("shrinks a font-scaled label towards the minimum before truncating", () => {
    const text = "Paperstand – Magazine reader for iPad";
    const at30 = wrappedLineCount(text, 400, 30, "semibold");
    const at39 = wrappedLineCount(text, 400, 39, "semibold");
    expect(at39).toBeGreaterThan(2);
    expect(at30).toBeLessThanOrEqual(2);
    const fitted = fitLabel(text, 400, { size: 39, floor: 30 });
    expect(fitted.truncated).toBe(false);
    expect(fitted.size).toBeLessThan(39);
    expect(fitted.size).toBeGreaterThanOrEqual(30);
    expect(fitted.lines).toBeLessThanOrEqual(2);
  });

  it("truncates only as the last resort, at the minimum, and says so", () => {
    const text = "An extremely long resource name ".repeat(4).trim();
    const fitted = fitLabel(text, 300, { size: 39, floor: 30 });
    expect(fitted).toMatchObject({ size: 30, lines: 2, truncated: true });
    expect(fitted.text).toBe(text);
  });

  it("never goes below the floor", () => {
    const fitted = fitLabel("W".repeat(80), 100, { size: 30, floor: 30 });
    expect(fitted.size).toBe(30);
  });
});

describe("labelLayout", () => {
  it("wraps title and resource exactly like studioLayout.labelFit", () => {
    for (const vector of studioVectors.labelFits) {
      if (!["metric", "line", "bar"].includes(vector.type)) continue;
      const placement = { x: 0, y: 0, w: vector.w, h: vector.h };
      const box = contentBox(placement, true);
      const sizes = typeScaleFor(
        vector.type,
        placement,
        vector.fontScale,
        true,
      );
      const layout = labelLayout(vector.label, box.width, sizes);
      const truncated =
        layout.title.truncated || (layout.resource?.truncated ?? false);
      if (vector.fontScale <= 1) {
        // At the minimum size there is nothing to shrink: same lines.
        expect(layout.title.lines).toBe(Math.min(vector.titleLines, 2));
        expect(layout.resource?.lines ?? 0).toBe(
          Math.min(vector.resourceLines, 2),
        );
        expect(truncated).toBe(!vector.fits);
      } else if (vector.fits) {
        // A larger font scale may shrink, never truncate what fits.
        expect(truncated).toBe(false);
      }
    }
  });

  it("shows the long brand label of the issue in full on a 3 × 2 widget", () => {
    const placement = { x: 0, y: 0, w: 3, h: 2 };
    const layout = labelLayout(
      "Proceeds · Paperstand – Magazine reader",
      contentBox(placement, true).width,
      typeScaleFor("metric", placement, 1, true),
    );
    expect(layout.title.text).toBe("Proceeds");
    expect(layout.resource?.text).toBe("Paperstand – Magazine reader");
    expect(layout.title.truncated).toBe(false);
    expect(layout.resource?.truncated).toBe(false);
  });
});

describe("fitValue", () => {
  it("grows to the largest size that fits", () => {
    const value = fitValue("1,284", "1.3K", 1000, { min: 64, max: 120 });
    expect(value).toEqual({ text: "1,284", size: 120 });
  });

  it("switches to the compact form before going below the minimum", () => {
    const full = "1,234,567,890";
    const width = estimateTextWidth(full, 64, "semibold") - 1;
    const value = fitValue(full, "1.2B", width, { min: 64, max: 120 });
    expect(value.text).toBe("1.2B");
    expect(value.size).toBeGreaterThanOrEqual(64);
  });

  it("never goes below the minimum, even when nothing fits", () => {
    const value = fitValue("1,234,567,890", "1.2B", 10, { min: 64, max: 120 });
    expect(value).toEqual({ text: "1.2B", size: 64 });
  });
});

describe("metricWidgetLayout", () => {
  const base = {
    label: "Downloads · Wurfel",
    value: { full: "12,480", compact: "12.5K" },
    periodText: "Last 7 days · Total",
    change: {
      full: "▲ +8.2% vs previous 7 days",
      short: "▲ +8.2%",
      comparison: "vs previous 7 days",
    },
    noticeText: null,
    sourceText: "App Store Connect",
    showHeader: true,
    fontScale: 1,
    showSparkline: true,
  };

  it("shows everything on a large widget", () => {
    const layout = metricWidgetLayout({
      ...base,
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    expect(layout.showPeriod).toBe(true);
    expect(layout.showSource).toBe(true);
    expect(layout.sparkline).toBeGreaterThan(40);
    expect(layout.value.size).toBeGreaterThan(STUDIO_TEXT_MINIMUMS.value);
  });

  it("keeps label, value, change and notice on the smallest widget", () => {
    for (const fontScale of [1, 1.15, 1.3]) {
      const layout = metricWidgetLayout({
        ...base,
        label: "Proceeds · Paperstand – Magazine reader",
        noticeText: "Connection needs new credentials",
        fontScale,
        placement: { x: 0, y: 0, w: 3, h: 2 },
      });
      expect(layout.value.size).toBeGreaterThanOrEqual(
        STUDIO_TEXT_MINIMUMS.value,
      );
      expect(layout.label.title.truncated).toBe(false);
      expect(layout.label.resource?.truncated).toBe(false);
      expect(layout.sizes.small).toBeGreaterThanOrEqual(
        STUDIO_TEXT_MINIMUMS.any,
      );
      expect(layout.sizes.change).toBeGreaterThanOrEqual(
        STUDIO_TEXT_MINIMUMS.change,
      );
    }
  });

  it("drops the sparkline before the period line when space runs out", () => {
    const small = metricWidgetLayout({
      ...base,
      placement: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(small.sparkline).toBe(0);
    const medium = metricWidgetLayout({
      ...base,
      placement: { x: 0, y: 0, w: 3, h: 4 },
    });
    expect(medium.showPeriod).toBe(true);
    expect(medium.sparkline).toBeGreaterThan(0);
  });

  it("gives up the change line before the label or the value", () => {
    const layout = metricWidgetLayout({
      ...base,
      label: "Proceeds · Paperstand – Magazine reader",
      placement: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(layout.label.resource?.lines).toBe(2);
    expect(layout.label.resource?.truncated).toBe(false);
    expect(layout.changeText).toBeNull();
    expect(layout.value.size).toBe(STUDIO_TEXT_MINIMUMS.value);
    const roomy = metricWidgetLayout({
      ...base,
      placement: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(roomy.changeText).toBe("▲ +8.2% vs previous 7 days");
  });

  it("drops the comparison rather than wrap the change line", () => {
    const change = {
      full: "▲ +1,234.5% vs the same period of the previous year",
      short: "▲ +1,234.5%",
      comparison: "vs the same period of the previous year",
    };
    const narrow = metricWidgetLayout({
      ...base,
      change,
      placement: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(narrow.changeText).toBe(change.short);
    const wide = metricWidgetLayout({
      ...base,
      change,
      placement: { x: 0, y: 0, w: 8, h: 2 },
    });
    expect(wide.changeText).toBe(change.full);
  });

  it("keeps the comparison on its own line when the change line would wrap", () => {
    // The Apple TV case (#245): a 3 × 4 metric widget whose change line
    // with its comparison takes two lines at the change size.
    const input = {
      ...base,
      label: "Downloads · All apps",
      value: { full: "718", compact: "718" },
      periodText: "Last 30 days · Total",
      change: {
        full: "▼ −28% vs previous 30 days",
        short: "▼ −28%",
        comparison: "vs previous 30 days",
      },
      placement: { x: 0, y: 0, w: 3, h: 4 },
    };
    for (const fontScale of [1, 1.15, 1.3]) {
      const layout = metricWidgetLayout({ ...input, fontScale });
      expect(layout.changeText).toBe("▼ −28%");
      expect(layout.comparisonText).toBe("vs previous 30 days");
      expect(layout.sizes.comparison).toBeGreaterThanOrEqual(
        STUDIO_TEXT_MINIMUMS.any,
      );
      expect(layout.showPeriod).toBe(true);
    }
    // Wide enough: one line, no second one.
    const wide = metricWidgetLayout({
      ...input,
      placement: { x: 0, y: 0, w: 4, h: 4 },
    });
    expect(wide.changeText).toBe("▼ −28% vs previous 30 days");
    expect(wide.comparisonText).toBeNull();
  });

  it("drops the comparison line before the period line on a short widget", () => {
    const layout = metricWidgetLayout({
      ...base,
      change: {
        full: "▼ −28% vs previous 30 days",
        short: "▼ −28%",
        comparison: "vs previous 30 days",
      },
      placement: { x: 0, y: 0, w: 3, h: 2 },
    });
    expect(layout.changeText).toBe("▼ −28%");
    expect(layout.comparisonText).toBeNull();
  });

  it("never splits a change without a comparison", () => {
    const layout = metricWidgetLayout({
      ...base,
      change: {
        full: "No data to compare vs the same period of the previous year",
        short: "No comparison",
        comparison: null,
      },
      placement: { x: 0, y: 0, w: 3, h: 4 },
    });
    expect(layout.changeText).toBe("No comparison");
    expect(layout.comparisonText).toBeNull();
  });

  it("leaves the sparkline out when it is switched off", () => {
    const layout = metricWidgetLayout({
      ...base,
      showSparkline: false,
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    expect(layout.sparkline).toBe(0);
    expect(layout.showSource).toBe(true);
  });
});

describe("chartWidgetLayout", () => {
  it("gives the chart the rest of the widget with axis labels of 24+", () => {
    for (const fontScale of [1, 1.3]) {
      const layout = chartWidgetLayout({
        type: "line",
        label: "Clicks · example.com",
        value: { full: "4,812", compact: "4.8K" },
        noticeText: null,
        placement: { x: 0, y: 0, w: 4, h: 3 },
        showHeader: true,
        fontScale,
      });
      expect(layout.sizes.axis).toBeGreaterThanOrEqual(24);
      // Room for the plot and its two axis label rows.
      expect(layout.chart.height).toBeGreaterThan(3 * layout.sizes.axis);
      expect(layout.value?.size).toBeGreaterThanOrEqual(64);
    }
  });

  it("has no headline value for a bar widget", () => {
    const layout = chartWidgetLayout({
      type: "bar",
      label: "Downloads by app",
      value: null,
      noticeText: "Source unreachable",
      placement: { x: 0, y: 0, w: 4, h: 3 },
      showHeader: false,
      fontScale: 1,
    });
    expect(layout.value).toBeNull();
    expect(layout.sizes.resource).toBe(30);
  });
});
