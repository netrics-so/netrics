import { describe, expect, it } from "vitest";

import {
  SCREEN_FORMATS,
  STUDIO_GRID,
  STUDIO_REFERENCE_CANVAS,
  placementRect,
  screenFrame,
  widgetRect,
} from "@netrics/domain";

import {
  RESIZE_HANDLES,
  dragPlacement,
  dropPlacement,
  gridMetrics,
  nearestFreePlacement,
  nudgePlacement,
  pixelsToCells,
  placementBlocker,
  pointToCell,
  resizePlacement,
} from "./studio-grid";

const canvases = [
  { width: 960, height: 540 },
  STUDIO_REFERENCE_CANVAS,
  { width: 3840, height: 2160 },
  // A zoomed-out editor: the canvas measured at an odd size.
  { width: 731.5, height: 411.47 },
];

describe("grid metrics", () => {
  it.each(canvases)(
    "agree with widgetRect on a $width × $height canvas",
    (canvas) => {
      for (const showHeader of [true, false]) {
        const metrics = gridMetrics(canvas, showHeader);
        for (const placement of [
          { x: 0, y: 0, w: 1, h: 1 },
          { x: 5, y: 3, w: 4, h: 2 },
          { x: 11, y: 7, w: 1, h: 1 },
        ]) {
          const rect = widgetRect(placement, canvas, showHeader);
          expect(
            metrics.left + placement.x * (metrics.cellWidth + metrics.gap),
          ).toBeCloseTo(rect.x, 6);
          expect(
            metrics.top + placement.y * (metrics.cellHeight + metrics.gap),
          ).toBeCloseTo(rect.y, 6);
          // The centre of the widget's first cell maps back to it.
          expect(
            pointToCell(
              {
                x: rect.x + metrics.cellWidth / 2,
                y: rect.y + metrics.cellHeight / 2,
              },
              metrics,
            ),
          ).toEqual({ column: placement.x, row: placement.y });
        }
      }
    },
  );

  it("clamps points outside the grid to its edge cells", () => {
    const metrics = gridMetrics(STUDIO_REFERENCE_CANVAS, true);
    expect(pointToCell({ x: -50, y: -50 }, metrics)).toEqual({
      column: 0,
      row: 0,
    });
    expect(pointToCell({ x: 5000, y: 5000 }, metrics)).toEqual({
      column: STUDIO_GRID.columns - 1,
      row: STUDIO_GRID.rows - 1,
    });
  });

  it("turns the same drag into the same cells at any zoom", () => {
    for (const scale of [0.5, 1, 2]) {
      const metrics = gridMetrics(
        { width: 1920 * scale, height: 1080 * scale },
        false,
      );
      const pitchX = metrics.cellWidth + metrics.gap;
      const pitchY = metrics.cellHeight + metrics.gap;
      const cells = pixelsToCells({ x: 3 * pitchX, y: -2 * pitchY }, metrics);
      expect(cells.dx).toBeCloseTo(3, 9);
      expect(cells.dy).toBeCloseTo(-2, 9);
    }
  });
});

