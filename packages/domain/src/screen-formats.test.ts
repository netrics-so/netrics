import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CUSTOM_LAYOUT_MAX_PAGES,
  completeCustomLayout,
  defaultDisplayMode,
  reflowSlide,
  screenLayout,
  scrollColumns,
  scrollLayout,
  slideLayoutFor,
  studioReadingOrder,
  validateCustomLayout,
  type CustomLayout,
  type LayoutPlacement,
  type LayoutWidget,
} from "./screen-formats.js";
import {
  SLIDE_FIXTURES,
  buildScreenFormatVectors,
  syncCases,
} from "./screen-formats-vectors.js";
import {
  SCREEN_FORMATS,
  SCREEN_FORMAT_KEYS,
  SCREEN_FORMAT_MAX_GRID,
  SCREEN_MAX_STRETCH,
  STUDIO_GRID,
  STUDIO_MIN_WIDGET_SIZE,
  STUDIO_REFERENCE_CANVAS,
  STUDIO_SPACING,
  STUDIO_WIDGET_TYPES,
  findOverlaps,
  formatFor,
  isInsideFormatGrid,
  isScreenFormat,
  labelFit,
  placementRect,
  screenFrame,
  sizeClassFor,
  studioFrame,
  widgetRect,
  type ScreenFormat,
  type StudioWidgetType,
} from "./studio-layout.js";

// ---------------------------------------------------------------------------
// Helpers

/** A small seeded PRNG (mulberry32), so random layouts are reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A valid random primary layout: up to `count` widgets, no overlap. */
function randomSlide(
  seed: number,
  format: ScreenFormat,
  count: number,
): LayoutWidget[] {
  const next = random(seed);
  const pick = (n: number) => Math.floor(next() * n);
  const { columns, rows } = SCREEN_FORMATS[format];
  const widgets: LayoutWidget[] = [];
  for (let attempt = 0; attempt < 400 && widgets.length < count; attempt++) {
    const type = STUDIO_WIDGET_TYPES[pick(STUDIO_WIDGET_TYPES.length)]!;
    const minimum = STUDIO_MIN_WIDGET_SIZE[type];
    const w = minimum.w + pick(Math.max(1, columns - minimum.w + 1) / 2);
    const h = minimum.h + pick(Math.max(1, rows - minimum.h + 1) / 2);
    if (w > columns || h > rows) continue;
    const candidate = {
      id: `w${widgets.length}`,
      type,
      x: pick(columns - w + 1),
      y: pick(rows - h + 1),
      w,
      h,
    };
    if (findOverlaps([...widgets, candidate]).length === 0) {
      widgets.push(candidate);
    }
  }
  return widgets;
}

const typeOf = (widgets: readonly LayoutWidget[]) =>
  new Map<string, StudioWidgetType>(widgets.map((w) => [w.id, w.type]));

/** Every invariant of an auto layout (ADR 0017, section 3). */
function expectValidPages(
  pages: LayoutPlacement[][],
  widgets: readonly LayoutWidget[],
  to: ScreenFormat,
) {
  expect(pages.length).toBeGreaterThanOrEqual(1);
  const types = typeOf(widgets);
  const ids = pages.flat().map((placement) => placement.id);
  // Every widget exactly once, nothing else.
  expect([...ids].sort()).toEqual(widgets.map((w) => w.id).sort());
  for (const page of pages) {
    for (const placement of page) {
      expect(isInsideFormatGrid(placement, to)).toBe(true);
      const minimum = STUDIO_MIN_WIDGET_SIZE[types.get(placement.id)!];
      expect(placement.w).toBeGreaterThanOrEqual(minimum.w);
      expect(placement.h).toBeGreaterThanOrEqual(minimum.h);
    }
    expect(findOverlaps(page)).toEqual([]);
  }
}

const SIXTEEN_BY_NINE = [
  [1920, 1080],
  [3840, 2160],
  [1280, 720],
  [1366, 768],
  [854, 480],
  [2560, 1440],
  [1024, 576],
  [7680, 4320],
  [960, 540],
  [1600, 900],
] as const;

// ---------------------------------------------------------------------------

