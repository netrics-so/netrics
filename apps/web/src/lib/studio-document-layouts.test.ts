import { describe, expect, it } from "vitest";

import {
  createDashboardRequestSchema,
  replaceDashboardRequestSchema,
  type Dashboard,
  type DashboardWidget,
} from "@netrics/contracts";
import type { ScreenFormat } from "@netrics/domain";

import { ApiError, apiErrorMessage } from "./api";

import {
  createStudioReducer,
  documentProblems,
  initialStudioState,
  isDirty,
  primaryOf,
  toCopyRequest,
  toReplaceRequest,
  type StudioAction,
  type StudioState,
} from "./studio-document";
import { customLayoutOf } from "./studio-layouts";

// Custom layouts per format in the Studio's reducer (ADR 0017 section 4,
// #284): customise and reset, moves and pages in a format, hiding, review
// flags, undo, what a Save sends, and a dashboard designed in 9:16.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function ids() {
  let next = 1000;
  return () => ID(next++);
}

function metric(n: number, x: number, y: number): DashboardWidget {
  return {
    type: "metric",
    id: ID(n),
    x,
    y,
    w: 3,
    h: 2,
    title: `KPI ${n}`,
    connectionId: ID(9),
    metricKey: "downloads",
    aggregation: "sum",
    period: "last_7_days",
    dimensions: {},
    displayCurrency: null,
    resourceName: null,
    allResourcesName: null,
    options: { showSparkline: true, showChange: true },
  } as DashboardWidget;
}

function line(n: number, x: number, y: number): DashboardWidget {
  return {
    ...metric(n, x, y),
    type: "line",
    w: 6,
    h: 6,
    options: { showPrevious: false, showAxis: true },
  } as DashboardWidget;
}

/** The Overview template's shape: four metrics, then two charts. */
const OVERVIEW = [
  metric(11, 0, 0),
  metric(12, 3, 0),
  metric(13, 6, 0),
  metric(14, 9, 0),
  line(15, 0, 2),
  line(16, 6, 2),
];

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
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
        widgets: OVERVIEW,
        layouts: [],
        formatWarnings: [],
      },
    ],
    primaryFormat: "16x9",
    tiles: [],
    ...overrides,
  };
}

function run(state: StudioState, ...actions: StudioAction[]) {
  const reduce = createStudioReducer(ids());
  return actions.reduce(reduce, state);
}

const portrait: ScreenFormat = "9x16";
const customize: StudioAction = {
  type: "customizeFormat",
  slideId: ID(2),
  format: portrait,
};

function layoutOf(state: StudioState, format: ScreenFormat = portrait) {
  return customLayoutOf(state.draft.slides[0]!, primaryOf(state.draft), format);
}

function at(state: StudioState, widgetId: string) {
  return layoutOf(state)!.placements.find((p) => p.id === widgetId)!;
}

describe("customise and back to automatic", () => {
  it("copies the auto layout as one undo step, then removes it", () => {
    const start = initialStudioState(dashboard(), "en");
    const customized = run(start, customize);
    expect(isDirty(customized)).toBe(true);
    expect(customized.draft.slides[0]!.layouts!.map((l) => l.format)).toEqual([
      "9x16",
    ]);
    expect(layoutOf(customized)!.pages).toBe(2);
    expect(customized.announcement?.text).toBe(
      "This slide is now arranged by hand in 9:16, on 2 pages.",
    );
    // Customising twice changes nothing.
    expect(run(customized, customize).draft).toBe(customized.draft);
    const reset = run(customized, {
      type: "resetFormat",
      slideId: ID(2),
      format: portrait,
    });
    expect(reset.draft.slides[0]!.layouts).toEqual([]);
    expect(isDirty(reset)).toBe(false);
    expect(run(reset, { type: "undo" }).draft).toEqual(customized.draft);
  });

  it("never customises the primary format", () => {
    const start = initialStudioState(dashboard(), "en");
    const state = run(start, { ...customize, format: "16x9" });
    expect(state).toBe(start);
  });

  it("announces in German", () => {
    const state = run(initialStudioState(dashboard(), "de"), customize);
    expect(state.announcement?.text).toBe(
      "Diese Folie ist in 9:16 jetzt von Hand angeordnet, auf 2 Seiten.",
    );
  });
});

