import { describe, expect, it } from "vitest";

import type { Dashboard, DashboardWidget } from "@netrics/contracts";
import {
  STUDIO_LIMITS,
  STUDIO_REFERENCE_CANVAS,
  studioLayout,
  widgetRect,
} from "@netrics/domain";

import {
  createStudioReducer,
  documentProblems,
  initialStudioState,
  isDirty,
  type StudioAction,
  type StudioState,
} from "./studio-document";
import {
  dropPlacement,
  gridMetrics,
  nearestFreePlacement,
} from "./studio-grid";
import {
  textOverflows,
  textSizeToFit,
  unreadableCounts,
  tableRowsCut,
  unreadableLabels,
  widthToFit,
} from "./studio-readability";
import { textWidgetLayout } from "./studio-widgets";

// #241: free spots, readability warnings, and duplicate / paste / drop.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function metric(
  id: number,
  x: number,
  y: number,
  title: string | null = null,
  w = 4,
): DashboardWidget {
  return {
    type: "metric",
    id: ID(id),
    x,
    y,
    w,
    h: 3,
    title,
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

const LONG =
  "Downloads of every app in every territory and store this quarter so far";

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
        widgets: [metric(11, 0, 0, "Downloads"), metric(12, 8, 0)],
        layouts: [],
        formatWarnings: [],
      },
      {
        id: ID(3),
        position: 1,
        name: "Brand",
        durationSeconds: null,
        enabled: true,
        background: null,
        widgets: [metric(13, 0, 0, LONG, 3)],
        layouts: [],
        formatWarnings: [],
      },
    ],
    primaryFormat: "16x9",
    tiles: [],
  };
}

function run(state: StudioState, ...actions: StudioAction[]) {
  let next = 500;
  const reduce = createStudioReducer(() => ID(next++));
  return actions.reduce(reduce, state);
}

const slideWidgets = (state: StudioState, index: number) =>
  state.draft.slides[index]!.widgets;

describe("nearestFreePlacement", () => {
  it("takes the free spot closest to the target at its size", () => {
    const others = [{ x: 0, y: 0, w: 4, h: 3 }];
    expect(
      nearestFreePlacement({ x: 0, y: 0, w: 4, h: 3 }, "metric", others),
    ).toEqual({ x: 4, y: 0, w: 4, h: 3 });
    expect(
      nearestFreePlacement({ x: 1, y: 4, w: 4, h: 3 }, "metric", others),
    ).toEqual({ x: 1, y: 4, w: 4, h: 3 });
  });

  it("falls back to the minimum size, then to nothing", () => {
    // Columns 0–9 are full; two columns are left, rows 0–7.
    const wall = [{ x: 0, y: 0, w: 10, h: 8 }];
    expect(
      nearestFreePlacement({ x: 0, y: 0, w: 4, h: 3 }, "text", wall),
    ).toEqual({ x: 10, y: 0, w: 2, h: 1 });
    expect(
      nearestFreePlacement({ x: 0, y: 0, w: 4, h: 3 }, "metric", wall),
    ).toBe(null);
  });
});

describe("dropPlacement", () => {
  const metrics = gridMetrics(STUDIO_REFERENCE_CANVAS, true);
  const centreOf = (x: number, y: number) => {
    const rect = widgetRect(
      { x, y, w: 1, h: 1 },
      STUDIO_REFERENCE_CANVAS,
      true,
    );
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };

  it("centres the new widget on the pointer, snapped and inside the grid", () => {
    expect(
      dropPlacement(centreOf(6, 4), metrics, "metric", { w: 4, h: 3 }, []),
    ).toEqual({ placement: { x: 4, y: 3, w: 4, h: 3 }, blocked: false });
    expect(
      dropPlacement(centreOf(11, 7), metrics, "metric", { w: 4, h: 3 }, []),
    ).toEqual({ placement: { x: 8, y: 5, w: 4, h: 3 }, blocked: false });
  });

  it("shrinks to the minimum size where the usual size overlaps", () => {
    const others = [{ x: 0, y: 0, w: 12, h: 5 }];
    // Near the bottom of row 6: a 4 × 3 metric centred there would start
    // in row 5 (taken); a 3 × 2 one starts in row 6.
    const point = centreOf(6, 5);
    point.y += metrics.cellHeight * 0.4;
    expect(
      dropPlacement(point, metrics, "metric", { w: 4, h: 3 }, others),
    ).toEqual({ placement: { x: 5, y: 5, w: 3, h: 2 }, blocked: false });
  });

  it("is blocked on a full area", () => {
    const others = [{ x: 0, y: 0, w: 12, h: 8 }];
    expect(
      dropPlacement(centreOf(6, 4), metrics, "text", { w: 4, h: 2 }, others)
        .blocked,
    ).toBe(true);
  });
});

