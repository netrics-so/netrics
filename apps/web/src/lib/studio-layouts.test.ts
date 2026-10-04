import { describe, expect, it } from "vitest";

import { validateCustomLayout, type CustomLayout } from "@netrics/domain";

import { layoutWidgets, type ScreenWidget } from "./screen-view";
import {
  addPage,
  autoAsCustom,
  confirmPlacements,
  copyLayouts,
  customLayoutOf,
  hasCustomLayout,
  hiddenPlacements,
  layoutsForSave,
  moveInLayout,
  moveToPage,
  pageHasOverlap,
  pagePlacements,
  rebaseBlockers,
  removePage,
  reviewPlacements,
  setHidden,
  toSlideLayout,
  withLayout,
  withoutWidget,
  type LayoutSlide,
} from "./studio-layouts";

// Custom layouts in the Studio (ADR 0017 section 4, #284): the pure edits
// the reducer applies to a slide's layout in a non-primary format.

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Overview-like slide on 16:9: four 3 × 2 metrics, then two charts. */
const OVERVIEW: ScreenWidget[] = [
  { id: ID(1), type: "metric", x: 0, y: 0, w: 3, h: 2 },
  { id: ID(2), type: "metric", x: 3, y: 0, w: 3, h: 2 },
  { id: ID(3), type: "metric", x: 6, y: 0, w: 3, h: 2 },
  { id: ID(4), type: "metric", x: 9, y: 0, w: 3, h: 2 },
  { id: ID(5), type: "line", x: 0, y: 2, w: 6, h: 6 },
  { id: ID(6), type: "bar", x: 6, y: 2, w: 6, h: 6 },
];

function slideOf(
  widgets: ScreenWidget[],
  custom?: CustomLayout,
  format: "9x16" | "4x3" = "9x16",
): LayoutSlide {
  return {
    widgets,
    layouts: custom ? [toSlideLayout(format, custom)] : [],
  };
}

function valid(custom: CustomLayout, widgets = OVERVIEW, format = "9x16") {
  return validateCustomLayout(
    custom,
    layoutWidgets(widgets),
    format as "9x16",
  ).filter((problem) => problem.code !== "widget_missing");
}

describe("customize and the stored layout", () => {
  it("copies the automatic layout, pages included, with nothing flagged", () => {
    const custom = autoAsCustom(slideOf(OVERVIEW), "16x9", "9x16");
    expect(custom.pages).toBeGreaterThanOrEqual(1);
    expect(custom.placements).toHaveLength(OVERVIEW.length);
    expect(custom.placements.every((p) => !p.autoPlaced && !p.hidden)).toBe(
      true,
    );
    expect(valid(custom)).toEqual([]);
    // The same cells as the auto reflow on each page.
    for (let page = 0; page < custom.pages; page++) {
      expect(pageHasOverlap(custom, page)).toBe(false);
    }
  });

  it("knows a slide is custom only outside the primary", () => {
    const custom = autoAsCustom(slideOf(OVERVIEW), "16x9", "9x16");
    const slide = slideOf(OVERVIEW, custom);
    expect(hasCustomLayout(slide, "16x9", "9x16")).toBe(true);
    expect(hasCustomLayout(slide, "16x9", "4x3")).toBe(false);
    expect(hasCustomLayout(slide, "9x16", "9x16")).toBe(false);
    expect(customLayoutOf(slide, "16x9", "4x3")).toBeNull();
  });

  it("completes a stored layout against new widgets, flagging them", () => {
    const custom = autoAsCustom(slideOf(OVERVIEW), "16x9", "9x16");
    const added: ScreenWidget = {
      id: ID(7),
      type: "text",
      x: 0,
      y: 0,
      w: 2,
      h: 1,
    };
    // The primary changed: the bar chart went, a text widget joined.
    const slide = slideOf([...OVERVIEW.slice(0, 5), added], custom);
    const completed = customLayoutOf(slide, "16x9", "9x16")!;
    expect(completed.placements.map((p) => p.id)).toContain(ID(7));
    expect(completed.placements.map((p) => p.id)).not.toContain(ID(6));
    expect(reviewPlacements(completed).map((p) => p.id)).toEqual([ID(7)]);
  });

  it("sets and removes a format's layout among the others", () => {
    const custom = autoAsCustom(slideOf(OVERVIEW), "16x9", "9x16");
    const layouts = withLayout([], "9x16", custom);
    expect(layouts.map((l) => l.format)).toEqual(["9x16"]);
    const both = withLayout(
      layouts,
      "4x3",
      autoAsCustom(slideOf(OVERVIEW), "16x9", "4x3"),
    );
    expect(both.map((l) => l.format)).toEqual(["9x16", "4x3"]);
    expect(withLayout(both, "9x16", null).map((l) => l.format)).toEqual([
      "4x3",
    ]);
  });
});

