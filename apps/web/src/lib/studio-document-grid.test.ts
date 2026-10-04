import { describe, expect, it } from "vitest";

import type { Dashboard, DashboardWidget } from "@netrics/contracts";

import {
  createStudioReducer,
  documentProblems,
  initialStudioState,
  isDirty,
  type StudioAction,
  type StudioState,
} from "./studio-document";

// Moving and resizing widgets on the grid (#224): the reducer's placement
// actions, one undo step each, refused (and announced) when they would
// overlap, leave the grid or go below the minimum size.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function metric(id: number, x: number, y: number): DashboardWidget {
  return {
    type: "metric",
    id: ID(id),
    x,
    y,
    w: 4,
    h: 3,
    title: id === 11 ? "Downloads" : null,
    connectionId: ID(9),
    metricKey: "downloads",
    aggregation: "sum",
    period: "last_7_days",
    dimensions: {},
    displayCurrency: null,
    resourceName: null,
    allResourcesName: null,
    options: { showSparkline: true, showChange: true },
  };
}

const text: DashboardWidget = {
  type: "text",
  id: ID(13),
  x: 0,
  y: 6,
  w: 4,
  h: 2,
  title: null,
  text: "Hello",
  options: { size: "body", align: "start" },
};

function dashboard(): Dashboard {
  return {
    id: ID(1),
    name: "Overview",
    projectId: null,
    version: 3,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    settings: {
      showHeader: true,
      autoAdvance: true,
      defaultSlideSeconds: 20,
      transition: "fade",
      themeBuiltin: "netrics_dark",
      themeId: null,
      accentColor: null,
      logoImageId: null,
    },
    slides: [
      {
        id: ID(2),
        position: 0,
        name: "Sales",
        durationSeconds: null,
        enabled: true,
        background: null,
        // Downloads at columns 1–4, another metric at 9–12, text below.
        widgets: [metric(11, 0, 0), metric(12, 8, 0), text],
      },
      {
        id: ID(3),
        position: 1,
        name: "Brand",
        durationSeconds: null,
        enabled: true,
        background: null,
        widgets: [],
      },
    ],
    tiles: [],
  };
}

function run(state: StudioState, ...actions: StudioAction[]) {
  const reduce = createStudioReducer(() => ID(999));
  return actions.reduce(reduce, state);
}

const placement = (state: StudioState, id: number) => {
  const widget = state.draft.slides
    .flatMap((slide) => slide.widgets)
    .find((w) => w.id === ID(id))!;
  return { x: widget.x, y: widget.y, w: widget.w, h: widget.h };
};

describe("placeWidget (a finished drag)", () => {
  it("moves a widget, selects it and announces where it went", () => {
    const state = run(initialStudioState(dashboard(), "en"), {
      type: "placeWidget",
      widgetId: ID(11),
      placement: { x: 4, y: 1, w: 4, h: 3 },
    });
    expect(placement(state, 11)).toEqual({ x: 4, y: 1, w: 4, h: 3 });
    expect(state.selectedWidgetId).toBe(ID(11));
    expect(state.announcement?.text).toBe(
      "Downloads (metric) moved to column 5, row 2.",
    );
    expect(isDirty(state)).toBe(true);
    expect(documentProblems(state.draft, "en")).toEqual([]);
  });

  it("resizes a widget and says the new size", () => {
    const resized = run(initialStudioState(dashboard(), "en"), {
      type: "placeWidget",
      widgetId: ID(11),
      placement: { x: 0, y: 0, w: 6, h: 4 },
    });
    expect(resized.announcement?.text).toBe(
      "Downloads (metric) resized to 6 × 4 cells.",
    );
    const fromCorner = run(initialStudioState(dashboard(), "en"), {
      type: "placeWidget",
      widgetId: ID(12),
      placement: { x: 7, y: 1, w: 5, h: 2 },
    });
    expect(fromCorner.announcement?.text).toBe(
      "Metric resized to 5 × 2 cells at column 8, row 2.",
    );
  });

  it("is one undo step per drop, and redo puts it back", () => {
    const start = initialStudioState(dashboard(), "en");
    const moved = run(
      start,
      {
        type: "placeWidget",
        widgetId: ID(11),
        placement: { x: 4, y: 0, w: 4, h: 3 },
      },
      {
        type: "placeWidget",
        widgetId: ID(11),
        placement: { x: 4, y: 3, w: 4, h: 3 },
      },
    );
    expect(moved.past).toHaveLength(2);
    const undone = run(moved, { type: "undo" });
    expect(placement(undone, 11)).toEqual({ x: 4, y: 0, w: 4, h: 3 });
    const twice = run(undone, { type: "undo" });
    expect(placement(twice, 11)).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    expect(isDirty(twice)).toBe(false);
    expect(placement(run(twice, { type: "redo" }), 11)).toEqual({
      x: 4,
      y: 0,
      w: 4,
      h: 3,
    });
  });

  it("refuses a drop on another widget, without an undo step", () => {
    const start = initialStudioState(dashboard(), "en");
    const state = run(start, {
      type: "placeWidget",
      widgetId: ID(11),
      placement: { x: 6, y: 0, w: 4, h: 3 },
    });
    expect(state.draft).toBe(start.draft);
    expect(state.past).toEqual([]);
    expect(state.announcement?.text).toBe(
      "Downloads (metric) would overlap Metric; it stays where it was.",
    );
  });

  it("refuses placements off the grid or below the minimum size", () => {
    const start = initialStudioState(dashboard(), "en");
    const outside = run(start, {
      type: "placeWidget",
      widgetId: ID(11),
      placement: { x: 10, y: 0, w: 4, h: 3 },
    });
    expect(outside.draft).toBe(start.draft);
    expect(outside.announcement?.text).toMatch(/must stay on the slide/);
    const small = run(start, {
      type: "placeWidget",
      widgetId: ID(11),
      placement: { x: 0, y: 0, w: 2, h: 3 },
    });
    expect(small.draft).toBe(start.draft);
    expect(small.announcement?.text).toBe(
      "Downloads (metric) must be at least 3 × 2 cells.",
    );
  });

  it("ignores a drop where the widget already is", () => {
    const start = initialStudioState(dashboard(), "en");
    const state = run(start, {
      type: "placeWidget",
      widgetId: ID(11),
      placement: { x: 0, y: 0, w: 4, h: 3 },
    });
    expect(state.draft).toBe(start.draft);
    expect(state.past).toEqual([]);
  });

  it("ignores widgets that do not exist", () => {
    const start = initialStudioState(dashboard(), "en");
    expect(
      run(start, {
        type: "placeWidget",
        widgetId: ID(77),
        placement: { x: 0, y: 0, w: 4, h: 3 },
      }),
    ).toBe(start);
  });
});

