import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildStudioLayoutVectors } from "./studio-layout-vectors.js";
import {
  STUDIO_GRID,
  STUDIO_MIN_WIDGET_SIZE,
  STUDIO_TEXT_MINIMUMS,
  STUDIO_WIDGET_TYPES,
  clockLayout,
  compactNumber,
  estimateTextWidth,
  formatUtcOffset,
  findOverlaps,
  fitTextSize,
  isInsideGrid,
  labelFit,
  labelFits,
  labelParts,
  legacyGrid,
  legacyLayout,
  meetsMinimumSize,
  parseTextWidget,
  placementsOverlap,
  studioFrame,
  studioLayout,
  tableChangeKind,
  tableLayout,
  tableRowLabel,
  tableRowsShown,
  textWidgetSizes,
  widgetRect,
  widgetTypeScale,
  wrappedLineCount,
  zoneCity,
  zoneLabel,
  zoneLabelSample,
} from "./studio-layout.js";

const HD = { width: 1920, height: 1080 };
const UHD = { width: 3840, height: 2160 };

describe("studioFrame and widgetRect", () => {
  it("puts the header in the top 7 % and the grid below it", () => {
    const frame = studioFrame(HD, true);
    expect(frame.unit).toBe(1);
    expect(frame.header!.height).toBeCloseTo(75.6, 9);
    expect(frame.grid.x).toBe(32);
    expect(frame.grid.y).toBeCloseTo(75.6 + 32, 9);
    expect(frame.grid.width).toBe(1856);
    expect(frame.grid.height).toBeCloseTo(1080 - 75.6 - 64, 9);
  });

  it("lets the grid fill the canvas without the header", () => {
    const frame = studioFrame(HD, false);
    expect(frame.header).toBeNull();
    expect(frame.grid).toEqual({ x: 32, y: 32, width: 1856, height: 1016 });
  });

  it("fills the grid area with the whole grid", () => {
    for (const showHeader of [true, false]) {
      const { grid } = studioFrame(HD, showHeader);
      const all = widgetRect(
        { x: 0, y: 0, w: STUDIO_GRID.columns, h: STUDIO_GRID.rows },
        HD,
        showHeader,
      );
      expect(all.x).toBeCloseTo(grid.x, 9);
      expect(all.y).toBeCloseTo(grid.y, 9);
      expect(all.width).toBeCloseTo(grid.width, 9);
      expect(all.height).toBeCloseTo(grid.height, 9);
    }
  });

  it("leaves one gap between neighbours", () => {
    const left = widgetRect({ x: 0, y: 0, w: 3, h: 2 }, HD, false);
    const right = widgetRect({ x: 3, y: 0, w: 3, h: 2 }, HD, false);
    expect(right.x - (left.x + left.width)).toBeCloseTo(16, 9);
    // 12 columns: (1856 − 11 × 16) / 12 = 140 per cell.
    expect(left.width).toBeCloseTo(3 * 140 + 2 * 16, 9);
  });

  it("scales with the canvas: 4K is 1080p doubled", () => {
    const placement = { x: 3, y: 2, w: 4, h: 3 };
    const hd = widgetRect(placement, HD, true);
    const uhd = widgetRect(placement, UHD, true);
    expect(uhd.x).toBeCloseTo(hd.x * 2, 9);
    expect(uhd.y).toBeCloseTo(hd.y * 2, 9);
    expect(uhd.width).toBeCloseTo(hd.width * 2, 9);
    expect(uhd.height).toBeCloseTo(hd.height * 2, 9);
  });
});