describe("readability warnings", () => {
  const label = (widget: DashboardWidget) => widget.title ?? "Downloads";

  it("flags exactly the widgets studioLayout.fits rejects", () => {
    const document = initialStudioState(dashboard(), "en").draft;
    const found = unreadableLabels(document, label, 1, "en");
    expect(found.map((f) => f.widgetId)).toEqual([ID(13)]);
    for (const widget of document.slides.flatMap((s) => s.widgets)) {
      expect(found.some((f) => f.widgetId === widget.id)).toBe(
        !studioLayout.fits(label(widget), widget, { fontScale: 1 }),
      );
    }
  });

  it("explains the fix: the width that fits, or a shorter title", () => {
    const document = initialStudioState(dashboard(), "en").draft;
    const [cut] = unreadableLabels(document, label, 1, "en");
    const width = widthToFit(LONG, { type: "metric", w: 3, h: 3 }, 1);
    expect(width).not.toBe(null);
    expect(width!).toBeGreaterThan(3);
    expect(studioLayout.fits(LONG, { type: "metric", w: width!, h: 3 })).toBe(
      true,
    );
    expect(
      studioLayout.fits(LONG, { type: "metric", w: width! - 1, h: 3 }),
    ).toBe(false);
    expect(cut!.fitsAtWidth).toBe(width);
    expect(cut!.hint).toBe(
      `The title is cut off on TVs. Make it ${width} cells wide or shorten the title.`,
    );
  });

  it("uses the theme's font scale, as screens do", () => {
    const document = initialStudioState(dashboard(), "en").draft;
    const title = "Downloads of every app this week";
    const widget = { type: "metric" as const, w: 3, h: 3 };
    // Pick a title that fits at scale 1 but not at 1.3.
    expect(studioLayout.fits(title, widget, { fontScale: 1 })).toBe(true);
    expect(studioLayout.fits(title, widget, { fontScale: 1.3 })).toBe(false);
    document.slides[1]!.widgets = [metric(13, 0, 0, title, 3)];
    expect(unreadableLabels(document, label, 1, "en")).toEqual([]);
    expect(unreadableLabels(document, label, 1.3, "en")).toHaveLength(1);
  });

  it("counts cut-off labels per slide and ignores non-data widgets", () => {
    const document = initialStudioState(dashboard(), "en").draft;
    document.slides[0]!.widgets.push({
      type: "text",
      id: ID(20),
      x: 0,
      y: 4,
      w: 2,
      h: 1,
      title: LONG,
      text: "Hello",
      options: { size: "body", align: "start" },
    });
    const counts = unreadableCounts(unreadableLabels(document, label, 1, "en"));
    expect([...counts]).toEqual([[ID(3), 1]]);
  });
});

describe("duplicate, paste and drop", () => {
  it("duplicates next to the source as one undo step", () => {
    const start = initialStudioState(dashboard(), "en");
    const state = run(start, { type: "duplicateWidget", widgetId: ID(11) });
    expect(slideWidgets(state, 0)).toHaveLength(3);
    const copy = slideWidgets(state, 0)[2]!;
    expect(copy).toMatchObject({
      id: ID(500),
      title: "Downloads",
      x: 4,
      y: 0,
      w: 4,
      h: 3,
    });
    expect(state.selectedWidgetId).toBe(ID(500));
    expect(state.announcement?.text).toBe(
      "Downloads (metric) duplicated at column 5, row 1.",
    );
    expect(state.past).toHaveLength(1);
    expect(documentProblems(state.draft, "en")).toEqual([]);
    const undone = run(state, { type: "undo" });
    expect(isDirty(undone)).toBe(false);
  });

  it("pastes onto another slide near the widget's own place", () => {
    const start = initialStudioState(dashboard(), "en");
    const source = slideWidgets(start, 0)[0]!;
    const state = run(
      start,
      { type: "selectSlide", slideId: ID(3) },
      { type: "pasteWidget", widget: source },
    );
    // Slide 2 has a 3-wide widget at 0,0: the nearest free 4 × 3 spot.
    expect(slideWidgets(state, 1)).toHaveLength(2);
    expect(slideWidgets(state, 1)[1]).toMatchObject({
      id: ID(500),
      title: "Downloads",
      x: 3,
      y: 0,
    });
    expect(state.selectedSlideId).toBe(ID(3));
    expect(state.announcement?.text).toBe(
      "Downloads (metric) pasted at column 4, row 1.",
    );
    // The source is untouched, pasting twice makes two copies.
    const twice = run(state, { type: "pasteWidget", widget: source });
    expect(slideWidgets(twice, 1)).toHaveLength(3);
    expect(slideWidgets(twice, 0)).toEqual(slideWidgets(start, 0));
  });

  it("refuses at the dashboard's data widget limit", () => {
    let state = initialStudioState(dashboard(), "en");
    for (let i = 0; i < STUDIO_LIMITS.dataWidgets + 2; i++) {
      state = run(state, { type: "duplicateWidget", widgetId: ID(11) });
    }
    const all = state.draft.slides.flatMap((s) => s.widgets);
    expect(all.length).toBeLessThanOrEqual(STUDIO_LIMITS.dataWidgets);
    expect(state.announcement?.text).toMatch(
      /at most \d+ (data )?widgets|no free space/,
    );
  });

  it("adds a dropped widget at its spot, and refuses a taken one", () => {
    const start = initialStudioState(dashboard(), "en");
    const widget = {
      type: "text" as const,
      title: null,
      text: "Hi",
      options: { size: "body" as const, align: "start" as const },
    };
    const added = run(start, {
      type: "addWidgetAt",
      widget,
      placement: { x: 4, y: 5, w: 4, h: 2 },
    });
    expect(slideWidgets(added, 0)[2]).toMatchObject({ x: 4, y: 5, w: 4, h: 2 });
    expect(added.announcement?.text).toBe("Text added at column 5, row 6.");
    const taken = run(start, {
      type: "addWidgetAt",
      widget,
      placement: { x: 2, y: 0, w: 4, h: 2 },
    });
    expect(taken.draft).toBe(start.draft);
    expect(taken.announcement?.text).toBe(
      "That spot is taken; the widget was not added.",
    );
  });
});