describe("edits in a custom layout", () => {
  const custom = autoAsCustom(slideOf(OVERVIEW), "16x9", "9x16");
  // Page 2 holds the bar chart alone, centred: it can move up.
  const flagged: CustomLayout = {
    ...custom,
    placements: custom.placements.map((p) =>
      p.id === ID(6) ? { ...p, autoPlaced: true } : p,
    ),
  };

  it("moves within the format's 6-column grid and clears the flag", () => {
    const start = flagged.placements.find((p) => p.id === ID(6))!;
    expect(start.page).toBe(1);
    const result = moveInLayout(flagged, ID(6), "bar", "9x16", {
      kind: "nudge",
      dx: 0,
      dy: -1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placement).toMatchObject({
      y: start.y - 1,
      page: 1,
      autoPlaced: false,
    });
    expect(valid(result.layout)).toEqual([]);
    // The 6-column grid: a step right leaves it.
    expect(
      moveInLayout(flagged, ID(6), "bar", "9x16", {
        kind: "nudge",
        dx: 1,
        dy: 0,
      }),
    ).toMatchObject({ ok: false, error: { kind: "cannotMove" } });
  });

  it("refuses overlap and leaving the grid, naming the widget in the way", () => {
    const first = custom.placements.find((p) => p.id === ID(1))!;
    const second = custom.placements.find(
      (p) => p.id !== ID(1) && p.page === first.page,
    )!;
    const overlap = moveInLayout(custom, ID(1), "metric", "9x16", {
      kind: "place",
      placement: { x: second.x, y: second.y, w: first.w, h: first.h },
    });
    expect(overlap).toMatchObject({
      ok: false,
      error: { kind: "blocked", otherId: second.id },
    });
    const outside = moveInLayout(custom, ID(1), "metric", "9x16", {
      kind: "place",
      placement: { x: 5, y: 0, w: 3, h: 2 },
    });
    expect(outside).toMatchObject({
      ok: false,
      error: { kind: "blocked", blocker: { kind: "outside" } },
    });
    const small = moveInLayout(custom, ID(1), "metric", "9x16", {
      kind: "resize",
      dw: -1,
      dh: 0,
    });
    expect(small).toMatchObject({ ok: false, error: { kind: "minimumSize" } });
  });

  it("adds pages up to eight and removes only empty ones", () => {
    let layout = custom;
    for (let i = layout.pages; i < 8; i++) {
      const added = addPage(layout);
      expect(added.ok).toBe(true);
      if (added.ok) layout = added.layout;
    }
    expect(layout.pages).toBe(8);
    expect(addPage(layout)).toMatchObject({
      ok: false,
      error: { kind: "pageLimit" },
    });
    expect(removePage(layout, 0)).toMatchObject({
      ok: false,
      error: { kind: "pageNotEmpty" },
    });
    const removed = removePage(layout, 7);
    expect(removed.ok && removed.layout.pages).toBe(7);
    const single: CustomLayout = { pages: 1, placements: [] };
    expect(removePage(single, 0)).toMatchObject({
      ok: false,
      error: { kind: "lastPage" },
    });
  });

  it("moves a widget to another page and renumbers pages after a removal", () => {
    const extended = addPage(custom);
    if (!extended.ok) throw new Error("no page");
    const last = extended.layout.pages - 1;
    const moved = moveToPage(extended.layout, ID(6), "bar", "9x16", last);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.placement).toMatchObject({ page: last, autoPlaced: false });
    expect(valid(moved.layout)).toEqual([]);
    // An empty page before it goes: the widget's page moves up.
    const twice = addPage(extended.layout);
    if (!twice.ok) throw new Error("no page");
    const onEnd = moveToPage(twice.layout, ID(6), "bar", "9x16", last + 1);
    if (!onEnd.ok) throw new Error("no move");
    const removed = removePage(onEnd.layout, last);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.layout.placements.find((p) => p.id === ID(6))!.page).toBe(
      last,
    );
  });

  it("hides a widget and shows it again where there is room", () => {
    const hidden = setHidden(custom, ID(2), "metric", "9x16", true);
    if (!hidden.ok) throw new Error("not hidden");
    expect(hiddenPlacements(hidden.layout).map((p) => p.id)).toEqual([ID(2)]);
    expect(pagePlacements(hidden.layout, 0).some((p) => p.id === ID(2))).toBe(
      false,
    );
    const shown = setHidden(hidden.layout, ID(2), "metric", "9x16", false);
    if (!shown.ok) throw new Error("not shown");
    expect(hiddenPlacements(shown.layout)).toEqual([]);
    // Its own cells were free: it comes back where it was.
    const before = custom.placements.find((p) => p.id === ID(2))!;
    expect(shown.placement).toMatchObject({
      x: before.x,
      y: before.y,
      page: before.page,
    });
  });

  it("shows a hidden widget on another page when its own is full", () => {
    const hidden = setHidden(custom, ID(2), "metric", "9x16", true);
    if (!hidden.ok) throw new Error("not hidden");
    const before = custom.placements.find((p) => p.id === ID(2))!;
    // Something takes its cells on its page.
    const blocker = moveInLayout(hidden.layout, ID(1), "metric", "9x16", {
      kind: "place",
      placement: { x: before.x, y: before.y, w: before.w, h: before.h },
    });
    if (!blocker.ok) throw new Error("no blocker");
    const shown = setHidden(blocker.layout, ID(2), "metric", "9x16", false);
    expect(shown.ok).toBe(true);
    if (!shown.ok) return;
    expect(valid(shown.layout)).toEqual([]);
  });

  it("clears one review flag or all of them", () => {
    const two: CustomLayout = {
      ...custom,
      placements: custom.placements.map((p, i) =>
        i < 2 ? { ...p, autoPlaced: true } : p,
      ),
    };
    expect(reviewPlacements(confirmPlacements(two, ID(1)))).toHaveLength(1);
    expect(reviewPlacements(confirmPlacements(two, null))).toHaveLength(0);
  });
});