describe("dragPlacement", () => {
  const start = { x: 4, y: 2, w: 4, h: 3 };

  it("moves by whole cells, snapping to the nearest one", () => {
    expect(
      dragPlacement(start, "move", { dx: 1.4, dy: -0.6 }, "metric"),
    ).toEqual({ x: 5, y: 1, w: 4, h: 3 });
    expect(
      dragPlacement(start, "move", { dx: 0.49, dy: 0.49 }, "metric"),
    ).toEqual(start);
  });

  it("keeps a moved widget inside the grid", () => {
    expect(
      dragPlacement(start, "move", { dx: -20, dy: -20 }, "metric"),
    ).toEqual({
      x: 0,
      y: 0,
      w: 4,
      h: 3,
    });
    expect(dragPlacement(start, "move", { dx: 20, dy: 20 }, "metric")).toEqual({
      x: 8,
      y: 5,
      w: 4,
      h: 3,
    });
  });

  it("resizes from each edge and corner, moving only those edges", () => {
    const delta = { dx: 1, dy: 1 };
    const results = Object.fromEntries(
      RESIZE_HANDLES.map((handle) => [
        handle,
        dragPlacement(start, handle, delta, "image"),
      ]),
    );
    expect(results).toEqual({
      n: { x: 4, y: 3, w: 4, h: 2 },
      ne: { x: 4, y: 3, w: 5, h: 2 },
      e: { x: 4, y: 2, w: 5, h: 3 },
      se: { x: 4, y: 2, w: 5, h: 4 },
      s: { x: 4, y: 2, w: 4, h: 4 },
      sw: { x: 5, y: 2, w: 3, h: 4 },
      w: { x: 5, y: 2, w: 3, h: 3 },
      nw: { x: 5, y: 3, w: 3, h: 2 },
    });
  });

  it("never resizes below the type's minimum or past the grid", () => {
    // A metric is at least 3 × 2.
    expect(dragPlacement(start, "se", { dx: -10, dy: -10 }, "metric")).toEqual({
      x: 4,
      y: 2,
      w: 3,
      h: 2,
    });
    expect(dragPlacement(start, "nw", { dx: 10, dy: 10 }, "metric")).toEqual({
      x: 5,
      y: 3,
      w: 3,
      h: 2,
    });
    expect(dragPlacement(start, "se", { dx: 30, dy: 30 }, "metric")).toEqual({
      x: 4,
      y: 2,
      w: 8,
      h: 6,
    });
    expect(dragPlacement(start, "nw", { dx: -30, dy: -30 }, "metric")).toEqual({
      x: 0,
      y: 0,
      w: 8,
      h: 5,
    });
  });
});

describe("placementBlocker", () => {
  const others = [
    { x: 0, y: 0, w: 4, h: 3 },
    { x: 8, y: 0, w: 4, h: 3 },
  ];

  it("allows a free spot, touching edges included", () => {
    expect(placementBlocker({ x: 4, y: 0, w: 4, h: 3 }, "metric", others)).toBe(
      null,
    );
  });

  it("names the first widget in the way", () => {
    expect(
      placementBlocker({ x: 6, y: 2, w: 3, h: 2 }, "metric", others),
    ).toEqual({ kind: "overlap", index: 1 });
  });

  it("refuses spots off the grid and below the minimum size", () => {
    expect(placementBlocker({ x: 10, y: 6, w: 3, h: 2 }, "metric", [])).toEqual(
      {
        kind: "outside",
      },
    );
    expect(placementBlocker({ x: 0, y: 4, w: 2, h: 2 }, "metric", [])).toEqual({
      kind: "tooSmall",
      minimum: { w: 3, h: 2 },
    });
  });
});

describe("nudgePlacement", () => {
  const widget = { x: 0, y: 0, w: 3, h: 2 };

  it("moves one cell when that is free", () => {
    expect(nudgePlacement(widget, 1, 0, [])).toEqual({ ...widget, x: 1 });
    expect(nudgePlacement(widget, 0, 1, [])).toEqual({ ...widget, y: 1 });
  });

  it("jumps over a widget in the way to the nearest free spot", () => {
    const blocker = { x: 3, y: 0, w: 2, h: 2 };
    expect(nudgePlacement({ ...widget, x: 0 }, 1, 0, [blocker])).toEqual({
      ...widget,
      x: 5,
    });
  });

  it("stops at the edge or when nothing is free that way", () => {
    expect(nudgePlacement(widget, -1, 0, [])).toBe(null);
    expect(nudgePlacement(widget, 0, -1, [])).toBe(null);
    expect(
      nudgePlacement({ ...widget, x: 0 }, 1, 0, [{ x: 3, y: 0, w: 9, h: 1 }]),
    ).toBe(null);
  });
});

