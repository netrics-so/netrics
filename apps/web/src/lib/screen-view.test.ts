import { describe, expect, it } from "vitest";

import {
  STUDIO_REFERENCE_CANVAS,
  placementRect,
  screenFrame,
  widgetRect,
  type LayoutPlacement,
} from "@netrics/domain";

import {
  canvasGeometry,
  isClassicCanvas,
  pageLabel,
  screenFormatOf,
  slidePages,
  type ScreenWidget,
} from "./screen-view";
import { contentBox, widgetBoxStyle } from "./studio-render";

// Screen view on any screen (ADR 0017, sections 2, 3 and 11, #281).

/** A full 16:9 slide: a row of four metrics, a chart row, three metrics. */
const SLIDE: ScreenWidget[] = [
  { id: "m1", type: "metric", x: 0, y: 0, w: 3, h: 2 },
  { id: "m2", type: "metric", x: 3, y: 0, w: 3, h: 2 },
  { id: "m3", type: "metric", x: 6, y: 0, w: 3, h: 2 },
  { id: "m4", type: "metric", x: 9, y: 0, w: 3, h: 2 },
  { id: "line", type: "line", x: 0, y: 2, w: 8, h: 3 },
  { id: "bar", type: "bar", x: 8, y: 2, w: 4, h: 3 },
  { id: "m5", type: "metric", x: 0, y: 5, w: 4, h: 3 },
  { id: "m6", type: "metric", x: 4, y: 5, w: 4, h: 3 },
  { id: "m7", type: "metric", x: 8, y: 5, w: 4, h: 3 },
];

const ids = (pages: LayoutPlacement[][]) =>
  pages.map((page) => page.map((placement) => placement.id));

describe("screenFormatOf", () => {
  it.each([
    [1920, 1080, "16x9"],
    [1920, 1200, "16x9"],
    [1080, 1920, "9x16"],
    [2560, 1080, "21x9"],
    [3440, 1440, "21x9"],
    [3840, 1080, "21x9"],
    [5120, 1440, "21x9"],
    [1024, 768, "4x3"],
    [768, 1024, "3x4"],
    [390, 844, "9x16"],
  ])("%i × %i is %s", (width, height, format) => {
    expect(screenFormatOf({ width, height })).toBe(format);
  });

  it("is 16x9 until there is a usable size", () => {
    expect(screenFormatOf(null)).toBe("16x9");
    expect(screenFormatOf({ width: 0, height: 0 })).toBe("16x9");
    expect(screenFormatOf({ width: Number.NaN, height: 10 })).toBe("16x9");
  });
});

describe("a 16:9 screen renders exactly as before", () => {
  const sizes = [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 3840, height: 2160 },
    { width: 1103.5, height: 620.71875 },
    // A measured box rounds to whole pixels.
    { width: 1103, height: 621 },
  ];

  it.each(sizes)("$width × $height: the 16:9 boxes, the CSS unit", (size) => {
    for (const showHeader of [true, false]) {
      const geometry = canvasGeometry(size, "16x9", showHeader);
      expect(geometry.classic).toBe(true);
      expect(geometry.unit).toBeNull();
      for (const placement of SLIDE) {
        const { box, unitBox } = geometry.widget(placement);
        expect(box).toEqual(widgetBoxStyle(placement, showHeader));
        expect(unitBox).toBeNull();
      }
    }
    expect(canvasGeometry(size, "16x9", true).header).toEqual({
      height: "7.000000000000001%",
    });
  });

  it("places the same rects as the 16:9 grid in pixels", () => {
    for (const size of sizes.slice(0, 4)) {
      for (const showHeader of [true, false]) {
        const frame = screenFrame(size, "16x9", showHeader);
        for (const placement of SLIDE) {
          const now = placementRect(placement, frame);
          const before = widgetRect(placement, size, showHeader);
          expect(now.x).toBeCloseTo(before.x, 9);
          expect(now.y).toBeCloseTo(before.y, 9);
          expect(now.width).toBeCloseTo(before.width, 9);
          expect(now.height).toBeCloseTo(before.height, 9);
        }
      }
    }
  });

  it("keeps a 16x9 slide on one page with its own placements", () => {
    const pages = slidePages(SLIDE, {
      primaryFormat: "16x9",
      format: "16x9",
    });
    expect(pages).toHaveLength(1);
    for (const widget of SLIDE) {
      const placed = pages[0]!.find((placement) => placement.id === widget.id);
      expect(placed).toEqual({
        id: widget.id,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
      });
    }
  });

  it("is classic only for 16x9 on a 16:9 shape", () => {
    expect(isClassicCanvas(null, "16x9")).toBe(true);
    expect(isClassicCanvas({ width: 1920, height: 1080 }, "16x9")).toBe(true);
    expect(isClassicCanvas({ width: 1920, height: 1200 }, "16x9")).toBe(false);
    expect(isClassicCanvas({ width: 1080, height: 1920 }, "9x16")).toBe(false);
  });
});

