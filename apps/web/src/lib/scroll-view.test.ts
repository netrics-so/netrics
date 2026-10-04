import { describe, expect, it } from "vitest";

import {
  STUDIO_LABEL_MAX_LINES,
  scrollLayout,
  studioReadingOrder,
  type LayoutWidget,
} from "@netrics/domain";

import {
  SCROLL_TYPE,
  cardUnits,
  scrollChartHeight,
  scrollClockSize,
  scrollItemWidth,
  scrollLabelLines,
  scrollSections,
  scrollValue,
} from "./scroll-view";

// A 16:9 slide: two metrics side by side on top, a clock right of them, a
// wide line chart and a bar chart below, a full-width text at the bottom.
const widgets: LayoutWidget[] = [
  { id: "line", type: "line", x: 0, y: 3, w: 8, h: 3 },
  { id: "m2", type: "metric", x: 4, y: 0, w: 4, h: 3 },
  { id: "clock", type: "clock", x: 8, y: 0, w: 4, h: 3 },
  { id: "bar", type: "bar", x: 8, y: 3, w: 4, h: 3 },
  { id: "m1", type: "metric", x: 0, y: 0, w: 4, h: 3 },
  { id: "text", type: "text", x: 0, y: 6, w: 12, h: 2 },
];

describe("scroll view sections", () => {
  const slides = [
    { id: "a", enabled: true, widgets },
    { id: "b", enabled: false, widgets },
    { id: "c", enabled: true, widgets: [] },
  ];

  it("has every enabled slide as a section, in order, disabled ones skipped", () => {
    const sections = scrollSections(slides, 360);
    expect(sections.map((section) => section.slide.id)).toEqual(["a", "c"]);
    // The index keeps the slide's place ("Slide 3" for a nameless one).
    expect(sections.map((section) => section.index)).toEqual([0, 2]);
  });

  it("shows every widget, clocks included, in the primary layout's reading order", () => {
    const [section] = scrollSections(slides, 360);
    const ids = section!.layout.items.map((item) => item.id);
    expect(ids).toEqual(studioReadingOrder(widgets).map((w) => w.id));
    expect(ids).toEqual(["m1", "m2", "clock", "line", "bar", "text"]);
  });

  it("is exactly the domain's scrollLayout at the view's width", () => {
    for (const width of [320, 360, 390, 768, 820, 1072, 1280]) {
      expect(scrollSections(slides, width)[0]!.layout).toEqual(
        scrollLayout(widgets, width),
      );
    }
  });

  it("uses 1, 2 and 3 columns for phone, tablet and desktop widths", () => {
    const columns = (width: number) =>
      scrollSections(slides, width)[0]!.layout.columns;
    expect(columns(360)).toBe(1);
    expect(columns(772)).toBe(2); // 820 px tablet less the page padding
    expect(columns(1072)).toBe(3); // the desktop page's content width
  });

  it("charts and wide text span the row; metrics and clocks take a column", () => {
    const items = scrollSections(slides, 1072)[0]!.layout.items;
    const span = Object.fromEntries(items.map((item) => [item.id, item.span]));
    expect(span).toEqual({ m1: 1, m2: 1, clock: 1, line: 3, bar: 3, text: 3 });
    const heights = Object.fromEntries(
      items.map((item) => [item.id, item.height]),
    );
    expect(heights).toMatchObject({
      line: "chart",
      bar: "chart",
      m1: "content",
    });
  });
});

describe("scroll view sizes", () => {
  it("shares the width between columns and gaps", () => {
    const layout = { columns: 3, contentWidth: 1072 };
    const one = scrollItemWidth(layout, 1);
    const all = scrollItemWidth(layout, 3);
    expect(one * 3 + 2 * 12).toBeCloseTo(all);
    expect(all).toBe(1072 - 24);
    // A 360 px phone: one card across, inside the section's padding.
    expect(scrollItemWidth({ columns: 1, contentWidth: 336 }, 1)).toBe(312);
  });

  it("draws charts 16:9 of their width, at least 200 px", () => {
    expect(scrollChartHeight(1024)).toBe(576);
    expect(scrollChartHeight(280)).toBe(200);
  });

  it("wraps a long label in full on a 360 px phone instead of cutting it", () => {
    // The phone's card: 360 px less page and section padding.
    const units = cardUnits(
      scrollItemWidth({ columns: 1, contentWidth: 336 }, 1),
      16,
    );
    const label =
      "Durchschnittliche Bewertung der letzten Rezensionen · Paperstand – Magazin- und Zeitungsleser für unterwegs, mit Offline-Archiv und Vorlesefunktion";
    const lines = scrollLabelLines(label, units);
    // More than a slide would show; scroll view shows every line.
    expect(lines.resource).toBeGreaterThan(STUDIO_LABEL_MAX_LINES);
    expect(lines.title).toBeGreaterThanOrEqual(1);
  });

  it("shrinks a value, then goes compact, never below the minimum", () => {
    const narrow = cardUnits(160, 16);
    const fitted = scrollValue(
      { full: "€1,234,567,890.12", compact: "€1.2B" },
      narrow,
    );
    expect(fitted.text).toBe("€1.2B");
    expect(fitted.size).toBeGreaterThanOrEqual(SCROLL_TYPE.valueMin);
    const wide = scrollValue(
      { full: "1,248", compact: "1.2K" },
      cardUnits(312, 16),
    );
    expect(wide).toEqual({ text: "1,248", size: SCROLL_TYPE.valueMax });
  });

  it("follows the browser's text size: a larger root font leaves fewer units", () => {
    expect(cardUnits(312, 20)).toBeLessThan(cardUnits(312, 16));
  });

  it("sizes the clock to the card, between the value minimum and its maximum", () => {
    expect(scrollClockSize("14:05", cardUnits(312, 16))).toBe(
      SCROLL_TYPE.clock,
    );
    expect(scrollClockSize("2:05 PM", 40)).toBe(SCROLL_TYPE.valueMin);
  });
});
