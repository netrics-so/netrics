import { describe, expect, it } from "vitest";

import {
  dashboardWidgetInputSchema,
  type Dashboard,
  type DashboardWidget,
  type WorkspaceMetric,
} from "@netrics/contracts";
import { STUDIO_LIMITS, WIDGET_TYPES } from "@netrics/domain";

import {
  createStudioReducer,
  documentProblems,
  grownPlacement,
  initialStudioState,
  toReplaceRequest,
  type StudioAction,
  type StudioState,
} from "./studio-document";
import {
  bindMetricPatch,
  clockTimeZones,
  connectionsForType,
  convertWidget,
  currencyChoiceOf,
  currencyPatch,
  dimensionLabel,
  dimensionPatch,
  filterDimensions,
  groupByOptions,
  groupByPatch,
  labelPreview,
  metricsForType,
  resourcePatch,
  scopePatch,
  widgetInputProblem,
} from "./studio-inspector";
import type { DataWidget } from "./studio-widgets";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function metricOf(overrides: Partial<WorkspaceMetric>): WorkspaceMetric {
  return {
    connectionId: ID(9),
    connectionName: "App Store",
    key: "downloads",
    name: "Downloads",
    description: "",
    kind: "counter",
    unit: "count",
    granularity: "day",
    dimensions: ["resource", "territory"],
    aggregations: ["sum", "avg"],
    better: "higher",
    role: "primary",
    ...overrides,
  } as WorkspaceMetric;
}

const downloads = metricOf({});
const proceeds = metricOf({
  key: "proceeds",
  name: "Proceeds",
  unit: "currency_minor",
  dimensions: ["resource", "currency"],
  aggregations: ["sum"],
});
const rating = metricOf({
  key: "rating",
  name: "Average rating",
  kind: "gauge",
  dimensions: [],
  aggregations: ["last", "min", "max"],
});
const visitors = metricOf({
  connectionId: ID(8),
  connectionName: "Vercel",
  key: "visitors",
  name: "Visitors",
  dimensions: ["resource"],
});
const helper = metricOf({ key: "position_sum", role: "helper" });
const metrics = [downloads, proceeds, rating, visitors, helper];

const metricWidget: Extract<DashboardWidget, { type: "metric" }> = {
  type: "metric",
  id: ID(11),
  x: 0,
  y: 0,
  w: 4,
  h: 3,
  title: null,
  connectionId: ID(9),
  metricKey: "downloads",
  aggregation: "avg",
  period: "last_7_days",
  dimensions: { resource: "app-1", territory: "DE" },
  displayCurrency: null,
  resourceName: "Wurfel",
  allResourcesName: null,
  options: { showSparkline: true, showChange: true },
};

const clockWidget: DashboardWidget = {
  type: "clock",
  id: ID(12),
  x: 8,
  y: 0,
  w: 2,
  h: 1,
  title: null,
  options: { showDate: true, hour12: false, timeZone: null },
};

const context = { metrics, imageIds: [ID(50)], locale: "en" as const };

/** The widget with its placement, as the API receives it. */
function asInput(fields: object) {
  return { id: ID(60), x: 0, y: 0, w: 6, h: 4, ...fields };
}