describe("SCREEN_FORMATS", () => {
  it("keeps 16x9 exactly today's grid and reference canvas", () => {
    expect(SCREEN_FORMATS["16x9"].columns).toBe(STUDIO_GRID.columns);
    expect(SCREEN_FORMATS["16x9"].rows).toBe(STUDIO_GRID.rows);
    expect(SCREEN_FORMATS["16x9"].reference).toEqual(STUDIO_REFERENCE_CANVAS);
  });

  it("has the grids of ADR 0017 and a 1080-unit short edge everywhere", () => {
    const grids = Object.fromEntries(
      SCREEN_FORMAT_KEYS.map((key) => [
        key,
        `${SCREEN_FORMATS[key].columns}x${SCREEN_FORMATS[key].rows}`,
      ]),
    );
    expect(grids).toEqual({
      "16x9": "12x8",
      "21x9": "16x8",
      "4x3": "9x8",
      "3x4": "6x10",
      "9x16": "6x14",
    });
    for (const key of SCREEN_FORMAT_KEYS) {
      const { reference, columns, rows } = SCREEN_FORMATS[key];
      expect(Math.min(reference.width, reference.height)).toBe(1080);
      expect(SCREEN_FORMATS[key].key).toBe(key);
      expect(columns).toBeLessThanOrEqual(SCREEN_FORMAT_MAX_GRID.columns);
      expect(rows).toBeLessThanOrEqual(SCREEN_FORMAT_MAX_GRID.rows);
    }
  });

  it("makes a cell about the same size in units in every format", () => {
    for (const key of SCREEN_FORMAT_KEYS) {
      const { reference } = SCREEN_FORMATS[key];
      const cell = placementRect(
        { x: 0, y: 0, w: 1, h: 1 },
        screenFrame(reference, key, true),
      );
      expect(cell.width).toBeGreaterThanOrEqual(138);
      expect(cell.width).toBeLessThanOrEqual(156);
      expect(cell.height).toBeGreaterThanOrEqual(103);
      expect(cell.height).toBeLessThanOrEqual(117);
    }
  });

  it("recognises the keys", () => {
    for (const key of SCREEN_FORMAT_KEYS)
      expect(isScreenFormat(key)).toBe(true);
    for (const value of ["16:9", "", null, 169, "16X9"]) {
      expect(isScreenFormat(value)).toBe(false);
    }
  });
});

describe("formatFor", () => {
  it("maps aspect ratios at the boundaries", () => {
    expect(formatFor(2040, 1000)).toBe("21x9");
    expect(formatFor(2039, 1000)).toBe("16x9");
    expect(formatFor(1540, 1000)).toBe("16x9");
    expect(formatFor(1539, 1000)).toBe("4x3");
    expect(formatFor(1000, 1000)).toBe("4x3");
    expect(formatFor(999, 1000)).toBe("3x4");
    expect(formatFor(650, 1000)).toBe("3x4");
    expect(formatFor(649, 1000)).toBe("9x16");
  });

  it("maps common screens", () => {
    expect(formatFor(1920, 1080)).toBe("16x9");
    expect(formatFor(1920, 1200)).toBe("16x9"); // 16:10
    expect(formatFor(1500, 1000)).toBe("4x3"); // 3:2
    expect(formatFor(2560, 1080)).toBe("21x9");
    expect(formatFor(5120, 1440)).toBe("21x9"); // 32:9
    expect(formatFor(1024, 768)).toBe("4x3");
    expect(formatFor(768, 1024)).toBe("3x4");
    expect(formatFor(390, 844)).toBe("9x16"); // phone portrait
    expect(formatFor(844, 390)).toBe("21x9"); // phone landscape
  });

  it("follows rotation: a TV turned 90° is portrait", () => {
    expect(formatFor(1920, 1080)).toBe("16x9");
    expect(formatFor(1080, 1920)).toBe("9x16");
    expect(formatFor(1024, 768)).toBe("4x3");
    expect(formatFor(768, 1024)).toBe("3x4");
  });

  it("treats unusable sizes as 16x9", () => {
    expect(formatFor(0, 0)).toBe("16x9");
    expect(formatFor(-1, 100)).toBe("16x9");
    expect(formatFor(Number.NaN, 100)).toBe("16x9");
    expect(formatFor(100, Number.POSITIVE_INFINITY)).toBe("16x9");
  });
});

describe("sizeClassFor", () => {
  it("classifies by the short edge", () => {
    expect(sizeClassFor(390, 844)).toBe("compact");
    expect(sizeClassFor(844, 390)).toBe("compact");
    expect(sizeClassFor(2000, 599)).toBe("compact");
    expect(sizeClassFor(2000, 600)).toBe("regular");
    expect(sizeClassFor(768, 1024)).toBe("regular");
    expect(sizeClassFor(1099, 2000)).toBe("regular");
    expect(sizeClassFor(1100, 2000)).toBe("large");
    expect(sizeClassFor(1920, 1080)).toBe("regular");
    expect(sizeClassFor(2560, 1440)).toBe("large");
    expect(sizeClassFor(Number.NaN, 1000)).toBe("compact");
  });
});