describe("resizePlacement", () => {
  it("grows and shrinks the right and bottom edges", () => {
    const widget = { x: 2, y: 2, w: 4, h: 3 };
    expect(resizePlacement(widget, 1, 0, "metric")).toEqual({
      ...widget,
      w: 5,
    });
    expect(resizePlacement(widget, 0, -1, "metric")).toEqual({
      ...widget,
      h: 2,
    });
  });

  it("refuses to shrink below the minimum or grow past the grid", () => {
    expect(resizePlacement({ x: 0, y: 0, w: 3, h: 2 }, -1, 0, "metric")).toBe(
      null,
    );
    expect(resizePlacement({ x: 9, y: 0, w: 3, h: 2 }, 1, 0, "metric")).toBe(
      null,
    );
  });

  it("lets a widget below its minimum grow towards it", () => {
    expect(resizePlacement({ x: 0, y: 0, w: 2, h: 2 }, 1, 0, "metric")).toEqual(
      {
        x: 0,
        y: 0,
        w: 3,
        h: 2,
      },
    );
  });
});

// Grids of other formats (ADR 0017; #284 edits custom layouts on them).
describe("format grids", () => {
  it("measures a portrait canvas like screen view places the cells", () => {
    const canvas = SCREEN_FORMATS["9x16"].reference;
    const metrics = gridMetrics(canvas, true, "9x16");
    const frame = screenFrame(canvas, "9x16", true);
    const rect = placementRect({ x: 2, y: 5, w: 1, h: 1 }, frame);
    expect(metrics.left + 2 * (metrics.cellWidth + metrics.gap)).toBeCloseTo(
      rect.x,
      6,
    );
    expect(metrics.top + 5 * (metrics.cellHeight + metrics.gap)).toBeCloseTo(
      rect.y,
      6,
    );
    expect(metrics.cellWidth).toBeCloseTo(rect.width, 6);
    expect(pointToCell({ x: 99999, y: 99999 }, metrics, "9x16")).toEqual({
      column: 5,
      row: 13,
    });
  });

  it("keeps drags, nudges and resizes inside a 6 × 14 grid", () => {
    expect(
      dragPlacement(
        { x: 0, y: 0, w: 3, h: 2 },
        "move",
        { dx: 10, dy: 20 },
        "metric",
        "9x16",
      ),
    ).toEqual({ x: 3, y: 12, w: 3, h: 2 });
    expect(nudgePlacement({ x: 3, y: 0, w: 3, h: 2 }, 1, 0, [], "9x16")).toBe(
      null,
    );
    expect(
      nudgePlacement({ x: 0, y: 11, w: 3, h: 2 }, 0, 1, [], "9x16"),
    ).toEqual({ x: 0, y: 12, w: 3, h: 2 });
    expect(
      resizePlacement({ x: 0, y: 0, w: 6, h: 2 }, 1, 0, "metric", "9x16"),
    ).toBe(null);
    expect(
      placementBlocker({ x: 4, y: 0, w: 3, h: 2 }, "metric", [], "9x16"),
    ).toEqual({ kind: "outside" });
    expect(
      placementBlocker({ x: 0, y: 12, w: 3, h: 2 }, "metric", [], "9x16"),
    ).toBe(null);
    // The same placement is outside on the 16:9 grid.
    expect(placementBlocker({ x: 0, y: 12, w: 3, h: 2 }, "metric", [])).toEqual(
      { kind: "outside" },
    );
  });

  it("finds free spots and drops on the format's grid", () => {
    expect(
      nearestFreePlacement(
        { x: 0, y: 0, w: 12, h: 2 },
        "metric",
        [{ x: 0, y: 0, w: 6, h: 13 }],
        "9x16",
      ),
    ).toEqual(null);
    expect(
      nearestFreePlacement(
        { x: 0, y: 0, w: 12, h: 2 },
        "metric",
        [{ x: 0, y: 0, w: 6, h: 12 }],
        "9x16",
      ),
    ).toEqual({ x: 0, y: 12, w: 6, h: 2 });
    const canvas = SCREEN_FORMATS["21x9"].reference;
    const metrics = gridMetrics(canvas, false, "21x9");
    const drop = dropPlacement(
      { x: canvas.width - 1, y: canvas.height - 1 },
      metrics,
      "metric",
      { w: 4, h: 3 },
      [],
      "21x9",
    );
    expect(drop).toEqual({
      placement: { x: 12, y: 5, w: 4, h: 3 },
      blocked: false,
    });
  });
});