describe("text widgets cut off", () => {
  const text = (
    id: number,
    w: number,
    h: number,
    body: string,
  ): DashboardWidget => ({
    type: "text",
    id: ID(id),
    x: 0,
    y: 0,
    w,
    h,
    title: null,
    text: body,
    options: { size: "body", align: "start" },
  });
  const noLabel = () => "";

  it("flags text whose layout overflows, as the renderer does", () => {
    const document = initialStudioState(dashboard(), "en").draft;
    document.slides = [
      {
        ...document.slides[0]!,
        widgets: [
          text(30, 2, 1, "# Wurfel\nDaily numbers"),
          text(31, 3, 2, "# Wurfel\nDaily numbers"),
        ],
      },
    ];
    // The same flag the text renderer sets as data-overflow.
    for (const widget of document.slides[0]!.widgets) {
      const layout = textWidgetLayout({
        text: (widget as Extract<DashboardWidget, { type: "text" }>).text,
        size: "body",
        placement: widget,
        fontScale: 1,
        showHeader: true,
      });
      expect(
        unreadableLabels(document, noLabel, 1, "en").some(
          (found) => found.widgetId === widget.id,
        ),
      ).toBe(layout.overflow);
    }
    const [found] = unreadableLabels(document, noLabel, 1, "en");
    expect(found).toMatchObject({ kind: "text", widgetId: ID(30) });
    expect(found!.fitsAtSize).toEqual(
      textSizeToFit(
        {
          text: "# Wurfel\nDaily numbers",
          options: { size: "body" },
          w: 2,
          h: 1,
        },
        1,
        true,
      ),
    );
    const size = found!.fitsAtSize!;
    expect(found!.hint).toBe(
      `The text is cut off on TVs. Make it ${size.w} × ${size.h} cells or shorten the text.`,
    );
  });

  it("suggests the smallest size that fits, and nothing when none does", () => {
    const widget = {
      text: "# Wurfel\nDaily numbers",
      options: { size: "body" as const },
      w: 2,
      h: 1,
    };
    const size = textSizeToFit(widget, 1, true)!;
    expect(textOverflows(widget, size, 1, true)).toBe(false);
    // Nothing with fewer cells (at least as wide and tall as now) fits.
    for (let h = 1; h <= 8; h++) {
      for (let w = 2; w <= 12; w++) {
        if (w * h < size.w * size.h) {
          expect(textOverflows(widget, { w, h }, 1, true)).toBe(true);
        }
      }
    }
    const endless = { ...widget, text: "word ".repeat(3000) };
    expect(textSizeToFit(endless, 1, true)).toBe(null);
  });
});

describe("table rows on the canvas (ADR 0019 section 6)", () => {
  it("says how many rows a 4 × 4 table shows when more are asked for", () => {
    const size = { w: 4, h: 4 };
    expect(tableRowsCut("Page views", size, 8, 1.3, true)).toEqual({
      shown: 4,
      limit: 8,
    });
    expect(tableRowsCut("Page views", size, 6, 1, true)).toBeNull();
    expect(tableRowsCut("Page views", { w: 4, h: 6 }, 8, 1.3, true)).toBeNull();
  });
});