describe("canvasGeometry on other screens", () => {
  it("fills a 16:10 screen, cells taller, no bars", () => {
    const geometry = canvasGeometry(
      { width: 1920, height: 1200 },
      "16x9",
      true,
    );
    expect(geometry.classic).toBe(false);
    expect(geometry.unit).toBeCloseTo(1, 9);
    expect(geometry.header).toEqual({
      left: "0%",
      top: "0%",
      width: "100%",
      height: "6.3%",
    });
    const { unitBox } = geometry.widget({ x: 0, y: 0, w: 3, h: 2 });
    const classic = widgetRect(
      { x: 0, y: 0, w: 3, h: 2 },
      STUDIO_REFERENCE_CANVAS,
      true,
    );
    expect(unitBox!.width).toBeCloseTo(classic.width, 6);
    expect(unitBox!.height).toBeGreaterThan(classic.height);
  });

  it("letterboxes 32:9 in the middle (bars are the screen's background)", () => {
    const geometry = canvasGeometry(
      { width: 3840, height: 1080 },
      "21x9",
      true,
    );
    // 21x9 reference 2520 × 1080 at u = 1, stretched 4/3: 3360 wide.
    expect(geometry.unit).toBeCloseTo(1, 9);
    expect(geometry.header).toEqual({
      left: "6.25%",
      top: "0%",
      width: "87.5%",
      height: "7%",
    });
    const left = geometry.widget({ x: 0, y: 0, w: 1, h: 1 }).box;
    const right = geometry.widget({ x: 15, y: 0, w: 1, h: 1 }).box;
    expect(parseFloat(left.left)).toBeGreaterThan(6.25);
    expect(parseFloat(right.left) + parseFloat(right.width)).toBeLessThan(
      93.75,
    );
  });

  it("gives widgets their box in units of the screen's format", () => {
    const geometry = canvasGeometry(
      { width: 1080, height: 1920 },
      "9x16",
      true,
    );
    const placed = { x: 0, y: 0, w: 6, h: 3 };
    const { unitBox } = geometry.widget(placed);
    const frame = screenFrame({ width: 1080, height: 1920 }, "9x16", true);
    const rect = placementRect(placed, frame);
    expect(unitBox).toEqual({ width: rect.width, height: rect.height });
    // The widgets measure their content in that box.
    expect(contentBox({ ...placed, unitBox }, true)).toEqual({
      width: rect.width - 48,
      height: rect.height - 48,
    });
  });

  it("uses the format's reference canvas until measured", () => {
    const geometry = canvasGeometry(null, "9x16", false);
    expect(geometry.unit).toBe(1);
    expect(geometry.header).toBeNull();
  });
});

describe("slidePages", () => {
  it("reflows into continuation pages on a portrait screen", () => {
    const pages = slidePages(SLIDE, {
      primaryFormat: "16x9",
      format: "9x16",
    });
    expect(pages.length).toBe(2);
    // Every widget once, in reading order across the pages.
    expect(ids(pages).flat()).toEqual(SLIDE.map((widget) => widget.id));
  });

  it("uses a custom layout, completed against the slide, hidden left out", () => {
    const pages = slidePages(SLIDE.slice(0, 2), {
      primaryFormat: "16x9",
      format: "4x3",
      layouts: [
        {
          format: "4x3",
          pages: 2,
          placements: [
            { widgetId: "m1", page: 1, x: 0, y: 0, w: 3, h: 2, hidden: false },
            // A widget the slide no longer has is dropped.
            {
              widgetId: "gone",
              page: 0,
              x: 3,
              y: 0,
              w: 3,
              h: 2,
              hidden: false,
            },
          ],
        },
        {
          format: "9x16",
          pages: 1,
          placements: [
            { widgetId: "m1", page: 0, x: 0, y: 0, w: 3, h: 2, hidden: true },
          ],
        },
      ],
    });
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContainEqual({ id: "m1", x: 0, y: 0, w: 3, h: 2 });
    // m2 had no placement (a widget added in a draft): placed automatically.
    expect(ids(pages).flat().sort()).toEqual(["m1", "m2"]);

    const portrait = slidePages(SLIDE.slice(0, 2), {
      primaryFormat: "16x9",
      format: "9x16",
      layouts: [
        {
          format: "9x16",
          pages: 1,
          placements: [
            { widgetId: "m1", page: 0, x: 0, y: 0, w: 3, h: 2, hidden: true },
            { widgetId: "m2", page: 0, x: 0, y: 2, w: 3, h: 2, hidden: false },
          ],
        },
      ],
    });
    expect(ids(portrait)).toEqual([["m2"]]);
  });

  it("ignores custom layouts in the primary format", () => {
    const pages = slidePages(SLIDE.slice(0, 1), {
      primaryFormat: "16x9",
      format: "16x9",
      layouts: [
        {
          format: "16x9",
          pages: 1,
          placements: [
            { widgetId: "m1", page: 0, x: 5, y: 5, w: 3, h: 2, hidden: false },
          ],
        },
      ],
    });
    expect(pages).toEqual([[{ id: "m1", x: 0, y: 0, w: 3, h: 2 }]]);
  });

  it("lays out a widget type from a newer server, and an empty slide", () => {
    const pages = slidePages(
      [{ id: "map", type: "map", x: 0, y: 0, w: 12, h: 8 }],
      { primaryFormat: "16x9", format: "9x16" },
    );
    expect(ids(pages).flat()).toEqual(["map"]);
    expect(slidePages([], { primaryFormat: "16x9", format: "9x16" })).toEqual([
      [],
    ]);
  });

  it("labels pages only when there are several", () => {
    expect(pageLabel(0, 1)).toBeNull();
    expect(pageLabel(0, 2)).toBe("1/2");
    expect(pageLabel(1, 2)).toBe("2/2");
  });
});