describe("placement rules", () => {
  it("keeps widgets inside the 12 × 8 grid in whole cells", () => {
    expect(isInsideGrid({ x: 0, y: 0, w: 12, h: 8 })).toBe(true);
    expect(isInsideGrid({ x: 11, y: 7, w: 1, h: 1 })).toBe(true);
    expect(isInsideGrid({ x: 11, y: 0, w: 2, h: 1 })).toBe(false);
    expect(isInsideGrid({ x: 0, y: 7, w: 1, h: 2 })).toBe(false);
    expect(isInsideGrid({ x: -1, y: 0, w: 1, h: 1 })).toBe(false);
    expect(isInsideGrid({ x: 0, y: 0, w: 0, h: 1 })).toBe(false);
    expect(isInsideGrid({ x: 0.5, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("has the minimum sizes of ADR 0015", () => {
    expect(STUDIO_MIN_WIDGET_SIZE).toEqual({
      metric: { w: 3, h: 2 },
      line: { w: 4, h: 3 },
      bar: { w: 4, h: 3 },
      image: { w: 1, h: 1 },
      text: { w: 2, h: 1 },
      clock: { w: 2, h: 1 },
      table: { w: 4, h: 4 },
    });
    expect(meetsMinimumSize("metric", { x: 0, y: 0, w: 3, h: 2 })).toBe(true);
    expect(meetsMinimumSize("metric", { x: 0, y: 0, w: 2, h: 4 })).toBe(false);
    expect(meetsMinimumSize("line", { x: 0, y: 0, w: 4, h: 2 })).toBe(false);
  });

  it("finds overlaps but not touching edges", () => {
    const a = { x: 0, y: 0, w: 3, h: 2 };
    expect(placementsOverlap(a, { x: 3, y: 0, w: 3, h: 2 })).toBe(false);
    expect(placementsOverlap(a, { x: 0, y: 2, w: 3, h: 2 })).toBe(false);
    expect(placementsOverlap(a, { x: 2, y: 1, w: 3, h: 2 })).toBe(true);
    expect(
      findOverlaps([
        a,
        { x: 3, y: 0, w: 3, h: 2 },
        { x: 0, y: 0, w: 12, h: 8 },
      ]),
    ).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });
});

describe("widgetTypeScale", () => {
  it("never goes below the minimum text sizes", () => {
    for (const type of STUDIO_WIDGET_TYPES) {
      const minimum = STUDIO_MIN_WIDGET_SIZE[type];
      for (const fontScale of [0.5, 1, 1.15, 1.3]) {
        const sizes = widgetTypeScale(
          type,
          { x: 0, y: 0, ...minimum },
          { fontScale },
        );
        for (const size of Object.values(sizes)) {
          expect(size).toBeGreaterThanOrEqual(STUDIO_TEXT_MINIMUMS.any);
        }
        if (sizes.title !== undefined)
          expect(sizes.title).toBeGreaterThanOrEqual(30);
        if (sizes.resource !== undefined)
          expect(sizes.resource).toBeGreaterThanOrEqual(30);
        if (sizes.change !== undefined)
          expect(sizes.change).toBeGreaterThanOrEqual(28);
        if (sizes.valueMin !== undefined)
          expect(sizes.valueMin).toBeGreaterThanOrEqual(64);
        if (sizes.clockMin !== undefined)
          expect(sizes.clockMin).toBeGreaterThanOrEqual(56);
      }
    }
  });

  it("does not let a font scale below 1 lower a size", () => {
    const placement = { x: 0, y: 0, w: 3, h: 2 };
    expect(widgetTypeScale("metric", placement, { fontScale: 0.8 })).toEqual(
      widgetTypeScale("metric", placement, { fontScale: 1 }),
    );
  });

  it("multiplies the minimums by the font scale", () => {
    const sizes = widgetTypeScale(
      "metric",
      { x: 0, y: 0, w: 3, h: 2 },
      { fontScale: 1.3 },
    );
    expect(sizes.title).toBeCloseTo(39, 9);
    expect(sizes.change).toBeCloseTo(36.4, 9);
    expect(sizes.valueMin).toBeCloseTo(83.2, 9);
  });

  it("grows the value with the widget", () => {
    const small = widgetTypeScale("metric", { x: 0, y: 0, w: 3, h: 2 });
    const large = widgetTypeScale("metric", { x: 0, y: 0, w: 6, h: 4 });
    expect(small.valueMax).toBe(64);
    expect(large.valueMax!).toBeGreaterThan(100);
  });

  it("sizes text widgets by their size option", () => {
    expect(textWidgetSizes("body")).toEqual({
      paragraph: 32,
      heading1: 56,
      heading2: 40,
    });
    expect(textWidgetSizes("display")).toEqual({
      paragraph: 96,
      heading1: 144,
      heading2: 120,
    });
  });
});

describe("text measurement", () => {
  it("is linear in the font size and wider for heavier weights", () => {
    expect(estimateTextWidth("Downloads", 60)).toBeCloseTo(
      estimateTextWidth("Downloads", 30) * 2,
      9,
    );
    expect(estimateTextWidth("Downloads", 30, "semibold")).toBeGreaterThan(
      estimateTextWidth("Downloads", 30),
    );
    expect(estimateTextWidth("WWW", 30)).toBeGreaterThan(
      estimateTextWidth("iii", 30),
    );
  });

  it("counts characters by code point, unknown ones as a full em", () => {
    expect(estimateTextWidth("🚀", 10)).toBe(10);
    expect(estimateTextWidth("日本", 10)).toBe(20);
  });

  it("wraps at spaces and breaks words that are longer than a line", () => {
    expect(wrappedLineCount("", 100, 30)).toBe(0);
    expect(wrappedLineCount("Downloads", 1000, 30)).toBe(1);
    expect(wrappedLineCount("Downloads Downloads", 200, 30)).toBe(2);
    // 30 × 0.62 = 18.6 per digit: 10 digits per 200.
    expect(wrappedLineCount("0".repeat(25), 200, 30)).toBe(3);
  });

  it("fits a value between its bounds or answers null", () => {
    const width = estimateTextWidth("1,284", 1, "bold");
    expect(
      fitTextSize("1,284", 10_000, { min: 64, max: 160, weight: "bold" }),
    ).toBe(160);
    expect(
      fitTextSize("1,284", width * 100, { min: 64, max: 160, weight: "bold" }),
    ).toBeCloseTo(100, 9);
    expect(
      fitTextSize("12,345,678", 100, { min: 64, max: 160, weight: "bold" }),
    ).toBeNull();
  });
});

describe("label fit", () => {
  it("splits the metric and the resource like tileLabel joins them", () => {
    expect(labelParts("Downloads · Wurfel")).toEqual({
      title: "Downloads",
      resource: "Wurfel",
    });
    expect(labelParts("My title")).toEqual({
      title: "My title",
      resource: null,
    });
    expect(labelParts("Downloads ·  ")).toEqual({
      title: "Downloads ·  ",
      resource: null,
    });
  });

  it("fits a usual label on the smallest metric widget", () => {
    expect(
      labelFits("Downloads · Wurfel", { type: "metric", w: 3, h: 2 }),
    ).toBe(true);
    expect(
      studioLayout.fits("Proceeds · All apps", { type: "metric", w: 3, h: 2 }),
    ).toBe(true);
  });

  it("flags a resource name that needs more than two lines", () => {
    const label =
      "Visitors · my-very-long-vercel-project-name-for-the-marketing-site-and-blog";
    const fit = labelFit(label, { type: "metric", w: 3, h: 2 });
    expect(fit.titleLines).toBe(1);
    expect(fit.resourceLines).toBeGreaterThan(2);
    expect(fit.fits).toBe(false);
    // A wider widget fixes it.
    expect(labelFits(label, { type: "metric", w: 6, h: 2 })).toBe(true);
  });

  it("needs more room at a larger font scale", () => {
    const label =
      "Ratings and reviews · Wurfel: Würfel-Spiel für die ganze Familie";
    const normal = labelFit(label, { type: "metric", w: 3, h: 2 });
    const large = labelFit(
      label,
      { type: "metric", w: 3, h: 2 },
      { fontScale: 1.3 },
    );
    expect(large.resourceLines).toBeGreaterThanOrEqual(normal.resourceLines);
  });

  it("fits German scope labels on the smallest widget (#256)", () => {
    for (const label of [
      "Downloads · Alle Apps",
      "Proceeds · Alle Ressourcen",
      "Page views · Alle Properties",
    ]) {
      for (const fontScale of [1, 1.15, 1.3]) {
        expect(
          labelFits(label, { type: "metric", w: 3, h: 2 }, { fontScale }),
          `${label} @${fontScale}`,
        ).toBe(true);
      }
    }
  });

  it("always fits widgets without a label", () => {
    expect(labelFits("x".repeat(500), { type: "text", w: 2, h: 1 })).toBe(true);
  });
});

describe("tableLayout (ADR 0019 section 6)", () => {
  // A 4 × 4 widget's content box at 16:9 with the header.
  const box = { width: 560, height: 414.2 };

  it("fits six rows at font scale 1 and four at 1.3 on a 4 × 4 table", () => {
    expect(tableLayout({ label: "Page views", ...box }).rowCapacity).toBe(6);
    expect(
      tableLayout({ label: "Page views", ...box, fontScale: 1.3 }).rowCapacity,
    ).toBe(4);
    // The smallest limit (3) fits at every font scale with a resource line.
    expect(
      tableLayout({ label: "Page views · netrics.so", ...box, fontScale: 1.3 })
        .rowCapacity,
    ).toBe(3);
  });

  it("uses the cell and column head roles of the type scale", () => {
    const layout = tableLayout({ label: "Page views", ...box });
    expect(layout.sizes).toMatchObject({ cell: 28, columnHead: 24 });
    expect(layout.rowPitch).toBeCloseTo(28 * 1.15 + 12, 9);
    expect(STUDIO_TEXT_MINIMUMS.cell).toBe(28);
    expect(
      widgetTypeScale("table", { x: 0, y: 0, w: 4, h: 4 }, { fontScale: 1.3 }),
    ).toMatchObject({ cell: 28 * 1.3, columnHead: 24 * 1.3, any: 24 * 1.3 });
  });

  it("sizes the value column to the widest value and gives the label the rest", () => {
    const values = [
      { full: "8,120", compact: "8.1K" },
      { full: "512", compact: "512" },
    ];
    const layout = tableLayout({ label: "Page views", ...box, values });
    const value = estimateTextWidth("8,120", 28, "semibold");
    const change = estimateTextWidth("+999 %", 28, "semibold");
    expect(layout.compact).toBe(false);
    expect(layout.columns.value).toBeCloseTo(value, 9);
    expect(layout.columns.change).toBeCloseTo(change, 9);
    expect(layout.columns.label).toBeCloseTo(560 - value - change - 32, 9);
    const without = tableLayout({
      label: "Page views",
      ...box,
      values,
      showChange: false,
    });
    expect(without.columns.change).toBe(0);
    expect(without.columns.label).toBeCloseTo(560 - value - 16, 9);
  });

  it("switches to compact values when the label column would get too narrow", () => {
    const layout = tableLayout({
      label: "Revenue",
      width: 404,
      height: 414.2,
      values: [{ full: "$1,234,567.89", compact: "$1.2M" }],
    });
    expect(layout.compact).toBe(true);
    expect(layout.columns.value).toBeCloseTo(
      estimateTextWidth("$1.2M", 28, "semibold"),
      9,
    );
  });

  it("shows the least of limit, rows and capacity", () => {
    expect(tableRowsShown(8, 10, 4)).toBe(4);
    expect(tableRowsShown(5, 3, 6)).toBe(3);
    expect(tableRowsShown(5, 8, 6)).toBe(5);
  });

  it("shrinks a row label to 24 u before it ends with an ellipsis", () => {
    const sizes = { cell: 28, cellMin: 24 };
    expect(tableRowLabel("/pricing", 370, sizes)).toEqual({
      size: 28,
      truncated: false,
    });
    const long = "/blog/how-we-built-a-dashboard";
    const shrunk = tableRowLabel(long, 400, sizes);
    expect(shrunk.truncated).toBe(false);
    expect(shrunk.size).toBeLessThan(28);
    expect(shrunk.size).toBeGreaterThanOrEqual(24);
    expect(tableRowLabel(`${long}-for-the-office-tv`, 370, sizes)).toEqual({
      size: 24,
      truncated: true,
    });
  });

  it("tells a ratio, a new row and no change apart", () => {
    expect(
      tableChangeKind({ value: 8120, previousValue: 7250, ratio: 0.12 }),
    ).toBe("ratio");
    expect(tableChangeKind({ value: 5, previousValue: 0, ratio: null })).toBe(
      "new",
    );
    expect(
      tableChangeKind({ value: 5, previousValue: null, ratio: null }),
    ).toBe("new");
    expect(
      tableChangeKind({ value: 0, previousValue: null, ratio: null }),
    ).toBe("none");
    expect(
      tableChangeKind({ value: null, previousValue: 3, ratio: null }),
    ).toBe("none");
  });
});

describe("legacyLayout", () => {
  it("matches tvGrid for up to 16 tiles where it stays within 4 × 4", () => {
    // tvGrid picks these today (apps/web/src/lib/tv-grid.test.ts).
    expect(legacyGrid(1)).toEqual({ columns: 1, rows: 1 });
    expect(legacyGrid(2)).toEqual({ columns: 2, rows: 1 });
    expect(legacyGrid(3)).toEqual({ columns: 3, rows: 1 });
    expect(legacyGrid(4)).toEqual({ columns: 2, rows: 2 });
    expect(legacyGrid(6)).toEqual({ columns: 3, rows: 2 });
    expect(legacyGrid(8)).toEqual({ columns: 4, rows: 2 });
    expect(legacyGrid(9)).toEqual({ columns: 3, rows: 3 });
    expect(legacyGrid(12)).toEqual({ columns: 4, rows: 3 });
    expect(legacyGrid(16)).toEqual({ columns: 4, rows: 4 });
  });

  it("is one empty slide without tiles", () => {
    expect(legacyLayout(0)).toEqual([[]]);
  });

  it("places tiles in reading order on whole cells", () => {
    expect(legacyLayout(4)).toEqual([
      [
        { x: 0, y: 0, w: 6, h: 4 },
        { x: 6, y: 0, w: 6, h: 4 },
        { x: 0, y: 4, w: 6, h: 4 },
        { x: 6, y: 4, w: 6, h: 4 },
      ],
    ]);
    // Three rows split 8 as 2, 3, 3.
    expect(legacyLayout(9)[0]!.map((p) => [p.y, p.h])).toEqual([
      [0, 2],
      [0, 2],
      [0, 2],
      [2, 3],
      [2, 3],
      [2, 3],
      [5, 3],
      [5, 3],
      [5, 3],
    ]);
  });

  it("keeps every widget valid, at least 3 × 2 and without overlaps", () => {
    for (let tiles = 0; tiles <= 48; tiles++) {
      const slides = legacyLayout(tiles);
      expect(slides.flat()).toHaveLength(tiles);
      expect(slides.length).toBe(Math.max(1, Math.ceil(tiles / 16)));
      for (const slide of slides) {
        expect(slide.length).toBeLessThanOrEqual(16);
        expect(findOverlaps(slide)).toEqual([]);
        for (const placement of slide) {
          expect(isInsideGrid(placement)).toBe(true);
          expect(meetsMinimumSize("metric", placement)).toBe(true);
        }
      }
    }
  });

  it("puts 16 tiles on the first slide and the rest on a second", () => {
    expect(legacyLayout(17).map((slide) => slide.length)).toEqual([16, 1]);
    expect(legacyLayout(24).map((slide) => slide.length)).toEqual([16, 8]);
  });
});

describe("parseTextWidget", () => {
  const plain = (text: string) => ({ text, bold: false, italic: false });

  it("splits paragraphs at blank lines and keeps line breaks", () => {
    expect(parseTextWidget("One\nTwo\n\nThree")).toEqual([
      { kind: "paragraph", lines: [[plain("One")], [plain("Two")]] },
      { kind: "paragraph", lines: [[plain("Three")]] },
    ]);
  });

  it("reads # and ## headings, everything else literally", () => {
    expect(parseTextWidget("# Wurfel\n## Sales\n### Three")).toEqual([
      { kind: "heading", level: 1, spans: [plain("Wurfel")] },
      { kind: "heading", level: 2, spans: [plain("Sales")] },
      { kind: "paragraph", lines: [[plain("### Three")]] },
    ]);
  });

  it("styles bold and italic, nested", () => {
    expect(parseTextWidget("Up **12% *now*** and *calm*")).toEqual([
      {
        kind: "paragraph",
        lines: [
          [
            plain("Up "),
            { text: "12% ", bold: true, italic: false },
            { text: "now", bold: true, italic: true },
            plain(" and "),
            { text: "calm", bold: false, italic: true },
          ],
        ],
      },
    ]);
  });

  it("leaves unmatched or spaced markers literal", () => {
    expect(parseTextWidget("2 * 3 * 4")).toEqual([
      { kind: "paragraph", lines: [[plain("2 * 3 * 4")]] },
    ]);
    expect(parseTextWidget("**open")).toEqual([
      { kind: "paragraph", lines: [[plain("**open")]] },
    ]);
  });

  it("never interprets HTML", () => {
    const source = "<b>x</b><script>alert(1)</script>";
    expect(parseTextWidget(source)).toEqual([
      { kind: "paragraph", lines: [[plain(source)]] },
    ]);
  });
});

describe("compactNumber", () => {
  it.each([
    [0, "0"],
    [3.14159, "3.14"],
    [999, "999"],
    [1234, "1.2K"],
    [12_345, "12.3K"],
    [12_350, "12.4K"],
    [999_950, "1M"],
    [4_200_000, "4.2M"],
    [1.5e9, "1.5B"],
    [2.75e12, "2.8T"],
    [-12_345, "-12.3K"],
  ])("%d → %s", (value, text) => {
    expect(compactNumber(value)).toBe(text);
  });

  it("agrees with the dashboard's en-US compact notation from 1,000 up", () => {
    const format = new Intl.NumberFormat("en-US", {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    const values = [
      1000, 1049, 1050, 1099, 1950, 9999, 10_000, 12_345, 99_949, 99_950,
      123_456, 999_949, 999_950, 1_000_000, 1_049_999, 1_050_000, 12_345_678,
      999_999_999, 1e9, 1.25e9, 7.77e11, 2.75e12, -1284, -99_950,
    ];
    for (let i = 1; i <= 2000; i++) {
      values.push(i * 517, i * 49_999, i * 1_000_003);
    }
    for (const value of values) {
      expect(compactNumber(value)).toBe(format.format(value));
    }
  });
});

describe("zoneLabel", () => {
  const summer = new Date("2026-07-04T12:00:00Z");
  const winter = new Date("2026-01-10T12:00:00Z");

  it("names the city and the offset at the time, following DST", () => {
    expect(zoneLabel("Europe/Berlin", summer)).toBe("Berlin \u00b7 UTC+2");
    expect(zoneLabel("Europe/Berlin", winter)).toBe("Berlin \u00b7 UTC+1");
    expect(zoneLabel("America/Sao_Paulo", summer)).toBe(
      "Sao Paulo \u00b7 UTC\u22123",
    );
    expect(zoneLabel("Asia/Kolkata", summer)).toBe("Kolkata \u00b7 UTC+5:30");
    expect(zoneLabel("Asia/Kathmandu", summer)).toBe(
      "Kathmandu \u00b7 UTC+5:45",
    );
    expect(zoneLabel("America/Argentina/Buenos_Aires", summer)).toBe(
      "Buenos Aires \u00b7 UTC\u22123",
    );
  });

  it("switches at the daylight saving change", () => {
    expect(zoneLabel("Europe/Berlin", new Date("2026-03-29T00:59:59Z"))).toBe(
      "Berlin \u00b7 UTC+1",
    );
    expect(zoneLabel("Europe/Berlin", new Date("2026-03-29T01:00:00Z"))).toBe(
      "Berlin \u00b7 UTC+2",
    );
  });

  it("shows zones without a place as their offset", () => {
    expect(zoneLabel("Etc/UTC", summer)).toBe("UTC");
    expect(zoneLabel("UTC", summer)).toBe("UTC");
    expect(zoneLabel("Etc/GMT+3", summer)).toBe("UTC\u22123");
    expect(zoneCity("Etc/UTC")).toBeNull();
  });

  it("shows an unknown zone by its city, never throwing", () => {
    expect(zoneLabel("Mars/Olympus_Mons", summer)).toBe("Olympus Mons");
  });

  it("formats offsets with a minus sign and minutes only when needed", () => {
    expect(formatUtcOffset(0)).toBe("UTC");
    expect(formatUtcOffset(120)).toBe("UTC+2");
    expect(formatUtcOffset(-210)).toBe("UTC\u22123:30");
    expect(formatUtcOffset(825)).toBe("UTC+13:45");
  });

  it("measures with a sample at least as wide as any offset", () => {
    for (const minutes of [0, 60, -180, 330, 345, -570, 765, 840]) {
      const label = `Berlin \u00b7 ${formatUtcOffset(minutes)}`;
      expect(estimateTextWidth(label, 24)).toBeLessThanOrEqual(
        estimateTextWidth(zoneLabelSample("Europe/Berlin"), 24),
      );
    }
  });
});

describe("clockLayout", () => {
  const boxOf = (w: number, h: number) => {
    const rect = widgetRect({ x: 0, y: 0, w, h }, HD, true);
    return { width: rect.width - 48, height: rect.height - 48 };
  };
  const layout = (
    w: number,
    h: number,
    options: Partial<Parameters<typeof clockLayout>[0]> = {},
  ) =>
    clockLayout({
      placement: { x: 0, y: 0, w, h },
      box: boxOf(w, h),
      time: "14:05",
      showDate: true,
      dateStyle: "short",
      zone: null,
      ...options,
    });

  it("shows time, long date and zone in a 3 × 3 clock", () => {
    const result = layout(3, 3, { dateStyle: "long", zone: "Europe/Berlin" });
    expect(result.hidden).toBe(false);
    expect(result.zone).toBe(24);
    expect(result.date).toBeGreaterThanOrEqual(24);
    expect(result.date).toBeLessThanOrEqual(30);
    expect(result.time).toBeGreaterThan(96);
  });

  it("shows only the time in a 2 × 1 clock with both options", () => {
    const result = layout(2, 1, { dateStyle: "long", zone: "Europe/Berlin" });
    expect(result).toMatchObject({ date: null, zone: null, hidden: true });
    expect(result.time).toBe(STUDIO_TEXT_MINIMUMS.clock);
  });

  it("drops the zone line before the date", () => {
    // 3 × 1 has room for no line; find a height with room for one.
    const box = { width: 400, height: 56 + 30 * 1.15 + 1 };
    const result = clockLayout({
      placement: { x: 0, y: 0, w: 3, h: 2 },
      box,
      time: "14:05",
      showDate: true,
      dateStyle: "short",
      zone: "Europe/Berlin",
    });
    expect(result).toMatchObject({ date: 30, zone: null, hidden: true });
  });

  it("keeps a short-date clock as before: time and date at 30", () => {
    const result = layout(3, 2);
    expect(result).toMatchObject({ date: 30, zone: null, hidden: false });
  });

  it("hides the long date where even 24 units are too wide", () => {
    const result = layout(2, 2, { dateStyle: "long" });
    expect(result).toMatchObject({ date: null, hidden: true });
    expect(layout(2, 2)).toMatchObject({ date: 30, hidden: false });
  });

  it("does not report a part that is off", () => {
    expect(layout(2, 1, { showDate: false }).hidden).toBe(false);
  });

  it("scales every line with the font scale", () => {
    const result = layout(4, 3, { zone: "Etc/UTC", fontScale: 1.3 });
    expect(result.zone).toBeCloseTo(24 * 1.3, 9);
    expect(result.date).toBeCloseTo(30 * 1.3, 9);
    expect(result.time).toBeGreaterThanOrEqual(56 * 1.3);
  });
});

describe("test vectors", () => {
  const path = new URL("../test-vectors/studio-layout.json", import.meta.url);

  it("match the checked-in file (pnpm vectors:studio regenerates it)", () => {
    const vectors = buildStudioLayoutVectors();
    const text = `${JSON.stringify(vectors, null, 2)}\n`;
    if (process.env.UPDATE_STUDIO_VECTORS === "1") {
      writeFileSync(path, text);
    }
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
  });
});