describe("keyboard moves and resizes", () => {
  it("moves one cell per arrow key, each an undo step", () => {
    const state = run(
      initialStudioState(dashboard(), "en"),
      { type: "nudgeWidget", widgetId: ID(11), dx: 0, dy: 1 },
      { type: "nudgeWidget", widgetId: ID(11), dx: 1, dy: 0 },
    );
    expect(placement(state, 11)).toEqual({ x: 1, y: 1, w: 4, h: 3 });
    expect(state.past).toHaveLength(2);
    expect(state.announcement?.text).toBe(
      "Downloads (metric) moved to column 2, row 2.",
    );
    expect(state.selectedWidgetId).toBe(ID(11));
  });

  it("stops where nothing is free that way, and says so", () => {
    const state = run(
      initialStudioState(dashboard(), "en"),
      { type: "nudgeWidget", widgetId: ID(11), dx: 0, dy: 1 },
      { type: "nudgeWidget", widgetId: ID(11), dx: 0, dy: 1 },
      { type: "nudgeWidget", widgetId: ID(11), dx: 0, dy: 1 },
    );
    // Rows 2–6 hold it; the text widget takes rows 7–8.
    expect(placement(state, 11)).toEqual({ x: 0, y: 3, w: 4, h: 3 });
    const blocked = run(state, {
      type: "nudgeWidget",
      widgetId: ID(11),
      dx: 0,
      dy: 1,
    });
    expect(blocked.draft).toBe(state.draft);
    expect(blocked.past).toEqual(state.past);
    expect(blocked.announcement?.text).toBe(
      "Downloads (metric) cannot move further that way.",
    );
    const edge = run(initialStudioState(dashboard(), "en"), {
      type: "nudgeWidget",
      widgetId: ID(11),
      dx: -1,
      dy: 0,
    });
    expect(edge.past).toEqual([]);
  });

  it("jumps over a widget to the next free spot in the row", () => {
    const state = run(
      initialStudioState(dashboard(), "en"),
      {
        type: "placeWidget",
        widgetId: ID(12),
        placement: { x: 4, y: 0, w: 4, h: 3 },
      },
      { type: "nudgeWidget", widgetId: ID(11), dx: 1, dy: 0 },
    );
    expect(placement(state, 11)).toEqual({ x: 8, y: 0, w: 4, h: 3 });
  });

  it("resizes with Shift+arrows and stops at the minimum and the edge", () => {
    const start = initialStudioState(dashboard(), "en");
    const wider = run(start, {
      type: "resizeWidgetBy",
      widgetId: ID(11),
      dw: 0,
      dh: 1,
    });
    expect(placement(wider, 11)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(wider.announcement?.text).toBe(
      "Downloads (metric) resized to 4 × 4 cells.",
    );
    const smallest = run(
      start,
      { type: "resizeWidgetBy", widgetId: ID(11), dw: -1, dh: 0 },
      { type: "resizeWidgetBy", widgetId: ID(11), dw: -1, dh: 0 },
    );
    expect(placement(smallest, 11)).toEqual({ x: 0, y: 0, w: 3, h: 3 });
    expect(smallest.past).toHaveLength(1);
    expect(smallest.announcement?.text).toBe(
      "Downloads (metric) is at its minimum size, 3 × 2 cells.",
    );
    const edge = run(start, {
      type: "resizeWidgetBy",
      widgetId: ID(12),
      dw: 1,
      dh: 0,
    });
    expect(edge.draft).toBe(start.draft);
    expect(edge.announcement?.text).toBe("Metric is at the edge of the slide.");
  });

  it("refuses a resize into another widget", () => {
    const start = run(initialStudioState(dashboard(), "en"), {
      type: "placeWidget",
      widgetId: ID(12),
      placement: { x: 4, y: 0, w: 4, h: 3 },
    });
    const state = run(start, {
      type: "resizeWidgetBy",
      widgetId: ID(11),
      dw: 1,
      dh: 0,
    });
    expect(state.draft).toBe(start.draft);
    expect(state.announcement?.text).toBe(
      "Downloads (metric) would overlap Metric; it stays where it was.",
    );
  });

  it("deletes the widget with Delete, and undo brings it back", () => {
    const start = initialStudioState(dashboard(), "en");
    const deleted = run(
      start,
      { type: "selectWidget", widgetId: ID(11) },
      { type: "deleteWidget", widgetId: ID(11) },
    );
    expect(deleted.selectedWidgetId).toBe(null);
    expect(deleted.draft.slides[0]!.widgets).toHaveLength(2);
    const back = run(deleted, { type: "undo" });
    expect(back.draft.slides[0]!.widgets).toHaveLength(3);
    expect(isDirty(back)).toBe(false);
  });
});