describe("editing a custom layout", () => {
  const customized = run(initialStudioState(dashboard(), "en"), customize);

  it("moves and resizes in the format only, leaving the primary alone", () => {
    const before = at(customized, ID(16));
    const moved = run(customized, {
      type: "nudgeWidget",
      widgetId: ID(16),
      dx: 0,
      dy: -1,
      format: portrait,
    });
    expect(at(moved, ID(16)).y).toBe(before.y - 1);
    expect(moved.draft.slides[0]!.widgets).toEqual(OVERVIEW);
    expect(moved.selectedWidgetId).toBe(ID(16));
    expect(moved.announcement?.text).toContain("moved to column 1");
    const placed = run(moved, {
      type: "placeWidget",
      widgetId: ID(16),
      placement: { x: 0, y: 0, w: 6, h: 6 },
      format: portrait,
    });
    expect(at(placed, ID(16))).toMatchObject({ x: 0, y: 0, w: 6, h: 6 });
  });

  it("refuses a move onto another widget of the page, without an undo step", () => {
    const state = run(customized, {
      type: "placeWidget",
      widgetId: ID(11),
      placement: { x: 3, y: 0, w: 3, h: 3 },
      format: portrait,
    });
    expect(state.draft).toBe(customized.draft);
    expect(state.past).toHaveLength(customized.past.length);
    expect(state.announcement?.text).toBe(
      "KPI 11 (metric) would overlap KPI 12 (metric); it stays where it was.",
    );
  });

  it("adds a page, moves a widget there and removes only empty pages", () => {
    const state = run(
      customized,
      { type: "addLayoutPage", slideId: ID(2), format: portrait },
      { type: "moveWidgetToPage", widgetId: ID(16), format: portrait, page: 2 },
    );
    expect(layoutOf(state)!.pages).toBe(3);
    expect(at(state, ID(16)).page).toBe(2);
    expect(state.announcement?.text).toBe(
      "KPI 16 (line chart) moved to page 3.",
    );
    const refused = run(state, {
      type: "removeLayoutPage",
      slideId: ID(2),
      format: portrait,
      page: 2,
    });
    expect(refused.draft).toBe(state.draft);
    expect(refused.announcement?.text).toContain("Page 3 still shows widgets");
    const removed = run(state, {
      type: "removeLayoutPage",
      slideId: ID(2),
      format: portrait,
      page: 1,
    });
    expect(layoutOf(removed)!.pages).toBe(2);
    expect(at(removed, ID(16)).page).toBe(1);
  });

  it("hides a widget in the format and shows it again", () => {
    const hidden = run(customized, {
      type: "setWidgetHidden",
      widgetId: ID(12),
      format: portrait,
      hidden: true,
    });
    expect(at(hidden, ID(12)).hidden).toBe(true);
    expect(hidden.draft.slides[0]!.widgets).toHaveLength(6);
    expect(hidden.announcement?.text).toBe(
      "KPI 12 (metric) is hidden in 9:16.",
    );
    const shown = run(hidden, {
      type: "setWidgetHidden",
      widgetId: ID(12),
      format: portrait,
      hidden: false,
    });
    expect(at(shown, ID(12)).hidden).toBe(false);
    expect(shown.announcement?.text).toBe(
      "KPI 12 (metric) is shown again in 9:16, on page 1.",
    );
  });

  it("flags widgets added in the primary and clears the flag on review", () => {
    // A widget added to the 16:9 primary: placed in 9:16 and flagged.
    const added = run(
      customized,
      {
        type: "deleteWidget",
        widgetId: ID(16),
      },
      {
        type: "addWidget",
        widget: {
          type: "text",
          title: null,
          text: "## Hello",
          options: { size: "body", align: "start" },
        },
      },
    );
    const newId = added.selectedWidgetId!;
    expect(at(added, newId).autoPlaced).toBe(true);
    // Deleting the line chart took it out of the custom layout too.
    expect(
      added.draft.slides[0]!.layouts![0]!.placements.some(
        (p) => p.widgetId === ID(16),
      ),
    ).toBe(false);
    const confirmed = run(added, {
      type: "confirmPlacement",
      slideId: ID(2),
      format: portrait,
      widgetId: newId,
    });
    expect(at(confirmed, newId).autoPlaced).toBe(false);
    expect(confirmed.announcement?.text).toBe("Text looks good in 9:16.");
    // Moving it clears the flag too.
    const placed = at(added, newId);
    const moved = run(added, {
      type: "resizeWidgetBy",
      widgetId: newId,
      dw: 0,
      dh: -1,
      format: portrait,
    });
    expect(placed.h).toBeGreaterThanOrEqual(2);
    expect(at(moved, newId)).toMatchObject({
      h: placed.h - 1,
      autoPlaced: false,
    });
    const all = run(added, {
      type: "confirmPlacement",
      slideId: ID(2),
      format: portrait,
      widgetId: null,
    });
    expect(layoutOf(all)!.placements.some((p) => p.autoPlaced)).toBe(false);
  });

  it("copies the layout with a duplicated slide, renamed to the copy's widgets", () => {
    const state = run(customized, { type: "duplicateSlide", slideId: ID(2) });
    const copy = state.draft.slides[1]!;
    const widgetIds = new Set(copy.widgets.map((w) => w.id));
    expect(
      copy.layouts![0]!.placements.every((p) => widgetIds.has(p.widgetId)),
    ).toBe(true);
    expect(copy.layouts![0]!.placements).toHaveLength(6);
  });
});