describe("saving and copying layouts", () => {
  it("sends completed layouts, never the primary's own format", () => {
    const custom = autoAsCustom(slideOf(OVERVIEW), "16x9", "9x16");
    const slide: LayoutSlide = {
      // A text widget became a metric larger than its placement allows.
      widgets: OVERVIEW,
      layouts: [
        toSlideLayout("9x16", {
          ...custom,
          placements: custom.placements.map((p) =>
            p.id === ID(1) ? { ...p, w: 2, h: 1 } : p,
          ),
        }),
        toSlideLayout("16x9", custom),
      ],
    };
    const sent = layoutsForSave(slide, "16x9");
    expect(sent.map((l) => l.format)).toEqual(["9x16"]);
    const placement = sent[0]!.placements.find((p) => p.widgetId === ID(1))!;
    expect(placement.w).toBeGreaterThanOrEqual(3);
    expect(placement.autoPlaced).toBe(true);
  });

  it("renames widgets in copied layouts and drops deleted ones", () => {
    const layouts = [
      toSlideLayout("9x16", autoAsCustom(slideOf(OVERVIEW), "16x9", "9x16")),
    ];
    const ids = new Map(OVERVIEW.map((w, i) => [w.id, ID(100 + i)]));
    const copied = copyLayouts(layouts, ids)!;
    expect(copied[0]!.placements.map((p) => p.widgetId)).toEqual(
      OVERVIEW.map((_, i) => ID(100 + i)),
    );
    const without = withoutWidget(layouts, ID(3))!;
    expect(without[0]!.placements).toHaveLength(5);
    expect(copyLayouts(undefined, ids)).toBeUndefined();
  });
});

describe("changing the primary format", () => {
  it("allows a format where every slide fits one page with nothing hidden", () => {
    const small: ScreenWidget[] = [
      { id: ID(1), type: "metric", x: 0, y: 0, w: 3, h: 2 },
      { id: ID(2), type: "metric", x: 3, y: 0, w: 3, h: 2 },
    ];
    expect(
      rebaseBlockers([{ id: ID(50), widgets: small }], "16x9", "9x16"),
    ).toEqual([]);
    expect(
      rebaseBlockers([{ id: ID(50), widgets: small }], "16x9", "16x9"),
    ).toEqual([]);
  });

  it("names slides that continue on more pages or hide widgets", () => {
    // Sixteen 3 × 2 cards fill 16:9; portrait needs pages.
    const full: ScreenWidget[] = Array.from({ length: 16 }, (_, i) => ({
      id: ID(200 + i),
      type: "text",
      x: (i % 4) * 3,
      y: Math.floor(i / 4) * 2,
      w: 3,
      h: 2,
    }));
    expect(
      rebaseBlockers([{ id: ID(51), widgets: full }], "16x9", "9x16"),
    ).toEqual([{ slideId: ID(51), reason: "overflow" }]);
    const small: ScreenWidget[] = [
      { id: ID(1), type: "metric", x: 0, y: 0, w: 3, h: 2 },
      { id: ID(2), type: "metric", x: 3, y: 0, w: 3, h: 2 },
    ];
    const custom = autoAsCustom({ widgets: small }, "16x9", "9x16");
    const hidden = setHidden(custom, ID(2), "metric", "9x16", true);
    if (!hidden.ok) throw new Error("not hidden");
    expect(
      rebaseBlockers(
        [
          {
            id: ID(52),
            widgets: small,
            layouts: [toSlideLayout("9x16", hidden.layout)],
          },
        ],
        "16x9",
        "9x16",
      ),
    ).toEqual([{ slideId: ID(52), reason: "hidden" }]);
  });
});
