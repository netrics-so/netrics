import { describe, expect, it } from "vitest";

import {
  replaceDashboardRequestSchema,
  createDashboardRequestSchema,
  type Dashboard,
  type DashboardWidget,
} from "@netrics/contracts";
import { STUDIO_LIMITS, slideLayoutProblem } from "@netrics/domain";

import {
  copyName,
  createStudioReducer,
  documentProblems,
  findFreePlacement,
  initialStudioState,
  insertionIndex,
  isDirty,
  reorderTarget,
  selectedSlide,
  toCopyRequest,
  toReplaceRequest,
  type StudioAction,
  type StudioState,
} from "./studio-document";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function ids() {
  let next = 1000;
  return () => ID(next++);
}

const metric: DashboardWidget = {
  type: "metric",
  id: ID(11),
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  title: null,
  connectionId: ID(9),
  metricKey: "downloads",
  aggregation: "sum",
  period: "last_7_days",
  dimensions: {},
  displayCurrency: null,
  resourceName: "Wurfel",
  allResourcesName: null,
  options: { showSparkline: true, showChange: true },
};

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
        widgets: [metric],
      },
    ],
    tiles: [],
    ...overrides,
  };
}

function run(state: StudioState, ...actions: StudioAction[]) {
  const reduce = createStudioReducer(ids());
  return actions.reduce(reduce, state);
}

const names = (state: StudioState) =>
  state.draft.slides.map((slide) => slide.name ?? slide.id);