describe("what a save sends", () => {
  it("sends each slide's custom layouts, completed and valid", () => {
    const state = run(initialStudioState(dashboard(), "en"), customize, {
      type: "setWidgetHidden",
      widgetId: ID(12),
      format: portrait,
      hidden: true,
    });
    const body = toReplaceRequest(state);
    expect(() => replaceDashboardRequestSchema.parse(body)).not.toThrow();
    const layouts = body.slides![0]!.layouts!;
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({ format: "9x16", pages: 2 });
    expect(
      layouts[0]!.placements.find((p) => p.widgetId === ID(12))!.hidden,
    ).toBe(true);
    expect(body).not.toHaveProperty("primaryFormat");
  });

  it("sends `layouts: []` after back to automatic, so the server drops them", () => {
    const stored = run(initialStudioState(dashboard(), "en"), customize).draft
      .slides[0]!.layouts!;
    const loaded = initialStudioState(
      dashboard({
        slides: [{ ...dashboard().slides[0]!, layouts: stored }],
      }),
      "en",
    );
    const reset = run(loaded, {
      type: "resetFormat",
      slideId: ID(2),
      format: portrait,
    });
    expect(isDirty(reset)).toBe(true);
    expect(toReplaceRequest(reset).slides![0]!.layouts).toEqual([]);
  });

  it("asks for a re-base with another primary format", () => {
    const state = initialStudioState(dashboard(), "en");
    const body = toReplaceRequest(state, { primaryFormat: "9x16" });
    expect(body.primaryFormat).toBe("9x16");
    expect(() => replaceDashboardRequestSchema.parse(body)).not.toThrow();
    expect(
      toReplaceRequest(state, { primaryFormat: "16x9" }),
    ).not.toHaveProperty("primaryFormat");
  });

  it("keeps custom layouts and the primary format in a copy", () => {
    const state = run(initialStudioState(dashboard(), "en"), customize);
    const body = toCopyRequest(state.draft, "Copy");
    expect(() => createDashboardRequestSchema.parse(body)).not.toThrow();
    const slide = body.slides![0]!;
    expect(slide).not.toHaveProperty("id");
    // Widget ids tie the layout to its widgets; the server issues new ones.
    expect(slide.widgets[0]).toHaveProperty("id");
    expect(slide.layouts).toHaveLength(1);
    const portraitCopy = toCopyRequest(
      initialStudioState(dashboard({ primaryFormat: "9x16", slides: [] }), "en")
        .draft,
      "Copy",
    );
    expect(portraitCopy.primaryFormat).toBe("9x16");
  });
});

