import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Dashboard } from "@netrics/database";
import {
  customerReplacement,
  dashboardFromItems,
  dashboardItems,
  desymbolize,
  isScopeItem,
  itemRefOfPath,
  mergeDatasets,
  mergeOrder,
  modelFromItems,
  modelItems,
  normalizeDashboard,
  normalizeLegacyDashboard,
  normalizeTemplateDashboard,
  preparationFromItems,
  preparationItems,
  UnmergeableRecord,
  UnresolvableReference,
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
          z: "plain",
        },
        ids,
      ),
    ).toEqual({ x: "prepared:a:append_0_0", y: ["s"], z: "plain" });
    // A reference to nothing is never written.
    expect(() => desymbolize({ z: "ref:unknown" }, ids)).toThrow(
      UnresolvableReference,
    );
  });

  describe("model datasets after an update", () => {
    const key = "model:downloads";
    type Lists = { original: string[]; current: string[]; next: string[] };
    type Measures = Record<string, { slot: number; fromNext?: boolean }>;
    // Store preparations of one metric (a source, its append) and another.
    const source = "ref:preparation:source:c:downloads:output",
      append = "ref:preparation:append:downloads:0:0:out",
      other = "ref:preparation:append:proceeds:0:0:out";
    const ids = {
      "preparation:source:c:downloads": "S",
      "preparation:append:downloads:0:0": "T",
      "preparation:append:proceeds:0:0": "P",
    };
    /** Measures by id: the slot they read, and whether the value is the template's. */
    const rebuild = (lists: Lists, measures: Measures) => {
      const items: Items = new Map([
        [`${key}#settings:datasets`, [...lists.next]],
      ]);
      for (const [id, measure] of Object.entries(measures))
        items.set(`${key}#measure:${id}`, {
          id,
          datasetId: `datasets[${measure.slot}]`,
        });
      const definition = modelFromItems(
        key,
        items,
        { current: null, next: null },
        ids,
        {
          datasets: lists,
          fromNext: (itemRef) =>
            measures[itemRef.split("#measure:")[1] ?? ""]?.fromNext ?? false,
        },
      );
      return {
        datasets: definition.datasets,
        reads: Object.fromEntries(
          definition.measures.map((m) => [
            m.id,
            (m as { datasetId?: string }).datasetId,
          ]),
        ),
      };
    };
    const refused = (lists: Lists, measures: Measures) => {
      try {
        rebuild(lists, measures);
      } catch (error) {
        expect(error).toBeInstanceOf(UnmergeableRecord);
        return (error as UnmergeableRecord).refs;
      }
      throw new Error("expected the record to be refused");
    };

    it("keeps a customer value on its dataset when the template inserts one in front", () => {
      expect(
        rebuild(
          { original: ["A", "B"], current: ["A", "B"], next: ["C", "A", "B"] },
          { a: { slot: 0 }, b: { slot: 1 } },
        ),
      ).toEqual({ datasets: ["C", "A", "B"], reads: { a: "A", b: "B" } });
    });

    it("refuses a customer value on a dataset the template drops, keeps the others", () => {
      const lists = { original: ["A", "B"], current: ["A", "B"], next: ["B"] };
      expect(rebuild(lists, { b: { slot: 1 } })).toEqual({
        datasets: ["B"],
        reads: { b: "B" },
      });
      expect(refused(lists, { a: { slot: 0 }, b: { slot: 1 } })).toEqual([
        `${key}#measure:a`,
      ]);
    });

    it("keeps each customer value on its dataset when the template reorders them", () => {
      expect(
        rebuild(
          { original: ["A", "B"], current: ["A", "B"], next: ["B", "A"] },
          { a: { slot: 0 }, b: { slot: 1 } },
        ),
      ).toEqual({ datasets: ["B", "A"], reads: { a: "A", b: "B" } });
    });

    it("follows a true replacement (one source becomes an append tree)", () => {
      expect(
        rebuild(
          { original: [source], current: [source], next: [append] },
          { s: { slot: 0 }, t: { slot: 0, fromNext: true } },
        ),
      ).toEqual({
        datasets: ["prepared:T:out"],
        reads: { s: "prepared:T:out", t: "prepared:T:out" },
      });
    });

    it("never follows a replacement for another metric, or of anything else", () => {
      expect(
        refused(
          { original: [source], current: [source], next: [other] },
          { s: { slot: 0 } },
        ),
      ).toEqual([`${key}#measure:s`]);
      expect(
        refused(
          { original: ["S"], current: ["S"], next: ["T"] },
          { s: { slot: 0 } },
        ),
      ).toEqual([`${key}#measure:s`]);
    });

    it("keeps the customer's own datasets after the template's, in their order", () => {
      expect(
        rebuild(
          { original: [source], current: ["M", source, "N"], next: [append] },
          { m: { slot: 0 }, a: { slot: 1 }, n: { slot: 2 } },
        ),
      ).toEqual({
        datasets: ["prepared:T:out", "M", "N"],
        reads: { m: "M", a: "prepared:T:out", n: "N" },
      });
    });

    it("takes the customer's dataset as a replacement only when that is unambiguous", () => {
      const of = (original: string[], current: string[], dataset: string) =>
        customerReplacement({ original, current, next: original }, dataset);
      expect(of(["A"], ["M"], "A")).toBe("M");
      expect(of(["A", "B"], ["M", "B"], "A")).toBe("M");
      // Two of their own, or theirs at the end of a longer list (removed
      // and appended reads the same): not a replacement, they choose.
      expect(of(["A"], ["M", "N"], "A")).toBeUndefined();
      expect(of(["A", "B"], ["A", "M"], "B")).toBeUndefined();
      expect(of(["A", "B"], ["M", "N"], "A")).toBeUndefined();
    });

    it("reads the customer's dataset where they replaced the template's", () => {
      // The customer swapped A for their own M; the template changes a
      // measure on A and adds one: both read M, and A does not come back.
      expect(
        rebuild(
          { original: ["A"], current: ["M"], next: ["A"] },
          {
            changed: { slot: 0, fromNext: true },
            added: { slot: 0, fromNext: true },
            mine: { slot: 0 },
          },
        ),
      ).toEqual({
        datasets: ["M"],
        reads: { changed: "M", added: "M", mine: "M" },
      });
    });

    it("adds back a dataset the customer removed only for the template's value they chose", () => {
      const lists = { original: ["A", "B"], current: ["B"], next: ["A", "B"] };
      // Chose the template's (the item reads A from the new template).
      expect(
        rebuild(lists, { t: { slot: 0, fromNext: true }, b: { slot: 0 } }),
      ).toEqual({ datasets: ["A", "B"], reads: { t: "A", b: "B" } });
      // Chose their own (it reads B from their list): A stays out.
      expect(rebuild(lists, { t: { slot: 0 }, b: { slot: 0 } })).toEqual({
        datasets: ["B"],
        reads: { t: "B", b: "B" },
      });
    });

    it("leaves out a template dataset the customer removed unless a template value reads it", () => {
      const lists = { original: ["A", "B"], current: ["A"], next: ["A", "B"] };
      expect(rebuild(lists, { a: { slot: 0 } })).toEqual({
        datasets: ["A"],
        reads: { a: "A" },
      });
      expect(
        rebuild(lists, { a: { slot: 0 }, t: { slot: 1, fromNext: true } }),
      ).toEqual({ datasets: ["A", "B"], reads: { a: "A", t: "B" } });
      expect(mergeDatasets(lists)).toEqual(["A"]);
      expect(mergeDatasets(lists, ["B"])).toEqual(["A", "B"]);
    });
  });

  it("names the record for a validation issue of the record as a whole", () => {
    const graph = storeTemplate.build(
      "preparation:source:c:downloads",
      { ...inputs, connections: [{ ...apple, id: "c" }] },
      {
        "dataset:mapping": "m",
        "dataset:products": "p",
      } as StoreTemplateIds,
    );
    if (graph.kind !== "preparation") throw new Error("a preparation");
    expect(itemRefOfPath("preparation:x", graph.graph, [])).toBe(
      "preparation:x",
    );
    expect(itemRefOfPath("preparation:x", graph.graph, ["nodes", 0])).toBe(
      `preparation:x#step:${graph.graph.nodes[0]!.id}`,
    );
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

describe("dashboardFromItems", () => {
  const key = "dashboard:portfolio" as const;
  const widget = (slide: string, title: string) => ({
    slide,
    type: "text",
    title,
  });
  const items = (entries: [string, unknown][]): Items =>
    new Map(entries.map(([ref, value]) => [`${key}#${ref}` as never, value]));

  it("keeps the customer's widget and slide order, with additions after their predecessor", () => {
    const current = items([
      ["slide:custom:mine", { name: "Mine" }],
      ["slide:0", { name: "Template" }],
      ["widget:custom:own", widget("slide:0", "Own")],
      ["widget:downloads", widget("slide:0", "Downloads")],
    ]);
    const next = items([
      ["slide:0", { name: "Template" }],
      ["widget:downloads", widget("slide:0", "Downloads")],
      ["widget:summary", widget("slide:0", "Summary")],
    ]);
    // Merged items come sorted by reference, not in dashboard order.
    const merged = items([
      ["slide:0", { name: "Template" }],
      ["slide:custom:mine", { name: "Mine" }],
      ["widget:summary", widget("slide:0", "Summary")],
      ["widget:downloads", widget("slide:0", "Downloads")],
      ["widget:custom:own", widget("slide:0", "Own")],
    ]);
    const dashboard = dashboardFromItems(key, merged, { current, next }, {});
    expect(Object.keys(dashboard.slides)).toEqual(["custom:mine", "slide:0"]);
    expect(Object.keys(dashboard.widgets)).toEqual([
      "custom:own",
      "widget:downloads",
      "widget:summary",
    ]);
  });
});