describe("studio document reducer", () => {
  it("starts clean, on the first slide, with nothing to undo", () => {
    const state = initialStudioState(dashboard());
    expect(isDirty(state)).toBe(false);
    expect(state.selectedSlideId).toBe(ID(2));
    expect(state.past).toEqual([]);
  });

  it("adds slides after the selected one and selects them", () => {
    const state = run(
      initialStudioState(dashboard()),
      { type: "addSlide" },
      { type: "updateSlide", slideId: ID(1000), patch: { name: "Reviews" } },
      { type: "selectSlide", slideId: ID(2) },
      { type: "addSlide" },
    );
    expect(names(state)).toEqual(["Sales", ID(1001), "Reviews"]);
    expect(state.selectedSlideId).toBe(ID(1001));
    expect(isDirty(state)).toBe(true);
    expect(state.announcement?.text).toBe("Slide 2 added.");
  });

  it("stops at the slide limit and says so", () => {
    let state = initialStudioState(dashboard());
    for (let i = 0; i < STUDIO_LIMITS.slides + 2; i++) {
      state = run(state, { type: "addSlide" });
    }
    expect(state.draft.slides).toHaveLength(STUDIO_LIMITS.slides);
    expect(state.announcement?.text).toMatch(/at most 12 slides/);
  });

  it("duplicates a slide with new slide and widget ids", () => {
    const state = run(initialStudioState(dashboard()), {
      type: "duplicateSlide",
      slideId: ID(2),
    });
    const [original, copy] = state.draft.slides;
    expect(copy!.name).toBe("Sales (copy)");
    expect(copy!.id).not.toBe(original!.id);
    expect(copy!.widgets[0]!.id).not.toBe(original!.widgets[0]!.id);
    expect(copy!.widgets[0]).toMatchObject({ metricKey: "downloads", x: 0 });
    expect(state.selectedSlideId).toBe(copy!.id);
  });

  it("deletes a slide, selects its neighbour, and never the last one", () => {
    let state = run(
      initialStudioState(dashboard()),
      { type: "addSlide" },
      { type: "addSlide" },
    );
    const [, second, third] = state.draft.slides;
    state = run(
      state,
      { type: "selectSlide", slideId: third!.id },
      { type: "deleteSlide", slideId: third!.id },
    );
    expect(state.draft.slides).toHaveLength(2);
    expect(state.selectedSlideId).toBe(second!.id);
    state = run(
      state,
      { type: "deleteSlide", slideId: second!.id },
      { type: "deleteSlide", slideId: ID(2) },
    );
    expect(names(state)).toEqual(["Sales"]);
  });

  it("reorders slides and announces the new position", () => {
    let state = run(
      initialStudioState(dashboard()),
      { type: "addSlide" },
      { type: "updateSlide", slideId: ID(1000), patch: { name: "B" } },
      { type: "addSlide" },
      { type: "updateSlide", slideId: ID(1001), patch: { name: "C" } },
    );
    expect(names(state)).toEqual(["Sales", "B", "C"]);
    state = run(state, { type: "moveSlide", slideId: ID(1001), to: 0 });
    expect(names(state)).toEqual(["C", "Sales", "B"]);
    expect(state.announcement?.text).toBe("“C” moved to position 1 of 3.");
    // Out of range moves clamp; a move to the same place changes nothing.
    state = run(state, { type: "moveSlide", slideId: ID(1001), to: 99 });
    expect(names(state)).toEqual(["Sales", "B", "C"]);
    const same = run(state, { type: "moveSlide", slideId: ID(1001), to: 2 });
    expect(same).toBe(state);
  });

  it("is clean again when an edit is reverted by hand", () => {
    const state = run(
      initialStudioState(dashboard()),
      { type: "rename", name: "Overview 2" },
      { type: "rename", name: "Overview" },
    );
    expect(isDirty(state)).toBe(false);
  });

  it("undoes typing as one step, and redoes it", () => {
    let state = run(
      initialStudioState(dashboard()),
      { type: "rename", name: "O" },
      { type: "rename", name: "Ov" },
      { type: "rename", name: "Ove" },
      { type: "updateSettings", patch: { showHeader: false } },
    );
    expect(state.past).toHaveLength(2);
    state = run(state, { type: "undo" });
    expect(state.draft.settings.showHeader).toBe(true);
    expect(state.draft.name).toBe("Ove");
    state = run(state, { type: "undo" });
    expect(state.draft.name).toBe("Overview");
    expect(isDirty(state)).toBe(false);
    state = run(state, { type: "redo" }, { type: "redo" });
    expect(state.draft).toMatchObject({
      name: "Ove",
      settings: { showHeader: false },
    });
    // A new edit drops the redo history.
    state = run(state, { type: "undo" }, { type: "rename", name: "X" });
    expect(state.future).toEqual([]);
  });

  it("keeps the selection on undo when it still exists", () => {
    let state = run(initialStudioState(dashboard()), { type: "addSlide" });
    const added = state.selectedSlideId;
    state = run(state, { type: "undo" });
    expect(state.draft.slides).toHaveLength(1);
    expect(state.selectedSlideId).toBe(ID(2));
    state = run(state, { type: "redo" });
    expect(state.draft.slides.map((s) => s.id)).toContain(added);
  });

  it("adds widgets in the first free spot and selects them", () => {
    const state = run(initialStudioState(dashboard()), {
      type: "addWidget",
      widget: {
        type: "text",
        title: null,
        text: "Hello",
        options: { size: "body", align: "start" },
      },
    });
    const widgets = selectedSlide(state)!.widgets;
    expect(widgets[1]).toMatchObject({ type: "text", x: 4, y: 0, w: 4, h: 2 });
    expect(state.selectedWidgetId).toBe(widgets[1]!.id);
    expect(slideLayoutProblem(widgets)).toBeNull();
    expect(state.announcement?.text).toBe("Text added at column 5, row 1.");
  });

  it("edits and deletes a widget", () => {
    let state = run(initialStudioState(dashboard()), {
      type: "updateWidget",
      widgetId: ID(11),
      patch: { title: "Downloads" },
    });
    expect(selectedSlide(state)!.widgets[0]!.title).toBe("Downloads");
    state = run(
      state,
      { type: "selectWidget", widgetId: ID(11) },
      { type: "deleteWidget", widgetId: ID(11) },
    );
    expect(selectedSlide(state)!.widgets).toEqual([]);
    expect(state.selectedWidgetId).toBeNull();
    expect(state.announcement?.text).toBe("Downloads (metric) deleted.");
  });

  it("discards the draft back to the saved copy", () => {
    const state = run(
      initialStudioState(dashboard()),
      { type: "addSlide" },
      { type: "rename", name: "Other" },
      { type: "discard" },
    );
    expect(isDirty(state)).toBe(false);
    expect(state.draft.slides).toHaveLength(1);
    expect(state.selectedSlideId).toBe(ID(2));
  });

  it("takes the saved dashboard as the new base, keeping the selection by position", () => {
    let state = run(initialStudioState(dashboard()), { type: "addSlide" });
    const saved = dashboard({
      version: 4,
      slides: [
        dashboard().slides[0]!,
        { ...dashboard().slides[0]!, id: ID(77), position: 1, widgets: [] },
      ],
    });
    state = run(state, { type: "saved", dashboard: saved });
    expect(state.version).toBe(4);
    expect(isDirty(state)).toBe(false);
    expect(state.selectedSlideId).toBe(ID(77));
    expect(state.past).toEqual([]);
  });

  it("reloads the server copy after a conflict", () => {
    const theirs = dashboard({ version: 5, name: "Theirs" });
    const state = run(
      initialStudioState(dashboard()),
      { type: "rename", name: "Mine" },
      { type: "reload", dashboard: theirs },
    );
    expect(state.version).toBe(5);
    expect(state.draft.name).toBe("Theirs");
    expect(isDirty(state)).toBe(false);
  });
});

