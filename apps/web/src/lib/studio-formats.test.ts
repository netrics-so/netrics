import { describe, expect, it } from "vitest";

import type { DashboardWidget, Device } from "@netrics/contracts";
import {
  formatFor,
  slideFormatWarnings,
  type FormatWarningItem,
} from "@netrics/domain";

import {
  PREVIEW_DEVICES,
  TARGET_DEVICES,
  deviceOf,
  draftFormatWarnings,
  formatViewReducer,
  frameLayout,
  initialFormatView,
  isEditableTarget,
  previewTargets,
  screensByTarget,
  tabKeyTarget,
  targetStatuses,
  type DraftReadabilityContext,
  type PreviewTarget,
} from "./studio-formats";
import { slidePages, type SlideLayouts } from "./screen-view";

// The Studio's format switcher and device frames (ADR 0017 section 10,
// #283).

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function metric(
  id: number,
  x: number,
  y: number,
  title: string | null = null,
  w = 3,
  h = 2,
): DashboardWidget {
  return {
    type: "metric",
    id: ID(id),
    x,
    y,
    w,
    h,
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

/** A full 16:9 slide: sixteen 3 × 2 metric cards on the 12 × 8 grid. */
const FULL = Array.from({ length: 16 }, (_, index) =>
  metric(100 + index, (index % 4) * 3, Math.floor(index / 4) * 2, `M${index}`),
);

const context: DraftReadabilityContext = {
  primaryFormat: "16x9",
  fontScale: 1,
  showHeader: true,
  dashboardName: "Overview",
  logoAspect: null,
  labelOf: (widget) => widget.title,
};

describe("previewTargets", () => {
  it("lists the primary first, then 16:9, 9:16, 21:9, 4:3, 3:4 and scroll view", () => {
    expect(previewTargets("16x9")).toEqual([
      "16x9",
      "9x16",
      "21x9",
      "4x3",
      "3x4",
      "scroll",
    ]);
    expect(previewTargets("9x16")).toEqual([
      "9x16",
      "16x9",
      "21x9",
      "4x3",
      "3x4",
      "scroll",
    ]);
  });

  it("edits the primary, and formats the slide is arranged by hand in", () => {
    expect(isEditableTarget("16x9", "16x9")).toBe(true);
    expect(isEditableTarget("9x16", "16x9")).toBe(false);
    expect(isEditableTarget("scroll", "16x9")).toBe(false);
    const slide = {
      layouts: [{ format: "9x16" as const, pages: 1, placements: [] }],
    };
    expect(isEditableTarget("9x16", "16x9", slide)).toBe(true);
    expect(isEditableTarget("4x3", "16x9", slide)).toBe(false);
    expect(isEditableTarget("scroll", "16x9", slide)).toBe(false);
    expect(isEditableTarget("9x16", "9x16", { layouts: [] })).toBe(true);
  });
});

describe("devices", () => {
  it("shows every screen format on devices whose screens are in that format", () => {
    for (const [target, ids] of Object.entries(TARGET_DEVICES)) {
      if (target === "scroll") continue;
      for (const id of ids) {
        const { screen } = PREVIEW_DEVICES[id];
        expect(formatFor(screen.width, screen.height), id).toBe(target);
      }
    }
  });

  it("offers a phone for portrait and scroll view, tablets for 4:3 and 3:4", () => {
    expect(TARGET_DEVICES["9x16"]).toEqual(["tv-portrait", "phone"]);
    expect(TARGET_DEVICES.scroll).toEqual(["phone", "tablet-portrait"]);
    expect(TARGET_DEVICES["4x3"]).toContain("tablet-landscape");
    expect(TARGET_DEVICES["3x4"]).toContain("tablet-portrait");
  });

  it("previews on the chosen device, else the first", () => {
    const view = initialFormatView("16x9");
    expect(deviceOf(view, "9x16").id).toBe("tv-portrait");
    expect(deviceOf({ devices: { "9x16": "phone" } }, "9x16").id).toBe("phone");
    // A device of another target falls back.
    expect(deviceOf({ devices: { "16x9": "phone" } }, "16x9").id).toBe("tv");
  });
});

describe("frameLayout", () => {
  it("fits a TV into the stage width, bezel and screen scaled together", () => {
    const layout = frameLayout(PREVIEW_DEVICES.tv, {
      width: 800,
      height: 800,
    });
    expect(layout.width).toBeCloseTo(800, 1);
    expect(layout.screen.width / layout.screen.height).toBeCloseTo(16 / 9, 2);
    expect(layout.scale).toBeCloseTo(layout.screen.width / 1920, 3);
    expect(layout.width).toBeCloseTo(
      layout.screen.width + layout.bezel.left + layout.bezel.right,
      1,
    );
    expect(layout.height).toBeCloseTo(
      layout.screen.height + layout.bezel.top + layout.bezel.bottom,
      1,
    );
  });

  it("fits a portrait TV into the stage height", () => {
    const layout = frameLayout(PREVIEW_DEVICES["tv-portrait"], {
      width: 800,
      height: 500,
    });
    expect(layout.height).toBeCloseTo(500, 1);
    expect(layout.width).toBeLessThan(800);
    expect(layout.screen.width / layout.screen.height).toBeCloseTo(9 / 16, 2);
  });

  it("never shows a device larger than it is", () => {
    const layout = frameLayout(PREVIEW_DEVICES.phone, {
      width: 2000,
      height: 2000,
    });
    expect(layout.scale).toBe(1);
    expect(layout.screen).toEqual({ width: 390, height: 844 });
  });

  it("gives phones and tablets round corners and thicker bezels than TVs", () => {
    const tv = frameLayout(PREVIEW_DEVICES.tv, { width: 400, height: 400 });
    const phone = frameLayout(PREVIEW_DEVICES.phone, {
      width: 400,
      height: 400,
    });
    expect(phone.radius / phone.scale).toBeGreaterThan(tv.radius / tv.scale);
    expect(phone.bezel.top / phone.scale).toBeGreaterThan(
      (tv.bezel.top / tv.scale) * (390 / 1080),
    );
  });
});

describe("draftFormatWarnings", () => {
  it("matches the server's checks for a slide without custom layouts", () => {
    const widgets = [
      metric(1, 0, 0, "Downloads"),
      metric(2, 3, 0, "Downloads of every app in every territory this year", 3),
    ];
    const ours = draftFormatWarnings(
      { id: ID(1), name: null, widgets },
      context,
    );
    const theirs = slideFormatWarnings(
      {
        name: null,
        widgets: widgets.map(({ id, type, x, y, w, h, title }) => ({
          id,
          type,
          x,
          y,
          w,
          h,
          label: title,
        })),
        layouts: {},
      },
      context,
    );
    const key = (warning: FormatWarningItem) =>
      `${warning.format}|${warning.code}|${warning.widgetId}|${warning.pages}`;
    expect(ours.map(key).sort()).toEqual(theirs.map(key).sort());
    expect(ours.some((warning) => warning.code === "label_cut")).toBe(true);
  });

  it("reports continuation pages of a full slide in portrait", () => {
    const warnings = draftFormatWarnings(
      { id: ID(1), name: null, widgets: FULL },
      context,
    );
    const pages = slidePages(FULL, {
      primaryFormat: "16x9",
      format: "9x16",
    }).length;
    expect(pages).toBeGreaterThan(1);
    expect(
      warnings.find(
        (warning) => warning.format === "9x16" && warning.code === "continues",
      ),
    ).toMatchObject({ severity: "info", pages });
    expect(warnings.filter((warning) => warning.format === "16x9")).toEqual([]);
  });

  it("flags a widget added to the draft for review in a custom layout", () => {
    const layouts: SlideLayouts = [
      {
        format: "9x16",
        pages: 1,
        placements: [
          {
            widgetId: ID(1),
            page: 0,
            x: 0,
            y: 0,
            w: 6,
            h: 2,
            hidden: false,
          },
        ],
      },
    ];
    const warnings = draftFormatWarnings(
      {
        id: ID(1),
        name: null,
        widgets: [metric(1, 0, 0, "A"), metric(2, 3, 0, "B")],
        layouts,
      },
      context,
    );
    expect(
      warnings.filter((warning) => warning.code === "widget_to_review"),
    ).toEqual([expect.objectContaining({ format: "9x16", widgetId: ID(2) })]);
  });
});

describe("targetStatuses", () => {
  const warnings: FormatWarningItem[] = [
    {
      format: "9x16",
      code: "label_cut",
      severity: "attention",
      widgetId: ID(1),
      pages: null,
    },
    {
      format: "9x16",
      code: "widget_to_review",
      severity: "attention",
      widgetId: ID(2),
      pages: null,
    },
    {
      format: "9x16",
      code: "continues",
      severity: "info",
      widgetId: null,
      pages: 2,
    },
    {
      format: "3x4",
      code: "header_name_cut",
      severity: "attention",
      widgetId: null,
      pages: null,
    },
  ];
  const statuses = targetStatuses({
    primaryFormat: "16x9",
    slides: [
      { layouts: [{ format: "9x16", pages: 1, placements: [] }] },
      { layouts: [] },
    ],
    warnings,
    screens: new Map<PreviewTarget, number>([
      ["9x16", 2],
      ["scroll", 1],
    ]),
  });
  const byTarget = new Map(statuses.map((status) => [status.target, status]));

  it("states primary, custom and auto per format, in the switcher's order", () => {
    expect(statuses.map((status) => status.target)).toEqual(
      previewTargets("16x9"),
    );
    expect(byTarget.get("16x9")!.layout).toBe("primary");
    expect(byTarget.get("9x16")).toMatchObject({
      layout: "custom",
      customSlides: 1,
    });
    expect(byTarget.get("21x9")!.layout).toBe("auto");
    expect(byTarget.get("scroll")!.layout).toBe("auto");
  });

  it("counts warnings, widgets to review and information apart", () => {
    expect(byTarget.get("9x16")).toMatchObject({
      attention: 1,
      toReview: 1,
      info: 1,
      screens: 2,
    });
    expect(byTarget.get("3x4")).toMatchObject({ attention: 1, toReview: 0 });
    expect(byTarget.get("21x9")).toMatchObject({ attention: 0, info: 0 });
    expect(byTarget.get("scroll")!.screens).toBe(1);
  });
});

describe("screensByTarget", () => {
  const device = (
    screen: Device["screen"],
    revokedAt: string | null = null,
  ) => ({ screen, revokedAt });

  it("counts paired screens by their format, or scroll view", () => {
    const counts = screensByTarget([
      device({
        width: 1920,
        height: 1080,
        scale: 1,
        format: "16x9",
        mode: "screen",
      }),
      device({ width: 1080, height: 1920, scale: 1, mode: "screen" }),
      device({
        width: 390,
        height: 844,
        scale: 3,
        format: "9x16",
        mode: "scroll",
      }),
      device(null),
      device(
        { width: 1080, height: 1920, scale: 1, mode: "screen" },
        "2026-10-01T00:00:00.000Z",
      ),
    ]);
    expect(Object.fromEntries(counts)).toEqual({
      "16x9": 1,
      "9x16": 1,
      scroll: 1,
    });
    expect(screensByTarget(null).size).toBe(0);
  });
});

describe("formatViewReducer", () => {
  it("selects a format on its first page and leaves the overview", () => {
    let state = initialFormatView("16x9");
    state = formatViewReducer(state, { type: "overview", on: true });
    state = formatViewReducer(state, { type: "page", page: 2 });
    state = formatViewReducer(state, { type: "select", target: "9x16" });
    expect(state).toMatchObject({ target: "9x16", page: 0, overview: false });
  });

  it("remembers the device per format and refuses one the format lacks", () => {
    let state = formatViewReducer(initialFormatView("16x9"), {
      type: "select",
      target: "9x16",
    });
    state = formatViewReducer(state, { type: "device", device: "phone" });
    expect(deviceOf(state, "9x16").id).toBe("phone");
    state = formatViewReducer(state, { type: "device", device: "monitor" });
    expect(deviceOf(state, "9x16").id).toBe("phone");
    state = formatViewReducer(state, { type: "select", target: "16x9" });
    state = formatViewReducer(state, { type: "select", target: "9x16" });
    expect(deviceOf(state, "9x16").id).toBe("phone");
  });

  it("goes back to the first page on another slide", () => {
    const state = formatViewReducer(
      { ...initialFormatView("16x9"), target: "9x16", page: 1 },
      { type: "slideChanged" },
    );
    expect(state.page).toBe(0);
    expect(state.target).toBe("9x16");
  });
});

describe("tabKeyTarget", () => {
  it("moves with arrows (wrapping), Home and End", () => {
    expect(tabKeyTarget("ArrowRight", 5, 6)).toBe(0);
    expect(tabKeyTarget("ArrowLeft", 0, 6)).toBe(5);
    expect(tabKeyTarget("ArrowDown", 1, 6)).toBe(2);
    expect(tabKeyTarget("Home", 3, 6)).toBe(0);
    expect(tabKeyTarget("End", 3, 6)).toBe(5);
    expect(tabKeyTarget("a", 3, 6)).toBeNull();
  });
});