describe("metric choices", () => {
  it("offers bars only metrics with a dimension, resources first", () => {
    expect(groupByOptions(downloads)).toEqual(["resource", "territory"]);
    expect(
      groupByOptions(metricOf({ dimensions: ["territory", "resource"] })),
    ).toEqual(["resource", "territory"]);
    expect(groupByOptions(proceeds)).toEqual(["resource"]);
    expect(metricsForType(metrics, "bar").map((m) => m.key)).toEqual([
      "downloads",
      "proceeds",
      "visitors",
    ]);
    expect(metricsForType(metrics, "metric").map((m) => m.key)).toEqual([
      "downloads",
      "proceeds",
      "rating",
      "visitors",
    ]);
    expect(connectionsForType(metrics, "line")).toEqual([
      { id: ID(9), name: "App Store" },
      { id: ID(8), name: "Vercel" },
    ]);
  });

  it("filters on dimensions besides the resource, the currency and the bars", () => {
    expect(filterDimensions(downloads, metricWidget)).toEqual(["territory"]);
    expect(filterDimensions(proceeds, metricWidget)).toEqual([]);
    const bar = {
      ...metricWidget,
      type: "bar",
      options: { groupBy: "territory", limit: 5 },
    } as DataWidget;
    expect(filterDimensions(downloads, bar)).toEqual([]);
    expect(dimensionLabel("territory")).toBe("Territory");
    expect(dimensionLabel("search_type")).toBe("Search type");
  });

  it("rebinds to another metric, keeping what still applies", () => {
    expect(bindMetricPatch(metricWidget, rating)).toEqual({
      connectionId: ID(9),
      metricKey: "rating",
      aggregation: "last",
      dimensions: {},
      displayCurrency: null,
      resourceName: null,
      allResourcesName: null,
    });
    // Same connection with resources: the app stays, the territory goes.
    expect(bindMetricPatch(metricWidget, proceeds)).toMatchObject({
      aggregation: "sum",
      dimensions: { resource: "app-1" },
      resourceName: "Wurfel",
    });
    // Another connection: its resources are others.
    expect(bindMetricPatch(metricWidget, visitors)).toMatchObject({
      connectionId: ID(8),
      aggregation: "avg",
      dimensions: {},
      resourceName: null,
    });
  });

  it("gives a rebound bar a dimension of the new metric", () => {
    const bar = {
      ...metricWidget,
      type: "bar",
      dimensions: {},
      options: { groupBy: "territory", limit: 7 },
    } as DataWidget;
    expect(bindMetricPatch(bar, visitors)).toMatchObject({
      options: { groupBy: "resource", limit: 7 },
    });
    expect(bindMetricPatch(bar, rating)).toBeNull();
    expect(
      groupByPatch(
        { ...bar, dimensions: { resource: "app-1" } } as Extract<
          DataWidget,
          { type: "bar" }
        >,
        "resource",
      ),
    ).toEqual({
      dimensions: {},
      resourceName: null,
      options: { groupBy: "resource", limit: 7 },
    });
  });

  it("shows one resource, or all of them named as such", () => {
    expect(
      resourcePatch(metricWidget, { id: "app-2", name: "Paperstand" }, null),
    ).toEqual({
      dimensions: { resource: "app-2", territory: "DE" },
      resourceName: "Paperstand",
      allResourcesName: null,
    });
    expect(resourcePatch(metricWidget, null, "All apps")).toEqual({
      dimensions: { territory: "DE" },
      resourceName: null,
      allResourcesName: "All apps",
    });
    expect(dimensionPatch(metricWidget, "territory", null)).toEqual({
      dimensions: { resource: "app-1" },
    });
    expect(dimensionPatch(metricWidget, "territory", "US")).toEqual({
      dimensions: { resource: "app-1", territory: "US" },
    });
  });

  it("names a widget of all resources by their scope once they are known", () => {
    const all = { ...metricWidget, dimensions: {}, resourceName: null };
    const apps = { singular: "app", plural: "apps" };
    expect(scopePatch(all, 3, apps)).toEqual({ allResourcesName: "All apps" });
    expect(scopePatch(all, 3, apps, "de")).toEqual({
      allResourcesName: "Alle Apps",
    });
    // Saved in English, opened in German: left alone (no unsaved changes).
    expect(
      scopePatch({ ...all, allResourcesName: "All apps" }, 3, apps, "de"),
    ).toBeNull();
    expect(
      scopePatch({ ...all, allResourcesName: "Alle Apps" }, 3, apps, "en"),
    ).toBeNull();
    expect(scopePatch({ ...all, allResourcesName: "All apps" }, 3, apps)).toBe(
      null,
    );
    expect(
      scopePatch({ ...all, allResourcesName: "All apps" }, 1, apps),
    ).toEqual({ allResourcesName: null });
    expect(scopePatch(all, null, null)).toBeNull();
    expect(scopePatch(metricWidget, 3, apps)).toBeNull();
  });

  it("follows the workspace, converts, or shows one currency exactly", () => {
    const widget = { ...metricWidget, metricKey: "proceeds" };
    expect(currencyChoiceOf(widget)).toEqual({ kind: "workspace" });
    const converted = currencyPatch(widget, {
      kind: "convert",
      currency: "USD",
    });
    expect(converted).toEqual({
      dimensions: { resource: "app-1", territory: "DE" },
      displayCurrency: "USD",
    });
    const only = currencyPatch(
      { ...widget, displayCurrency: "USD" },
      { kind: "only", currency: "JPY" },
    );
    expect(only).toEqual({
      dimensions: { resource: "app-1", territory: "DE", currency: "JPY" },
      displayCurrency: null,
    });
    expect(
      currencyChoiceOf({ ...widget, ...(only as object) } as DataWidget),
    ).toEqual({ kind: "only", currency: "JPY" });
    expect(
      currencyChoiceOf({ dimensions: {}, displayCurrency: "EUR" }),
    ).toEqual({ kind: "convert", currency: "EUR" });
  });
});