describe("screenFrame and placementRect", () => {
  it("is exactly studioFrame and widgetRect on 16:9 screens", () => {
    for (const [width, height] of SIXTEEN_BY_NINE) {
      const screen = { width, height };
      for (const showHeader of [true, false]) {
        const old = studioFrame(screen, showHeader);
        const frame = screenFrame(screen, "16x9", showHeader);
        expect(frame.unit).toBe(old.unit);
        expect(frame.header).toEqual(old.header);
        expect(frame.grid).toEqual(old.grid);
        expect(frame.canvas).toEqual({ x: 0, y: 0, width, height });
        for (let x = 0; x < 12; x++) {
          for (let y = 0; y < 8; y++) {
            const placement = { x, y, w: 12 - x, h: 8 - y };
            expect(placementRect(placement, frame)).toEqual(
              widgetRect(placement, screen, showHeader),
            );
          }
        }
      }
    }
  });

  it("uses u = min(width / refWidth, height / refHeight)", () => {
    expect(screenFrame({ width: 1920, height: 1200 }, "16x9", true).unit).toBe(
      1,
    );
    expect(screenFrame({ width: 1080, height: 1920 }, "9x16", true).unit).toBe(
      1,
    );
    expect(screenFrame({ width: 2160, height: 3840 }, "9x16", false).unit).toBe(
      2,
    );
    expect(screenFrame({ width: 768, height: 1024 }, "3x4", true).unit).toBe(
      768 / 1080,
    );
  });

  it("fills the screen and stretches cells in the longer direction", () => {
    const frame = screenFrame({ width: 1920, height: 1200 }, "16x9", true);
    expect(frame.canvas).toEqual({ x: 0, y: 0, width: 1920, height: 1200 });
    expect(frame.header!.height).toBeCloseTo(75.6, 9);
    const cell = placementRect({ x: 0, y: 0, w: 1, h: 1 }, frame);
    const reference = placementRect(
      { x: 0, y: 0, w: 1, h: 1 },
      screenFrame(STUDIO_REFERENCE_CANVAS, "16x9", true),
    );
    expect(cell.width).toBeCloseTo(reference.width, 9);
    expect(cell.height).toBeGreaterThan(reference.height);
  });

  it("caps the stretch at 4/3 and letterboxes in the centre beyond", () => {
    // 32:9 on 21x9: wider than 4/3 × 2520 u.
    const wide = screenFrame({ width: 5120, height: 1440 }, "21x9", true);
    expect(wide.unit).toBeCloseTo(1440 / 1080, 12);
    expect(wide.canvas.height).toBe(1440);
    expect(wide.canvas.width).toBeCloseTo(2520 * wide.unit * (4 / 3), 9);
    expect(wide.canvas.x).toBeCloseTo((5120 - wide.canvas.width) / 2, 9);
    expect(wide.canvas.y).toBe(0);
    // A 1:3 strip on 9x16.
    const strip = screenFrame({ width: 600, height: 1800 }, "9x16", false);
    expect(strip.canvas.width).toBe(600);
    expect(strip.canvas.height).toBeCloseTo(1920 * strip.unit * (4 / 3), 9);
    expect(strip.canvas.y).toBeCloseTo((1800 - strip.canvas.height) / 2, 9);
    expect(strip.grid.y).toBeCloseTo(
      strip.canvas.y + STUDIO_SPACING.padding * strip.unit,
      9,
    );
  });

  it("never stretches more than 4/3 for any screen and format", () => {
    for (const key of SCREEN_FORMAT_KEYS) {
      const { reference } = SCREEN_FORMATS[key];
      for (const [width, height] of [
        [5120, 1440],
        [600, 1800],
        [1000, 1000],
        [390, 844],
        [3840, 2160],
        [100, 2000],
      ] as const) {
        const frame = screenFrame({ width, height }, key, true);
        const sx = frame.canvas.width / (reference.width * frame.unit);
        const sy = frame.canvas.height / (reference.height * frame.unit);
        expect(Math.min(sx, sy)).toBeCloseTo(1, 9);
        expect(Math.max(sx, sy)).toBeLessThanOrEqual(SCREEN_MAX_STRETCH + 1e-9);
        expect(frame.canvas.x).toBeGreaterThanOrEqual(0);
        expect(frame.canvas.y).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("fills the grid area with the whole grid in every format", () => {
    for (const key of SCREEN_FORMAT_KEYS) {
      const frame = screenFrame({ width: 1000, height: 1000 }, key, true);
      const all = placementRect(
        { x: 0, y: 0, w: frame.columns, h: frame.rows },
        frame,
      );
      expect(all.x).toBeCloseTo(frame.grid.x, 9);
      expect(all.y).toBeCloseTo(frame.grid.y, 9);
      expect(all.width).toBeCloseTo(frame.grid.width, 9);
      expect(all.height).toBeCloseTo(frame.grid.height, 9);
    }
  });
});

describe("labelFit per format", () => {
  it("is unchanged at 16x9", () => {
    const label =
      "Ratings and reviews · Wurfel: Würfel-Spiel für die ganze Familie";
    for (const widget of [
      { type: "metric", w: 3, h: 2 },
      { type: "line", w: 6, h: 4 },
    ] as const) {
      expect(labelFit(label, widget, { format: "16x9" })).toEqual(
        labelFit(label, widget),
      );
    }
  });

  it("measures at the format's reference width", () => {
    // A 3-column metric is 156 units wide at 3x4 against 140 at 16x9.
    const label = "Impressions · sc-domain:example.com";
    const at16 = labelFit(label, { type: "metric", w: 3, h: 2 });
    const at34 = labelFit(
      label,
      { type: "metric", w: 3, h: 2 },
      { format: "3x4" },
    );
    expect(at34.titleLines + at34.resourceLines).toBeLessThanOrEqual(
      at16.titleLines + at16.resourceLines,
    );
  });
});

describe("studioReadingOrder", () => {
  it("reads stacked metrics before the band below", () => {
    const slide = SLIDE_FIXTURES.find(
      (entry) => entry.name === "stacked metrics beside a chart",
    )!;
    expect(studioReadingOrder(slide.widgets).map((w) => w.id)).toEqual([
      "chart",
      "m1",
      "m2",
      "note",
    ]);
  });

  it("reads a stack top to bottom before the next stack", () => {
    const widgets: LayoutWidget[] = [
      { id: "b", type: "metric", x: 6, y: 0, w: 6, h: 2 },
      { id: "a2", type: "metric", x: 0, y: 3, w: 6, h: 3 },
      { id: "a1", type: "metric", x: 0, y: 0, w: 6, h: 3 },
      { id: "c", type: "line", x: 6, y: 2, w: 6, h: 4 },
    ];
    // One band (rows 0–6); stacks a1/a2 and b/c.
    expect(studioReadingOrder(widgets).map((w) => w.id)).toEqual([
      "a1",
      "a2",
      "b",
      "c",
    ]);
  });

  it("does not depend on the input order", () => {
    for (const slide of SLIDE_FIXTURES) {
      const forward = studioReadingOrder(slide.widgets);
      const backward = studioReadingOrder([...slide.widgets].reverse());
      expect(backward).toEqual(forward);
    }
  });
});

describe("reflowSlide", () => {
  const four = SLIDE_FIXTURES.find(
    (entry) => entry.name === "four metrics in a row",
  )!.widgets;

  it("returns the primary layout as one page for the primary format", () => {
    for (const slide of SLIDE_FIXTURES) {
      const pages = reflowSlide(slide.widgets, slide.format, slide.format);
      expect(pages).toHaveLength(1);
      expect([...pages[0]!].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        slide.widgets
          .map(({ id, x, y, w, h }) => ({ id, x, y, w, h }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    }
  });

  it("keeps every existing 16:9 dashboard exactly as it is", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const widgets = randomSlide(seed, "16x9", 1 + (seed % 16));
      const [page] = reflowSlide(widgets, "16x9", "16x9");
      const byId = new Map(page!.map((p) => [p.id, p]));
      for (const widget of widgets) {
        const { id, x, y, w, h } = widget;
        expect(byId.get(id)).toEqual({ id, x, y, w, h });
      }
    }
  });

  it("keeps an empty slide one empty page", () => {
    for (const to of SCREEN_FORMAT_KEYS) {
      expect(reflowSlide([], "16x9", to)).toEqual([[]]);
    }
  });

  it("makes four metrics in a row a 2 × 2 block on 9x16 and 4x3", () => {
    for (const to of ["9x16", "4x3", "3x4"] as const) {
      const [page, ...rest] = reflowSlide(four, "16x9", to);
      expect(rest).toEqual([]);
      const rows = new Set(page!.map((p) => p.y));
      const columns = new Set(page!.map((p) => p.x));
      expect(rows.size).toBe(2);
      expect(columns.size).toBe(2);
      expect(page!.map((p) => p.id)).toEqual(["m0", "m1", "m2", "m3"]);
      // Justified: each shelf fills the width.
      const top = page!.filter((p) => p.y === page![0]!.y);
      expect(top.reduce((sum, p) => sum + p.w, 0)).toBe(
        SCREEN_FORMATS[to].columns,
      );
    }
  });

  it("makes four metrics in a row four 4 × 2 metrics on 21x9", () => {
    const [page] = reflowSlide(four, "16x9", "21x9");
    expect(page!.map(({ x, w }) => [x, w])).toEqual([
      [0, 4],
      [4, 4],
      [8, 4],
      [12, 4],
    ]);
    expect(new Set(page!.map((p) => p.y)).size).toBe(1);
  });

  it("keeps deliberate gaps when a band fits on one shelf", () => {
    const slide = SLIDE_FIXTURES.find(
      (entry) => entry.name === "deliberate gaps, clock and image",
    )!;
    const [page] = reflowSlide(slide.widgets, "16x9", "21x9");
    const byId = new Map(page!.map((p) => [p.id, p]));
    expect(byId.get("left")!.x).toBe(0);
    expect(byId.get("right")!.x).toBe(12); // 9 × 16/12
    expect(byId.get("logo")!.x + byId.get("logo")!.w).toBeLessThanOrEqual(16);
  });

  it("keeps stacked metrics beside the chart and widens to minimums", () => {
    const slide = SLIDE_FIXTURES.find(
      (entry) => entry.name === "stacked metrics beside a chart",
    )!;
    const [page] = reflowSlide(slide.widgets, "16x9", "4x3");
    const byId = new Map(page!.map((p) => [p.id, p]));
    // Chart 0–8 → 0–6, metrics 8–12 → 6–9 (3 wide: the metric minimum).
    expect(byId.get("chart")).toMatchObject({ x: 0, w: 6, y: 0 });
    expect(byId.get("m1")).toMatchObject({ x: 6, w: 3, y: 0 });
    expect(byId.get("m2")).toMatchObject({ x: 6, w: 3, y: 3 });
    expect(byId.get("note")).toMatchObject({ x: 0, w: 9, y: 6 });
  });

  it("splits a stack taller than the grid between widgets", () => {
    const slide = SLIDE_FIXTURES.find(
      (entry) => entry.name === "portrait with a tall stack",
    )!;
    const pages = reflowSlide(slide.widgets, "9x16", "16x9");
    expectValidPages(pages, slide.widgets, "16x9");
    const all = pages.flat();
    const byId = new Map(all.map((p) => [p.id, p]));
    // m1, m2 (6 rows) stay a stack; m3, m4 form the next one beside it.
    expect(byId.get("m2")!.x).toBe(byId.get("m1")!.x);
    expect(byId.get("m2")!.y).toBe(byId.get("m1")!.y + byId.get("m1")!.h);
    expect(byId.get("m3")!.x).not.toBe(byId.get("m1")!.x);
    // The 12-row text is cut to the grid height, never below its minimum.
    expect(byId.get("side")!.h).toBe(8);
    expect(pages.length).toBeGreaterThanOrEqual(2);
  });

  it("overflows into continuation pages instead of shrinking", () => {
    const slide = SLIDE_FIXTURES.find(
      (entry) => entry.name === "sixteen metrics",
    )!;
    for (const to of ["9x16", "3x4"] as const) {
      const pages = reflowSlide(slide.widgets, "16x9", to);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expectValidPages(pages, slide.widgets, to);
      // Reading order across pages.
      expect(pages.flat().map((p) => p.id)).toEqual(
        studioReadingOrder(slide.widgets).map((w) => w.id),
      );
    }
  });

  it("grows a shelf by at most half its height and centres the rest", () => {
    const [page] = reflowSlide(
      [{ id: "m", type: "metric", x: 0, y: 0, w: 3, h: 2 }],
      "16x9",
      "9x16",
    );
    // 2 rows grow to 3; 11 spare rows centre it at floor(11 / 2).
    expect(page).toEqual([{ id: "m", x: 0, y: 5, w: 3, h: 3 }]);
  });

  it("holds every invariant for every fixture and format", () => {
    for (const slide of SLIDE_FIXTURES) {
      for (const to of SCREEN_FORMAT_KEYS) {
        expectValidPages(
          reflowSlide(slide.widgets, slide.format, to),
          slide.widgets,
          to,
        );
      }
    }
  });

  it("holds every invariant for random layouts (property)", () => {
    let seed = 1000;
    for (const from of SCREEN_FORMAT_KEYS) {
      for (let run = 0; run < 60; run++) {
        seed += 1;
        const widgets = randomSlide(seed, from, 1 + (run % 16));
        for (const to of SCREEN_FORMAT_KEYS) {
          const pages = reflowSlide(widgets, from, to);
          expectValidPages(pages, widgets, to);
          // Reading order survives the reflow.
          expect(pages.flat().map((p) => p.id)).toEqual(
            studioReadingOrder(widgets).map((w) => w.id),
          );
          // Deterministic and independent of the input order.
          expect(reflowSlide(widgets, from, to)).toEqual(pages);
          expect(reflowSlide([...widgets].reverse(), from, to)).toEqual(pages);
          // Never more pages than widgets.
          expect(pages.length).toBeLessThanOrEqual(Math.max(1, widgets.length));
        }
      }
    }
  });

  it("is stable: moving one widget changes no other band", () => {
    const slide = SLIDE_FIXTURES.find((entry) => entry.name === "seven")!;
    const moved = slide.widgets.map((widget) =>
      widget.id === "m5" ? { ...widget, h: 2 } : widget,
    );
    const before = reflowSlide(slide.widgets, "16x9", "21x9")[0]!;
    const after = reflowSlide(moved, "16x9", "21x9")[0]!;
    const pick = (page: LayoutPlacement[], ids: string[]) =>
      page.filter((p) => ids.includes(p.id));
    expect(pick(after, ["title", "m1", "m2", "m3"])).toEqual(
      pick(before, ["title", "m1", "m2", "m3"]),
    );
  });
});

describe("slideLayoutFor", () => {
  const slide = SLIDE_FIXTURES.find(
    (entry) => entry.name === "stacked metrics beside a chart",
  )!;

  it("uses the primary, the auto reflow, or the custom layout", () => {
    expect(
      slideLayoutFor({
        widgets: slide.widgets,
        primaryFormat: "16x9",
        format: "16x9",
      }),
    ).toEqual(reflowSlide(slide.widgets, "16x9", "16x9"));
    expect(
      slideLayoutFor({
        widgets: slide.widgets,
        primaryFormat: "16x9",
        format: "9x16",
        custom: null,
      }),
    ).toEqual(reflowSlide(slide.widgets, "16x9", "9x16"));
    const custom: CustomLayout = {
      pages: 2,
      placements: [
        {
          id: "chart",
          page: 0,
          x: 0,
          y: 0,
          w: 9,
          h: 6,
          hidden: false,
          autoPlaced: false,
        },
        {
          id: "m1",
          page: 1,
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          hidden: false,
          autoPlaced: false,
        },
        {
          id: "m2",
          page: 1,
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          hidden: true,
          autoPlaced: false,
        },
        {
          id: "note",
          page: 0,
          x: 0,
          y: 6,
          w: 9,
          h: 2,
          hidden: false,
          autoPlaced: true,
        },
      ],
    };
    expect(
      slideLayoutFor({
        widgets: slide.widgets,
        primaryFormat: "16x9",
        format: "4x3",
        custom,
      }),
    ).toEqual([
      [
        { id: "chart", x: 0, y: 0, w: 9, h: 6 },
        { id: "note", x: 0, y: 6, w: 9, h: 2 },
      ],
      [{ id: "m1", x: 0, y: 0, w: 3, h: 2 }],
    ]);
  });
});

describe("validateCustomLayout", () => {
  const vectors = buildScreenFormatVectors();
  const codes = (name: string) =>
    vectors.validation
      .find((entry) => entry.name === name)!
      .problems.map((problem) => `${problem.code}:${problem.widgetId}`);

  it("accepts a valid layout", () => {
    expect(codes("valid")).toEqual([]);
    expect(codes("hidden may overlap")).toEqual([]);
  });

  it("names each problem", () => {
    expect(codes("no pages")).toEqual(["invalid_page_count:null"]);
    expect(codes("nine pages")).toEqual(["invalid_page_count:null"]);
    expect(codes("page out of range")).toEqual(["page_out_of_range:c"]);
    expect(codes("outside the grid")).toEqual(["widget_out_of_bounds:c"]);
    expect(codes("too small")).toEqual(["widget_too_small:b"]);
    expect(codes("overlap")).toEqual(["widgets_overlap:b"]);
    expect(codes("missing")).toEqual(["widget_missing:a"]);
    expect(codes("duplicated")).toEqual(["widget_duplicated:c"]);
    expect(codes("unknown")).toEqual(["unknown_widget:z"]);
  });
});

describe("completeCustomLayout", () => {
  const cases = syncCases();
  const run = (name: string) => {
    const entry = cases.find((c) => c.name === name)!;
    return {
      entry,
      result: completeCustomLayout(
        entry.custom,
        { format: entry.primaryFormat, widgets: entry.widgets },
        entry.format,
      ),
    };
  };
  const byId = (layout: CustomLayout) =>
    new Map(layout.placements.map((p) => [p.id, p]));

  it("produces a valid layout for every case", () => {
    for (const entry of cases) {
      const result = completeCustomLayout(
        entry.custom,
        { format: entry.primaryFormat, widgets: entry.widgets },
        entry.format,
      );
      expect(validateCustomLayout(result, entry.widgets, entry.format)).toEqual(
        [],
      );
      // Idempotent: completing again changes nothing.
      expect(
        completeCustomLayout(
          result,
          { format: entry.primaryFormat, widgets: entry.widgets },
          entry.format,
        ),
      ).toEqual(result);
    }
  });

  it("leaves a complete layout alone", () => {
    for (const name of ["unchanged", "unchanged by hand"]) {
      const { entry, result } = run(name);
      expect(result.pages).toBe(entry.custom.pages);
      expect(byId(result)).toEqual(byId(entry.custom));
    }
  });

  it("ignores moves and resizes in the primary", () => {
    const { entry, result } = run("widget moved and resized in the primary");
    expect(byId(result)).toEqual(byId(entry.custom));
  });

  it("places an added widget next to its neighbour and flags it", () => {
    const { entry, result } = run("widget added fits beside its neighbour");
    const added = byId(result).get("m4")!;
    expect(added).toMatchObject({ page: 0, hidden: false, autoPlaced: true });
    for (const placement of entry.custom.placements) {
      expect(byId(result).get(placement.id)).toEqual(placement);
    }
  });

  it("adds a new last page when the neighbour's page is full", () => {
    const { result } = run("widget added to a full page goes to a new page");
    expect(result.pages).toBe(2);
    expect(byId(result).get("new")).toMatchObject({
      page: 1,
      x: 0,
      y: 0,
      autoPlaced: true,
    });
  });

  it("keeps added widgets together in reading order", () => {
    const { result } = run("two widgets added follow each other");
    expect(byId(result).get("new1")!.page).toBe(1);
    expect(byId(result).get("new2")!.page).toBe(1);
    expect(result.pages).toBe(2);
  });

  it("removes deleted widgets and keeps the hole", () => {
    const { entry, result } = run("widget deleted leaves the hole");
    expect(byId(result).has("m2")).toBe(false);
    for (const placement of entry.custom.placements) {
      if (placement.id !== "m2") {
        expect(byId(result).get(placement.id)).toEqual(placement);
      }
    }
  });

  it("re-places a widget whose new type needs more room", () => {
    const { result } = run("type change below the minimum is re-placed");
    const band = byId(result).get("band")!;
    expect(band.autoPlaced).toBe(true);
    expect(band.w).toBeGreaterThanOrEqual(3);
    expect(band.h).toBeGreaterThanOrEqual(2);
  });

  it("re-places overlapping, out-of-grid and out-of-page placements", () => {
    for (const [name, id] of [
      ["overlapping placement is re-placed", "m2"],
      ["outside the grid is re-placed", "m2"],
      ["page out of range is re-placed", "m2"],
    ] as const) {
      const { entry, result } = run(name);
      expect(byId(result).get(id)!.autoPlaced).toBe(true);
      for (const placement of entry.custom.placements) {
        if (placement.id !== id) {
          expect(byId(result).get(placement.id)).toEqual(placement);
        }
      }
    }
  });

  it("keeps hidden widgets hidden and existing flags", () => {
    const { result } = run("hidden widgets stay hidden");
    expect(byId(result).get("m1")).toMatchObject({ hidden: true, page: 0 });
    expect(byId(result).get("m2")).toMatchObject({ hidden: true, page: 0 });
    expect(byId(result).get("note")!.autoPlaced).toBe(true);
    expect(byId(result).get("chart")!.autoPlaced).toBe(false);
  });

  it("drops unknown widgets and duplicate placements", () => {
    const { result } = run("unknown and duplicate placements go");
    expect(result.placements.map((p) => p.id)).toEqual([
      "chart",
      "m1",
      "m2",
      "note",
    ]);
    expect(result.placements.every((p) => !p.autoPlaced)).toBe(true);
  });

  it("uses the next widget's page when no earlier widget is placed", () => {
    const { result } = run(
      "first widget added before all others takes the next one's page",
    );
    expect(byId(result).get("top")).toMatchObject({
      page: 1,
      autoPlaced: true,
    });
  });

  it("fills an empty custom layout with every widget", () => {
    const { result } = run("a custom layout with nothing placed is filled");
    expect(result.placements).toHaveLength(16);
    expect(result.placements.every((p) => p.autoPlaced && !p.hidden)).toBe(
      true,
    );
    expect(result.pages).toBeLessThanOrEqual(CUSTOM_LAYOUT_MAX_PAGES);
  });

  it("never exceeds eight pages: a free minimum spot, else hidden", () => {
    const spot = run("eight pages: a free minimum spot on any page").result;
    expect(spot.pages).toBe(8);
    expect(byId(spot).get("late")).toMatchObject({
      page: 5,
      x: 0,
      y: 12,
      w: 3,
      h: 2,
      hidden: false,
      autoPlaced: true,
    });
    const full = run("eight full pages: hidden and flagged").result;
    expect(full.pages).toBe(8);
    expect(byId(full).get("late")).toMatchObject({
      hidden: true,
      autoPlaced: true,
    });
  });

  it("completes random layouts after random primary edits (property)", () => {
    let seed = 5000;
    for (const format of SCREEN_FORMAT_KEYS) {
      for (let run = 0; run < 40; run++) {
        seed += 1;
        const widgets = randomSlide(seed, "16x9", 2 + (run % 14));
        const auto = reflowSlide(widgets, "16x9", format);
        const start: CustomLayout = {
          pages: auto.length,
          placements: auto.flatMap((page, index) =>
            page.map((p) => ({
              ...p,
              page: index,
              hidden: false,
              autoPlaced: false,
            })),
          ),
        };
        // Delete one widget, add another and change a type.
        const next = random(seed);
        const edited = widgets
          .filter((_, i) => i !== Math.floor(next() * widgets.length))
          .map((widget, i) =>
            i === 0 ? { ...widget, type: "line" as const } : widget,
          );
        const added: LayoutWidget = {
          id: "added",
          type: "metric",
          x: 0,
          y: 0,
          w: 3,
          h: 2,
        };
        const primary = [...edited, added];
        const result = completeCustomLayout(
          start,
          { format: "16x9", widgets: primary },
          format,
        );
        expect(validateCustomLayout(result, primary, format)).toEqual([]);
        expect(result.placements.map((p) => p.id).sort()).toEqual(
          primary.map((w) => w.id).sort(),
        );
        expect(
          result.placements.find((p) => p.id === "added")!.autoPlaced,
        ).toBe(true);
        expect(
          completeCustomLayout(
            result,
            { format: "16x9", widgets: primary },
            format,
          ),
        ).toEqual(result);
      }
    }
  });
});

describe("defaultDisplayMode", () => {
  it("is screen view on Apple TV, whatever the device says", () => {
    for (const deviceMode of [null, "screen", "scroll"] as const) {
      expect(
        defaultDisplayMode({
          kind: "tvos",
          sizeClass: "large",
          coarsePointer: true,
          deviceMode,
        }),
      ).toBe("screen");
    }
  });

  it("follows the kiosk's device setting, screen view by default", () => {
    const kiosk = {
      kind: "kiosk",
      sizeClass: "compact",
      coarsePointer: true,
    } as const;
    expect(defaultDisplayMode(kiosk)).toBe("screen");
    expect(defaultDisplayMode({ ...kiosk, deviceMode: "scroll" })).toBe(
      "scroll",
    );
    expect(defaultDisplayMode({ ...kiosk, deviceMode: "screen" })).toBe(
      "screen",
    );
  });

  it("uses scroll view in a browser on phones and tablets only", () => {
    const browser = (
      sizeClass: "compact" | "regular" | "large",
      coarsePointer: boolean,
    ) => defaultDisplayMode({ kind: "browser", sizeClass, coarsePointer });
    expect(browser("compact", true)).toBe("scroll");
    expect(browser("regular", true)).toBe("scroll");
    expect(browser("large", true)).toBe("screen");
    expect(browser("compact", false)).toBe("screen");
    expect(browser("regular", false)).toBe("screen");
    expect(browser("large", false)).toBe("screen");
  });
});

describe("scrollLayout", () => {
  it("picks 1, 2 or 3 columns by width", () => {
    expect(scrollColumns(320)).toBe(1);
    expect(scrollColumns(599)).toBe(1);
    expect(scrollColumns(600)).toBe(2);
    expect(scrollColumns(1023)).toBe(2);
    expect(scrollColumns(1024)).toBe(3);
    expect(scrollColumns(Number.NaN)).toBe(1);
    expect(scrollLayout([], 1600).contentWidth).toBe(1200);
    expect(scrollLayout([], 390).contentWidth).toBe(390);
  });

  it("shows every widget once, in reading order, clocks included", () => {
    for (const slide of SLIDE_FIXTURES) {
      for (const width of [320, 800, 1440]) {
        const layout = scrollLayout(slide.widgets, width);
        expect(layout.items.map((item) => item.id)).toEqual(
          studioReadingOrder(slide.widgets).map((w) => w.id),
        );
        for (const item of layout.items) {
          expect(item.column + item.span).toBeLessThanOrEqual(layout.columns);
        }
        // Rows never go back, columns within a row move right.
        for (let i = 1; i < layout.items.length; i++) {
          const a = layout.items[i - 1]!;
          const b = layout.items[i]!;
          expect(
            b.row > a.row || (b.row === a.row && b.column >= a.column + a.span),
          ).toBe(true);
        }
      }
    }
  });

  it("spans charts and wide text and images, and keeps gaps", () => {
    const widgets: LayoutWidget[] = [
      { id: "m", type: "metric", x: 0, y: 0, w: 3, h: 2 },
      { id: "line", type: "line", x: 3, y: 0, w: 9, h: 4 },
      { id: "clock", type: "clock", x: 0, y: 4, w: 2, h: 1 },
      { id: "small", type: "text", x: 2, y: 4, w: 4, h: 1 },
      { id: "wide", type: "text", x: 6, y: 4, w: 6, h: 1 },
      { id: "img", type: "image", x: 0, y: 5, w: 6, h: 3 },
    ];
    const layout = scrollLayout(widgets, 1100);
    expect(
      layout.items.map(({ id, row, column, span, height }) => [
        id,
        row,
        column,
        span,
        height,
      ]),
    ).toEqual([
      ["m", 0, 0, 1, "content"],
      ["line", 1, 0, 3, "chart"],
      ["clock", 2, 0, 1, "content"],
      ["small", 2, 1, 1, "content"],
      ["wide", 3, 0, 3, "content"],
      ["img", 4, 0, 3, "image"],
    ]);
    // One column: everything stacks.
    expect(scrollLayout(widgets, 390).items.map((item) => item.row)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
  });
});

describe("screenLayout", () => {
  it("bundles the functions", () => {
    expect(screenLayout.reflowSlide).toBe(reflowSlide);
    expect(screenLayout.completeCustomLayout).toBe(completeCustomLayout);
  });
});

describe("test vectors", () => {
  const path = new URL("../test-vectors/screen-formats.json", import.meta.url);

  it("match the checked-in file (pnpm vectors:formats regenerates it)", () => {
    const vectors = buildScreenFormatVectors();
    const text = `${JSON.stringify(vectors, null, 2)}\n`;
    if (process.env.UPDATE_FORMAT_VECTORS === "1") {
      writeFileSync(path, text);
    }
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
  });

  it("hold every invariant", () => {
    const vectors = buildScreenFormatVectors();
    for (const slide of vectors.slides) {
      for (const to of SCREEN_FORMAT_KEYS) {
        expectValidPages(slide.reflow[to]!, slide.widgets, to);
      }
    }
    for (const entry of vectors.sync) {
      expect(
        validateCustomLayout(entry.completed, entry.widgets, entry.format),
      ).toEqual([]);
    }
    // Every format boundary, 16:10, 32:9 and a phone both ways are covered.
    const formats = new Set(vectors.formatFor.map((entry) => entry.format));
    expect(formats.size).toBe(5);
    // Every sync rule has a case.
    expect(vectors.sync.length).toBeGreaterThanOrEqual(12);
  });
});
