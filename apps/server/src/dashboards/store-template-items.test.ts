import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Dashboard } from "@netrics/database";
import {
  dashboardItems,
  desymbolize,
  isScopeItem,
  mergeOrder,
  modelFromItems,
  modelItems,
  normalizeDashboard,
  normalizeLegacyDashboard,
  normalizeTemplateDashboard,
  preparationFromItems,
  preparationItems,
  withSlideKeys,
  type Items,
} from "./store-template-items.js";
import {
  storeTemplate,
  type StoreTemplateIds,
  type StoreTemplateInputs,
} from "./store-template.js";
import { apple, google } from "./test-helpers.js";

const inputs: StoreTemplateInputs = {
  name: "App portfolio",
  locale: "en",
  projectId: null,
  connections: [apple, google],
  fixedProduct: null,
  groups: null,
};

/** Every record of one install built with fresh ids, as items. */
function install() {
  const ids = {
    "dataset:mapping": randomUUID(),
    "dataset:products": randomUUID(),
  } as StoreTemplateIds;
  const items: Items = new Map();
  const idsToKeys = new Map<string, string>([
    [ids["dataset:mapping"], "dataset:mapping"],
    [ids["dataset:products"], "dataset:products"],
  ]);
  const records = [];
  for (const key of storeTemplate.keys(inputs)) {
    ids[key] = randomUUID();
    idsToKeys.set(ids[key], key);
    records.push(storeTemplate.build(key, inputs, ids));
  }
  for (const record of records) {
    const part =
      record.kind === "preparation"
        ? preparationItems(record.key, record.graph, idsToKeys)
        : record.kind === "model"
          ? modelItems(record.key, record.definition, idsToKeys)
          : dashboardItems(
              record.key,
              normalizeTemplateDashboard(
                record.request,
                record.widgetKeys,
                idsToKeys,
              ),
            );
    for (const [ref, value] of part) items.set(ref, value);
  }
  return { items, ids, idsToKeys, records };
}

/** The dashboard rows the dashboard service stores for the template. */
function rowsOf(
  request: ReturnType<typeof storeTemplate.build> & { kind: "dashboard" },
  dashboardId = randomUUID(),
) {
  const slideId = randomUUID();
  const widgets = request.request.slides![0]!.widgets!.map((widget) => {
    if (widget.type !== "measure") throw new Error("measure widgets only");
    return {
      id: randomUUID(),
      slideId,
      dashboardId,
      workspaceId: randomUUID(),
      type: widget.type,
      modelId: widget.binding.modelId,
      modelBinding: widget.binding,
      filterExclusions: [],
      x: widget.x,
      y: widget.y,
      w: widget.w,
      h: widget.h,
      title: widget.title ?? null,
      connectionId: null,
      metricKey: null,
      aggregation: null,
      period: null,
      dimensions: {},
      displayCurrency: null,
      text: null,
      imageId: null,
      goalId: null,
      options: widget.options ?? {},
      denominatorConnectionId: null,
      denominatorMetricKey: null,
      denominatorAggregation: null,
      denominatorDimensions: {},
    };
  });
  const dashboard = {
    id: dashboardId,
    workspaceId: randomUUID(),
    projectId: null,
    name: "Customer name",
    version: 3,
    dataFilters: request.request.settings!.dataFilters!,
    showHeader: true,
    autoAdvance: false,
    defaultSlideSeconds: 20,
    transition: "fade",
    themeBuiltin: "netrics_dark",
    themeId: null,
    accentColor: null,
    logoImageId: null,
    primaryFormat: "16x9",
    createdAt: new Date(),
    updatedAt: new Date(),
    slides: [
      {
        id: slideId,
        dashboardId,
        workspaceId: randomUUID(),
        position: 0,
        name: request.request.slides![0]!.name ?? null,
        durationSeconds: null,
        enabled: true,
        backgroundImageId: null,
        backgroundDim: 0,
        widgets,
        layouts: [],
      },
    ],
  } as unknown as Dashboard;
  return dashboard;
}

const dashboardOf = (records: ReturnType<typeof install>["records"]) =>
  records.find((record) => record.kind === "dashboard")! as ReturnType<
    typeof storeTemplate.build
  > & { kind: "dashboard" };