describe("changing the type", () => {
  it("makes every type from every type in a shape the API accepts", () => {
    const image: DashboardWidget = {
      type: "image",
      id: ID(13),
      x: 0,
      y: 0,
      w: 2,
      h: 2,
      title: "Logo",
      imageId: ID(50),
      options: { fit: "cover", align: "end" },
    };
    const text: DashboardWidget = {
      type: "text",
      id: ID(14),
      x: 0,
      y: 0,
      w: 2,
      h: 1,
      title: null,
      text: "Hello",
      options: { size: "heading", align: "center" },
    };
    for (const from of [metricWidget, clockWidget, image, text]) {
      for (const to of WIDGET_TYPES) {
        const made = convertWidget(from, to, context);
        expect("widget" in made, `${from.type} → ${to}`).toBe(true);
        if ("widget" in made) {
          expect(made.widget.type).toBe(to);
          expect(() =>
            dashboardWidgetInputSchema.parse(asInput(made.widget)),
          ).not.toThrow();
        }
      }
    }
  });

  it("keeps the binding between charts and the title everywhere", () => {
    const line = convertWidget(
      { ...metricWidget, title: "Sales" },
      "line",
      context,
    );
    expect(line).toMatchObject({
      widget: {
        type: "line",
        title: "Sales",
        metricKey: "downloads",
        aggregation: "avg",
        dimensions: { resource: "app-1", territory: "DE" },
        options: { showPrevious: true, showAxis: true },
      },
    });
    // A bar groups by a dimension it does not filter on.
    const bar = convertWidget(
      { ...metricWidget, dimensions: { resource: "app-1" } },
      "bar",
      context,
    );
    expect(bar).toMatchObject({
      widget: {
        type: "bar",
        dimensions: { resource: "app-1" },
        options: { groupBy: "territory", limit: 5 },
      },
    });
    // Filtered on every dimension: it groups by resource, for all of them.
    expect(convertWidget(metricWidget, "bar", context)).toMatchObject({
      widget: {
        dimensions: { territory: "DE" },
        resourceName: null,
        options: { groupBy: "resource" },
      },
    });
    const text = convertWidget(
      { ...metricWidget, title: "Sales" },
      "text",
      context,
    );
    expect(text).toMatchObject({ widget: { title: "Sales", text: "Sales" } });
  });

  it("says why a type cannot be made", () => {
    expect(
      convertWidget(
        { ...metricWidget, metricKey: "rating", dimensions: {} },
        "bar",
        context,
      ),
    ).toEqual({ reason: "This metric cannot be broken down into bars." });
    expect(
      convertWidget(clockWidget, "image", {
        metrics,
        imageIds: [],
        locale: "en",
      }),
    ).toMatchObject({ reason: expect.stringMatching(/Upload an image/) });
    expect(
      convertWidget(clockWidget, "metric", {
        metrics: [],
        imageIds: [],
        locale: "en",
      }),
    ).toMatchObject({ reason: expect.stringMatching(/connection/) });
  });
});

describe("label preview", () => {
  it("is the label TVs show, with the resource or All apps", () => {
    expect(labelPreview(metricWidget, downloads, "en")).toMatchObject({
      label: "Downloads · Wurfel",
      defaultLabel: "Downloads · Wurfel",
      warning: null,
    });
    const all = {
      ...metricWidget,
      dimensions: {},
      resourceName: null,
      allResourcesName: "All apps",
    };
    expect(labelPreview(all, downloads, "en")?.label).toBe(
      "Downloads · All apps",
    );
    expect(
      labelPreview({ ...all, title: "  App downloads " }, downloads, "en"),
    ).toMatchObject({
      label: "App downloads",
      defaultLabel: "Downloads · All apps",
    });
    expect(labelPreview(clockWidget, undefined, "en")).toBeNull();
  });

  it("warns when the label would be cut at the widget's size", () => {
    const long = {
      ...metricWidget,
      w: 3,
      title:
        "Downloads of every app in every territory over the whole period, combined",
    };
    const preview = labelPreview(long, downloads, "en")!;
    expect(preview.fit.fits).toBe(false);
    expect(preview.warning).toMatch(/would be cut/);
    // Wider, the same title fits.
    expect(
      labelPreview({ ...long, w: 12 }, downloads, "en")!.warning,
    ).toBeNull();
  });
});