describe("a dashboard designed in 9:16", () => {
  const tall = dashboard({
    primaryFormat: "9x16",
    slides: [{ ...dashboard().slides[0]!, widgets: [] }],
  });

  it("adds widgets on the 6 × 14 grid", () => {
    const state = run(
      initialStudioState(tall, "en"),
      ...Array.from({ length: 4 }, (): StudioAction => ({
        type: "addWidget",
        widget: {
          type: "text",
          title: null,
          text: "Hi",
          options: { size: "body", align: "start" },
        },
      })),
    );
    const widgets = state.draft.slides[0]!.widgets;
    expect(widgets).toHaveLength(4);
    expect(widgets.every((w) => w.x + w.w <= 6 && w.y + w.h <= 14)).toBe(true);
    // Text is 4 × 2 by default: one per row on a 6-column grid.
    expect(widgets.map((w) => w.y)).toEqual([0, 2, 4, 6]);
    expect(documentProblems(state.draft, "en")).toEqual([]);
  });

  it("flags a widget outside the 6-column grid, and allows row 13", () => {
    const state = initialStudioState(
      dashboard({
        primaryFormat: "9x16",
        slides: [
          {
            ...dashboard().slides[0]!,
            widgets: [metric(11, 4, 0), metric(12, 0, 12)],
          },
        ],
      }),
      "en",
    );
    const problems = documentProblems(state.draft, "en");
    expect(problems.map((p) => p.widgetId)).toEqual([ID(11)]);
  });

  it("moves with the keyboard inside the portrait grid", () => {
    const state = initialStudioState(
      dashboard({
        primaryFormat: "9x16",
        slides: [{ ...dashboard().slides[0]!, widgets: [metric(11, 0, 11)] }],
      }),
      "en",
    );
    const down = run(state, {
      type: "nudgeWidget",
      widgetId: ID(11),
      dx: 0,
      dy: 1,
    });
    expect(down.draft.slides[0]!.widgets[0]!.y).toBe(12);
    const right = run(down, {
      type: "nudgeWidget",
      widgetId: ID(11),
      dx: 3,
      dy: 0,
    });
    expect(right.draft.slides[0]!.widgets[0]!.x).toBe(3);
    const off = run(right, {
      type: "nudgeWidget",
      widgetId: ID(11),
      dx: 1,
      dy: 0,
    });
    expect(off.draft).toBe(right.draft);
  });

  it("loads the primary format from the dashboard", () => {
    expect(primaryOf(initialStudioState(tall, "en").draft)).toBe("9x16");
    expect(primaryOf({})).toBe("16x9");
  });
});

describe("a refused change of the primary format", () => {
  it("explains both 409 cases in English and German", () => {
    const overflow = new ApiError(409, "format_has_overflow");
    const hidden = new ApiError(409, "format_has_hidden_widgets");
    expect(apiErrorMessage(overflow, "en")).toContain(
      "a slide continues on more than one page there",
    );
    expect(apiErrorMessage(hidden, "en")).toContain(
      "a slide hides widgets there",
    );
    expect(apiErrorMessage(overflow, "de")).toContain(
      "Eine Folie geht dort auf mehr als einer Seite weiter",
    );
    expect(apiErrorMessage(hidden, "de")).toContain(
      "Eine Folie blendet dort Widgets aus",
    );
    expect(
      apiErrorMessage(new ApiError(400, "layout_widgets_overlap"), "en"),
    ).toBe("Two widgets overlap in a custom layout.");
  });
});