describe("requests", () => {
  it("builds a PUT body the contract accepts, with ids and the base version", () => {
    const state = run(
      initialStudioState(dashboard()),
      { type: "addSlide" },
      {
        type: "addWidget",
        widget: {
          type: "clock",
          title: null,
          options: { showDate: true, hour12: false, timeZone: null },
        },
      },
      { type: "updateSettings", patch: { accentColor: "#ff8800" } },
    );
    const body = toReplaceRequest(state);
    expect(body.version).toBe(3);
    expect(body.slides?.[0]?.id).toBe(ID(2));
    // Read-only presentation fields are not sent back.
    expect(body.slides?.[0]?.widgets[0]).not.toHaveProperty("resourceName");
    expect(body.settings).toMatchObject({
      themeBuiltin: "netrics_dark",
      themeId: null,
      accentColor: "#ff8800",
    });
    expect(() => replaceDashboardRequestSchema.parse(body)).not.toThrow();
  });

  it("sends a custom theme without a built-in key", () => {
    const state = run(initialStudioState(dashboard()), {
      type: "updateSettings",
      patch: { themeBuiltin: null, themeId: ID(40) },
    });
    expect(toReplaceRequest(state).settings).toMatchObject({
      themeBuiltin: null,
      themeId: ID(40),
    });
  });

  it("copies the draft as a new dashboard without ids", () => {
    const state = initialStudioState(dashboard());
    const body = toCopyRequest(state.draft, copyName("Overview"));
    expect(body.name).toBe("Overview (copy)");
    expect(body.slides?.[0]).not.toHaveProperty("id");
    expect(body.slides?.[0]?.widgets[0]).not.toHaveProperty("id");
    expect(() => createDashboardRequestSchema.parse(body)).not.toThrow();
    expect(copyName("x".repeat(100))).toHaveLength(100);
  });
});

describe("validation", () => {
  it("flags problems at the dashboard, the slide and the widget", () => {
    const state = run(
      initialStudioState(dashboard()),
      { type: "rename", name: "  " },
      { type: "updateSlide", slideId: ID(2), patch: { durationSeconds: 2 } },
      {
        type: "addWidget",
        widget: {
          type: "text",
          title: null,
          text: " ",
          options: { size: "body", align: "start" },
        },
      },
      { type: "updateWidget", widgetId: ID(1000), patch: { x: 2 } },
    );
    const problems = documentProblems(state.draft);
    expect(problems).toContainEqual({
      slideId: null,
      widgetId: null,
      message: "The dashboard needs a name.",
    });
    expect(problems).toContainEqual({
      slideId: ID(2),
      widgetId: null,
      message: "Sales: the duration must be between 5 and 3600 seconds.",
    });
    expect(problems).toContainEqual({
      slideId: ID(2),
      widgetId: ID(1000),
      message: "Sales: A text widget needs some text.",
    });
    expect(
      problems.filter((p) => p.message.endsWith("overlaps another widget.")),
    ).toHaveLength(2);
  });

  it("has no problems for a valid dashboard", () => {
    expect(documentProblems(initialStudioState(dashboard()).draft)).toEqual([]);
  });
});

describe("placement and reordering helpers", () => {
  it("finds the first free spot, falling back to the minimum size", () => {
    expect(findFreePlacement([], "metric")).toEqual({ x: 0, y: 0, w: 4, h: 3 });
    // Only a 3 × 2 hole is left: the metric minimum fits, its default not.
    const full = [
      { x: 0, y: 0, w: 12, h: 6 },
      { x: 3, y: 6, w: 9, h: 2 },
    ];
    expect(findFreePlacement(full, "metric")).toEqual({
      x: 0,
      y: 6,
      w: 3,
      h: 2,
    });
    expect(findFreePlacement(full, "line")).toBeNull();
  });

  it("turns a drop gap into the target index", () => {
    expect(insertionIndex([10, 30, 50], 5)).toBe(0);
    expect(insertionIndex([10, 30, 50], 31)).toBe(2);
    expect(insertionIndex([10, 30, 50], 99)).toBe(3);
    expect(reorderTarget(0, 3)).toBe(2);
    expect(reorderTarget(2, 0)).toBe(0);
    expect(reorderTarget(1, 1)).toBe(1);
  });
});