describe("option validation", () => {
  it("accepts every widget the inspector makes and names what is wrong", () => {
    expect(widgetInputProblem(metricWidget)).toBeNull();
    expect(widgetInputProblem(clockWidget)).toBeNull();
    const bar = {
      ...metricWidget,
      type: "bar",
      options: { groupBy: "territory", limit: 11 },
    } as DashboardWidget;
    expect(widgetInputProblem(bar)).toMatch(/^options\.limit/);
    const clock = {
      ...clockWidget,
      options: { showDate: true, hour12: false, timeZone: "Mars/Olympus" },
    } as DashboardWidget;
    expect(widgetInputProblem(clock)).toMatch(/^options\.timeZone/);
  });

  it("lists the workspace's time zone first", () => {
    const zones = clockTimeZones("Europe/Berlin");
    expect(zones[0]).toBe("Europe/Berlin");
    expect(zones.filter((zone) => zone === "Europe/Berlin")).toHaveLength(1);
    expect(zones.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Reducer actions (#225)

function dashboard(widgets: DashboardWidget[]): Dashboard {
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
        name: null,
        durationSeconds: null,
        enabled: true,
        background: null,
        widgets,
        layouts: [],
        formatWarnings: [],
      },
    ],
    primaryFormat: "16x9",
    tiles: [],
  };
}

function run(state: StudioState, ...actions: StudioAction[]) {
  let next = 1000;
  const reduce = createStudioReducer(() => ID(next++));
  return actions.reduce(reduce, state);
}

const widgets = (state: StudioState) => state.draft.slides[0]!.widgets;

describe("inspector reducer actions", () => {
  it("merges style options, undoably", () => {
    const start = initialStudioState(dashboard([metricWidget]), "en");
    const state = run(start, {
      type: "updateWidgetOptions",
      widgetId: ID(11),
      patch: { showSparkline: false },
    });
    expect(widgets(state)[0]!.options).toEqual({
      showSparkline: false,
      showChange: true,
    });
    expect(run(state, { type: "undo" }).draft).toEqual(start.draft);
  });

  it("changes the type in place and grows it to the type's minimum", () => {
    const start = initialStudioState(
      dashboard([metricWidget, clockWidget]),
      "en",
    );
    const made = convertWidget(clockWidget, "line", context);
    if (!("widget" in made)) throw new Error("no line");
    const state = run(start, {
      type: "changeWidgetType",
      widgetId: ID(12),
      widget: made.widget,
    });
    expect(widgets(state)[1]).toMatchObject({
      id: ID(12),
      type: "line",
      x: 8,
      y: 0,
      w: 4,
      h: 3,
    });
    expect(state.announcement?.text).toBe("Clock is now a line chart.");
    expect(documentProblems(state.draft, "en")).toEqual([]);
    expect(() => toReplaceRequest(state)).not.toThrow();
  });

  it("refuses a type that needs room the slide does not have", () => {
    const below: DashboardWidget = {
      ...clockWidget,
      id: ID(13),
      x: 8,
      y: 1,
      w: 4,
      h: 2,
    };
    const start = initialStudioState(
      dashboard([metricWidget, clockWidget, below]),
      "en",
    );
    const made = convertWidget(clockWidget, "bar", context);
    if (!("widget" in made)) throw new Error("no bar");
    const state = run(start, {
      type: "changeWidgetType",
      widgetId: ID(12),
      widget: made.widget,
    });
    expect(state.draft).toBe(start.draft);
    expect(state.announcement?.text).toMatch(/at least 4 × 3 cells/);
  });

  it("keeps the data widget limit when a widget becomes a chart", () => {
    const many = Array.from({ length: STUDIO_LIMITS.dataWidgets }, (_, i) => ({
      ...metricWidget,
      id: ID(100 + i),
    }));
    const doc = dashboard([]);
    // Spread the data widgets over slides so placement does not matter.
    doc.slides = [
      ...Array.from({ length: 4 }, (_, s) => ({
        ...doc.slides[0]!,
        id: ID(200 + s),
        position: s,
        widgets: many.slice(s * 12, s * 12 + 12),
      })),
      {
        ...doc.slides[0]!,
        id: ID(300),
        position: 4,
        widgets: [clockWidget],
      },
    ];
    const made = convertWidget(clockWidget, "metric", context);
    if (!("widget" in made)) throw new Error("no metric");
    const state = run(initialStudioState(doc, "en"), {
      type: "changeWidgetType",
      widgetId: ID(12),
      widget: made.widget,
    });
    expect(state.announcement?.text).toMatch(/at most 48 data widgets/);
  });

  it("grows within the grid, moving left or up when it must", () => {
    expect(grownPlacement({ x: 10, y: 7, w: 2, h: 1 }, "bar", [])).toEqual({
      x: 8,
      y: 5,
      w: 4,
      h: 3,
    });
    expect(grownPlacement({ x: 0, y: 0, w: 6, h: 4 }, "metric", [])).toEqual({
      x: 0,
      y: 0,
      w: 6,
      h: 4,
    });
  });

  it("flags options the API would refuse before Save", () => {
    const bar = {
      ...metricWidget,
      type: "bar",
      w: 4,
      h: 3,
      options: { groupBy: "territory", limit: 5 },
    } as DashboardWidget;
    const state = run(initialStudioState(dashboard([bar]), "en"), {
      type: "updateWidgetOptions",
      widgetId: ID(11),
      patch: { limit: 12 },
    });
    const problems = documentProblems(state.draft, "en");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ widgetId: ID(11) });
    expect(problems[0]!.message).toMatch(/options\.limit/);
  });
});