describe("store-template items", () => {
  it("rebuilds every preparation and model from its items with real ids", () => {
    const { items, ids, records } = install();
    // A new record has only the template's order.
    for (const record of records) {
      if (record.kind === "preparation")
        expect(
          preparationFromItems(
            record.key,
            items,
            { current: null, next: record.graph },
            ids,
          ),
        ).toEqual(record.graph);
      if (record.kind === "model")
        expect(
          modelFromItems(
            record.key,
            items,
            { current: null, next: record.definition },
            ids,
          ),
        ).toEqual(record.definition);
    }
  });

  it("resolves symbolic references whose keys hold colons", () => {
    const ids = {
      "preparation:append:downloads:0:0": "a",
      "preparation:source:c:downloads": "s",
    };
    expect(
      desymbolize(
        {
          x: "ref:preparation:append:downloads:0:0:append_0_0",
          y: ["ref:preparation:source:c:downloads"],
          z: "ref:unknown",
        },
        ids,
      ),
    ).toEqual({ x: "prepared:a:append_0_0", y: ["s"], z: "ref:unknown" });
  });

  it("keeps the customer's order and places template additions after their predecessor", () => {
    expect(
      mergeOrder(
        ["a", "mine", "b"],
        ["new0", "a", "new1", "b"],
        new Set(["a", "b", "mine", "new0", "new1"]),
      ),
    ).toEqual(["new0", "a", "new1", "mine", "b"]);
    expect(mergeOrder(["a", "b"], ["b"], new Set(["b"]))).toEqual(["b"]);
  });

  it("turns record ids into template keys so two installs compare equal", () => {
    const first = install(),
      second = install();
    expect([...first.items.keys()].sort()).toEqual(
      [...second.items.keys()].sort(),
    );
    expect(Object.fromEntries(first.items)).toEqual(
      Object.fromEntries(second.items),
    );
    // No record id is left in any value.
    const text = JSON.stringify([...first.items.values()]);
    for (const id of first.idsToKeys.keys()) expect(text).not.toContain(id);
    expect(first.items.get("model:downloads#measure:downloads")).toMatchObject({
      datasetId: "datasets[0]",
    });
  });
  it("keys customer widgets by id and template widgets by key", () => {
    const { records, idsToKeys } = install();
    const record = dashboardOf(records);
    const rows = rowsOf(record);
    const widgets = rows.slides[0]!.widgets;
    const widgetKeys = {
      [widgets[0]!.id]: "widget:downloads",
      [widgets[1]!.id]: "widget:proceeds",
    };
    const normalized = normalizeDashboard(rows, widgetKeys, idsToKeys);
    expect(Object.keys(normalized.widgets).sort()).toEqual(
      [
        `custom:${widgets[2]!.id}`,
        "widget:downloads",
        "widget:proceeds",
      ].sort(),
    );
    const items = dashboardItems(record.key, normalized);
    expect(
      items.has(`dashboard:portfolio#widget:custom:${widgets[2]!.id}`),
    ).toBe(true);
  });
  it("reads the stored dashboard as the template built it", () => {
    const { records, idsToKeys } = install();
    const record = dashboardOf(records);
    const rows = rowsOf(record);
    const widgetKeys = Object.fromEntries([
      [rows.slides[0]!.id, "slide:0"],
      ...rows.slides[0]!.widgets.map((widget, index) => [
        widget.id,
        record.widgetKeys[index]!,
      ]),
    ]);
    const template = Object.fromEntries(
      dashboardItems(
        record.key,
        normalizeTemplateDashboard(
          record.request,
          record.widgetKeys,
          idsToKeys,
        ),
      ),
    );
    expect(
      Object.fromEntries(
        dashboardItems(
          record.key,
          normalizeDashboard(rows, widgetKeys, idsToKeys),
        ),
      ),
    ).toEqual(template);
    // Without stored slide keys, the first slide by position is the template's.
    expect(
      Object.fromEntries(
        dashboardItems(
          record.key,
          normalizeDashboard(
            rows,
            withSlideKeys(
              Object.fromEntries(
                Object.entries(widgetKeys as Record<string, string>).filter(
                  ([, k]) => k !== "slide:0",
                ),
              ),
              rows.slides,
              1,
            ),
            idsToKeys,
          ),
        ),
      ),
    ).toEqual(template);
  });
  it("keys template slides by template index, not position", () => {
    const { records, idsToKeys } = install();
    const record = dashboardOf(records);
    const rows = rowsOf(record);
    const templateSlide = rows.slides[0]!;
    const widgetKeys = Object.fromEntries([
      [templateSlide.id, "slide:0"],
      ...templateSlide.widgets.map((widget, index) => [
        widget.id,
        record.widgetKeys[index]!,
      ]),
    ]);
    // The customer inserts a slide of their own in front of the template's.
    const mine = {
      ...templateSlide,
      id: randomUUID(),
      name: "Mine",
      widgets: [],
    };
    const moved = {
      ...rows,
      slides: [
        { ...mine, position: 0 },
        { ...templateSlide, position: 1 },
      ],
    } as typeof rows;
    const items = dashboardItems(
      record.key,
      normalizeDashboard(moved, widgetKeys, idsToKeys),
    );
    const before = dashboardItems(
      record.key,
      normalizeDashboard(rows, widgetKeys, idsToKeys),
    );
    expect(items.get("dashboard:portfolio#slide:0")).toEqual(
      before.get("dashboard:portfolio#slide:0"),
    );
    expect(items.get("dashboard:portfolio#widget:downloads")).toEqual(
      before.get("dashboard:portfolio#widget:downloads"),
    );
    expect(items.get("dashboard:portfolio#widget:downloads")).toMatchObject({
      slide: "slide:0",
    });
    expect(items.get(`dashboard:portfolio#slide:custom:${mine.id}`)).toEqual({
      enabled: true,
      name: "Mine",
    });
  });
  it("reads a migrated row snapshot like the rows the service reads", () => {
    const { records, idsToKeys } = install();
    const record = dashboardOf(records);
    const rows = rowsOf(record);
    const snake = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
          value instanceof Date ? value.toISOString() : value,
        ]),
      );
    const { slides, ...dashboard } = rows;
    const snapshot = {
      dashboard: snake(dashboard),
      slides: slides.map(({ widgets, layouts: _layouts, ...slide }) => ({
        ...snake(slide),
        widgets: widgets.map((widget) => snake(widget)),
      })),
    };
    const widgetKeys = { [rows.slides[0]!.widgets[0]!.id]: "widget:downloads" };
    expect(normalizeLegacyDashboard(snapshot, widgetKeys, idsToKeys)).toEqual(
      normalizeDashboard(rows, widgetKeys, idsToKeys),
    );
    // A snapshot of an older shape still reads: missing columns are defaults.
    const old = normalizeLegacyDashboard(
      {
        dashboard: { data_filters: [] },
        slides: [
          {
            position: 0,
            widgets: [{ id: "w", type: "measure", x: 0, y: 0, w: 6, h: 4 }],
          },
        ],
      },
      {},
      idsToKeys,
    );
    expect(Object.keys(old.widgets)).toEqual(["custom:w"]);
  });
  it("splits the app filter's fixed value into a scope item", () => {
    const scoped = { ...inputs, fixedProduct: "product:x" };
    const ids = {
      "dataset:mapping": randomUUID(),
      "dataset:products": randomUUID(),
      "model:downloads": randomUUID(),
      "model:proceeds": randomUUID(),
      "model:ratings": randomUUID(),
    } as StoreTemplateIds;
    const record = storeTemplate.build("dashboard:portfolio", scoped, ids);
    if (record.kind !== "dashboard") throw new Error("dashboard expected");
    const items = dashboardItems(
      record.key,
      normalizeTemplateDashboard(
        record.request,
        record.widgetKeys,
        new Map(Object.entries(ids).map(([key, id]) => [id, key])),
      ),
    );
    expect(items.get("dashboard:portfolio#filter:app.fixedValue")).toEqual({
      kind: "values",
      values: ["product:x"],
    });
    expect(items.get("dashboard:portfolio#filter:app")).not.toHaveProperty(
      "fixedValue",
    );
    expect(isScopeItem("dashboard:portfolio#filter:app.fixedValue")).toBe(true);
    expect(isScopeItem("model:downloads#measure:downloads")).toBe(false);
    expect(isScopeItem("model:downloads#settings:datasets")).toBe(true);
    expect(isScopeItem("preparation:append:downloads:0:0#step:input_0")).toBe(
      true,
    );
    expect(
      isScopeItem(`preparation:source:${apple.id}:downloads#step:raw`),
    ).toBe(false);
  });
  it("never makes record names or dashboard bookkeeping items", () => {
    const { items } = install();
    const refs = [...items.keys()];
    expect(
      refs.some((ref) => /#settings:(name|projectId|version)$/.test(ref)),
    ).toBe(false);
    expect(refs).toContain("dashboard:portfolio#settings:showHeader");
    expect(refs).toContain("dashboard:portfolio#slide:0");
    expect(refs).toContain(
      `preparation:source:${apple.id}:downloads#step:calculate_store_name`,
    );
    expect(refs).toContain(`preparation:source:${apple.id}:downloads#output:0`);
  });
});
