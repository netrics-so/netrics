import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STORE_TEMPLATE_VERSION,
  storeTemplate,
  storeTemplateInputsSchema,
  storeTemplateV1,
  storeTemplateV2,
  storeTemplateV3,
  storeTemplateV4,
  storeTemplateV5,
  storeTemplateV6,
  type StoreTemplateIds,
  type StoreTemplateInputs,
  type StoreTemplateRecord,
} from "./store-template.js";
import {
  buildStoreAppend,
  buildStoreDashboard,
  buildStoreModel,
  buildStorePreparation,
  storeAppSlides,
  storeTableColumns,
  storeTemplateCopy,
  type StoreAppIdentity,
  type StoreMetric,
} from "./store-portfolio.js";
import { storeAppIdentities } from "./store-template-products.js";
import {
  contentBoxIn,
  freshnessLevelFit,
  measureTableRowsShown,
  SCREEN_FORMAT_KEYS,
  slideFormatWarnings,
  slideLayoutFor,
  slideLayoutProblem,
} from "@netrics/domain";
import { apple, google } from "./test-helpers.js";
import {
  createDashboardRequestSchema,
  preparationGraphSchema,
} from "@netrics/contracts";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** A deterministic uuid per template key, so the build is reproducible. */
const uuidFor = (key: string) => {
  const hex = sha256(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const fakeIds = (): StoreTemplateIds =>
  ({
    "dataset:mapping": uuidFor("dataset:mapping"),
    "dataset:products": uuidFor("dataset:products"),
  }) as StoreTemplateIds;
const appleSource = {
  id: apple.id,
  name: apple.name,
  connectorId: apple.connectorId,
  datasets: apple.datasets,
};
const fixtureInputs: StoreTemplateInputs = {
  name: "App portfolio",
  locale: "en",
  projectId: null,
  connections: [
    appleSource,
    {
      id: google.id,
      name: google.name,
      connectorId: google.connectorId,
      datasets: google.datasets,
    },
  ],
  fixedProduct: null,
  groups: null,
};
function buildAll(
  inputs: StoreTemplateInputs,
  template = storeTemplate,
): StoreTemplateRecord[] {
  const ids = fakeIds();
  return template.keys(inputs).map((key) => {
    const record = template.build(key, inputs, ids);
    ids[key] = ids[key] ?? uuidFor(key);
    return record;
  });
}

/**
 * The content hash of every template version, built from `fixtureInputs`.
 * Changing template content requires a new version and a new hash: installs
 * remember the version they were made from, and updates compare against it.
 */
const VERSION_HASHES: Record<number, string> = {
  1: "44be27ea317c1faf154c41abfc16711e055ca8c47c6e6220918bba59c701aa24",
  2: "79726e4b4472c40243627181269daf6f08dcd991b7d1e415d2aba7bc51727aa3",
  3: "803b151fd59622b368644799eed102cfe37f3632fbc2266f2f32a3ea221c6923",
  4: "a0b7378f8af8f7c9b07da278d4187d3af3b88198cb075d9c66ee14dd5affc014",
  5: "62b47283b5c76be5eb2de73a7c8166d5a4e98ed2d4b7a5f7011547ccdf6a7c22",
  // Version 6 changes only app slides, which `fixtureInputs` has none of:
  // `APP_SLIDE_HASHES` guards them.
  6: "62b47283b5c76be5eb2de73a7c8166d5a4e98ed2d4b7a5f7011547ccdf6a7c22",
  // Version 7 changes the overview beside app slides only, as version 6.
  7: "62b47283b5c76be5eb2de73a7c8166d5a4e98ed2d4b7a5f7011547ccdf6a7c22",
};
const VERSION_1_HASH = VERSION_HASHES[1];

describe("versioned store template", () => {
  it("builds version 1 exactly as the install did before versions existed", () => {
    const records = buildAll(fixtureInputs, storeTemplateV1);
    expect(records.map((r) => r.key)).toEqual([
      `preparation:source:${apple.id}:downloads`,
      `preparation:source:${apple.id}:proceeds`,
      `preparation:source:${apple.id}:ratings`,
      `preparation:source:${google.id}:downloads`,
      `preparation:source:${google.id}:proceeds`,
      `preparation:source:${google.id}:ratings`,
      "preparation:append:downloads:0:0",
      "preparation:append:proceeds:0:0",
      "preparation:append:ratings:0:0",
      "model:downloads",
      "model:proceeds",
      "model:ratings",
      "dashboard:portfolio",
    ]);
    expect(sha256(JSON.stringify(records))).toBe(VERSION_1_HASH);
  });
  it("keeps version 1 for the baseline after the template moves on", () => {
    expect(storeTemplateV1.version).toBe(1);
    expect(
      sha256(JSON.stringify(buildAll(fixtureInputs, storeTemplateV1))),
    ).toBe(VERSION_1_HASH);
  });
  it("needs a version bump for any content change", () => {
    expect(VERSION_HASHES[STORE_TEMPLATE_VERSION]).toBe(
      sha256(JSON.stringify(buildAll(fixtureInputs))),
    );
  });
  it("keeps version 6 frozen after the template moves on", () => {
    expect(storeTemplateV6.version).toBe(6);
    expect(
      sha256(JSON.stringify(buildAll(fixtureInputs, storeTemplateV6))),
    ).toBe(VERSION_HASHES[6]);
  });
  it("keeps version 4 frozen after the template moves on", () => {
    expect(storeTemplateV4.version).toBe(4);
    expect(
      sha256(JSON.stringify(buildAll(fixtureInputs, storeTemplateV4))),
    ).toBe(VERSION_HASHES[4]);
  });
  it("keeps version 3 frozen after the template moves on", () => {
    expect(storeTemplateV3.version).toBe(3);
    expect(
      sha256(JSON.stringify(buildAll(fixtureInputs, storeTemplateV3))),
    ).toBe(VERSION_HASHES[3]);
  });
  it("keeps version 2 frozen after the template moves on", () => {
    expect(storeTemplateV2.version).toBe(2);
    expect(
      sha256(JSON.stringify(buildAll(fixtureInputs, storeTemplateV2))),
    ).toBe(VERSION_HASHES[2]);
  });
  it("changes only the ratings preparations and model in version 2", () => {
    const v1 = buildAll(fixtureInputs, storeTemplateV1),
      v2 = buildAll(fixtureInputs, storeTemplateV2);
    expect(v2.map((record) => record.key)).toEqual(
      v1.map((record) => record.key),
    );
    const changed = v2
      .filter(
        (record, index) => JSON.stringify(record) !== JSON.stringify(v1[index]),
      )
      .map((record) => record.key);
    // Google: Play Console rating reports; both stores: a storefront display
    // name; the model: that name and the as-of day as a date.
    expect(changed).toEqual([
      `preparation:source:${apple.id}:ratings`,
      `preparation:source:${google.id}:ratings`,
      "model:ratings",
    ]);
  });
  it("adds the app label preparations in version 3 and changes proceeds sources and models, not the dashboard", () => {
    const v2 = buildAll(fixtureInputs, storeTemplateV2),
      v3 = buildAll(fixtureInputs, storeTemplateV3);
    const v2Keys = v2.map((record) => record.key);
    const added = [
      "preparation:labels",
      "preparation:labelled:downloads",
      "preparation:labelled:proceeds",
      "preparation:labelled:ratings",
    ];
    // The label preparations come after the appends, before the models.
    expect(v3.map((record) => record.key)).toEqual([
      ...v2Keys.slice(0, v2Keys.indexOf("model:downloads")),
      ...added,
      ...v2Keys.slice(v2Keys.indexOf("model:downloads")),
    ]);
    const before = new Map(v2.map((record) => [record.key, record]));
    const changed = v3
      .filter(
        (record) =>
          before.has(record.key) &&
          JSON.stringify(record) !== JSON.stringify(before.get(record.key)),
      )
      .map((record) => record.key);
    // Proceeds drop rows without proceeds and name a missing currency; the
    // models read the labelled data and its labels.
    expect(changed).toEqual([
      `preparation:source:${apple.id}:proceeds`,
      `preparation:source:${google.id}:proceeds`,
      "model:downloads",
      "model:proceeds",
      "model:ratings",
    ]);
    // One label preparation reads the combined downloads data only (a
    // pending or failing proceeds or ratings source must not hold up the
    // other models); each model reads its metric's labelled data.
    const labels = v3.find((record) => record.key === "preparation:labels");
    expect(
      labels?.kind === "preparation" &&
        labels.graph.nodes.flatMap((node) =>
          node.type === "source" ? [node.datasetId] : [],
        ),
    ).toEqual([
      `prepared:${uuidFor("preparation:append:downloads:0:0")}:append_0_0`,
    ]);
    // Every version 3 record is a valid preparation, model or dashboard.
    for (const record of v3)
      if (record.kind === "preparation")
        expect(() => preparationGraphSchema.parse(record.graph)).not.toThrow();
    expect(v3.find((record) => record.key === "model:proceeds")).toMatchObject({
      kind: "model",
      definition: {
        datasets: [
          `prepared:${uuidFor("preparation:labelled:proceeds")}:labelled`,
        ],
      },
    });
  });
  it("keeps a single connection without an append preparation", () => {
    const single = { ...fixtureInputs, connections: [appleSource] };
    expect(storeTemplate.keys(single)).not.toContain(
      "preparation:append:downloads:0:0",
    );
    const model = buildAll(single, storeTemplateV2).find(
      (r) => r.key === "model:downloads",
    );
    expect(model).toMatchObject({
      kind: "model",
      definition: {
        datasets: [
          `prepared:${uuidFor(`preparation:source:${apple.id}:downloads`)}:output`,
        ],
      },
    });
    // Version 3: the labels read the source preparations directly.
    const labels = buildAll(single).find((r) => r.key === "preparation:labels");
    expect(
      labels?.kind === "preparation" &&
        labels.graph.nodes.find((node) => node.type === "source"),
    ).toMatchObject({
      datasetId: `prepared:${uuidFor(`preparation:source:${apple.id}:downloads`)}:output`,
    });
  });
  it("combines more than 80 sources in rounds, as the install always did", () => {
    const many = {
      ...fixtureInputs,
      connections: Array.from({ length: 81 }, (_, index) => ({
        ...appleSource,
        id: uuidFor(`connection:${index}`),
      })),
    };
    const keys = storeTemplate.keys(many);
    expect(
      keys.filter((key) => key.startsWith("preparation:append:downloads")),
    ).toEqual([
      "preparation:append:downloads:0:0",
      "preparation:append:downloads:0:1",
      "preparation:append:downloads:1:0",
    ]);
    const records = buildAll(many, storeTemplateV2);
    const top = records.find(
      (r) => r.key === "preparation:append:downloads:1:0",
    );
    expect(top).toMatchObject({
      kind: "preparation",
      graph: {
        nodes: [
          {
            datasetId: `prepared:${uuidFor("preparation:append:downloads:0:0")}:append_1_0`,
          },
          {
            datasetId: `prepared:${uuidFor("preparation:append:downloads:0:1")}:input_0`,
          },
          { id: "append_0_0" },
        ],
      },
    });
    // Version 3 labels from the last round's output.
    const labels = buildAll(many).find((r) => r.key === "preparation:labels");
    expect(
      labels?.kind === "preparation" &&
        labels.graph.nodes.find((node) => node.type === "source"),
    ).toMatchObject({
      datasetId: `prepared:${uuidFor("preparation:append:downloads:1:0")}:append_0_0`,
    });
  });
  it("records the dashboard's widget keys in reading order and accepts its inputs", () => {
    const dashboard = buildAll(fixtureInputs, storeTemplateV3).at(-1)!;
    expect(dashboard).toMatchObject({
      kind: "dashboard",
      name: "App portfolio",
      widgetKeys: ["widget:downloads", "widget:proceeds", "widget:ratings"],
    });
    expect(storeTemplateInputsSchema.parse(fixtureInputs)).toEqual(
      fixtureInputs,
    );
  });
});

/**
 * The install loop as it was before versions (f1d070d), composing the
 * builders directly: records in creation order, ids handed out in that order.
 * Pins version 1 to what installs made before versions actually got.
 */
function preVersionInstall(inputs: StoreTemplateInputs) {
  const metrics: StoreMetric[] = ["downloads", "proceeds", "ratings"];
  const t = storeTemplateCopy(inputs.locale),
    created: { name: string; content: unknown }[] = [],
    nextId = () => uuidFor(`created:${created.length}`);
  const publish = (
    name: string,
    graph: ReturnType<typeof buildStoreAppend>,
  ) => {
    const id = nextId();
    created.push({ name: name.slice(0, 100), content: graph });
    return `prepared:${id}:${graph.outputs[0]!}`;
  };
  const outputs: Record<StoreMetric, string[]> = {
    downloads: [],
    proceeds: [],
    ratings: [],
  };
  for (const source of inputs.connections)
    for (const metric of metrics)
      outputs[metric].push(
        publish(
          `${t[metric]} · ${source.name}`,
          buildStorePreparation(
            source,
            metric,
            uuidFor("dataset:mapping"),
            uuidFor("dataset:products"),
            inputs.locale,
          ),
        ),
      );
  const combine = (metric: StoreMetric, list: string[]): string => {
    if (list.length === 1) return list[0]!;
    const next: string[] = [];
    for (let offset = 0; offset < list.length; offset += 80)
      next.push(
        publish(t[metric], buildStoreAppend(list.slice(offset, offset + 80))),
      );
    return next.length === 1 ? next[0]! : combine(metric, next);
  };
  const models = {} as Record<StoreMetric, string>;
  for (const metric of metrics) {
    const definition = buildStoreModel(
      metric,
      combine(metric, outputs[metric]),
      inputs.locale,
    );
    models[metric] = nextId();
    created.push({
      name: `${inputs.name} · ${t[metric]}`.slice(0, 100),
      content: definition,
    });
  }
  created.push({
    name: inputs.name,
    content: buildStoreDashboard(
      inputs.name,
      models,
      inputs.locale,
      inputs.fixedProduct ?? undefined,
    ),
  });
  return created;
}

describe("version 1 against the install before versions", () => {
  for (const count of [1, 2, 81])
    it(`builds byte-identical records for ${count} source(s)`, () => {
      const inputs: StoreTemplateInputs = {
        ...fixtureInputs,
        locale: count === 2 ? "de" : "en",
        fixedProduct: count === 1 ? "product:x" : null,
        connections: Array.from({ length: count }, (_, index) => ({
          ...(index % 2 ? google : appleSource),
          id: uuidFor(`connection:${String(index).padStart(3, "0")}`),
          name: `Account ${index}`,
        })).sort((a, b) => a.id.localeCompare(b.id)),
      };
      const expected = preVersionInstall(inputs);
      // The old loop created per metric its appends and then its model.
      const keys = storeTemplateV1.keys(inputs);
      const metricOf = (key: string) =>
        key.startsWith("model:") ? key.split(":")[1] : key.split(":")[2];
      const oldOrder = [
        ...keys.filter((key) => key.startsWith("preparation:source:")),
        ...(["downloads", "proceeds", "ratings"] as const).flatMap((metric) =>
          keys.filter(
            (key) =>
              (key.startsWith("preparation:append:") ||
                key.startsWith("model:")) &&
              metricOf(key) === metric,
          ),
        ),
        "dashboard:portfolio",
      ];
      expect([...oldOrder].sort()).toEqual([...keys].sort());
      const ids = fakeIds();
      oldOrder.forEach((key, index) => {
        ids[key] = uuidFor(`created:${index}`);
      });
      for (const key of keys) {
        const record = storeTemplateV1.build(key, inputs, ids);
        const content =
          record.kind === "preparation"
            ? record.graph
            : record.kind === "model"
              ? record.definition
              : record.request;
        expect(JSON.stringify({ name: record.name, content }), key).toBe(
          JSON.stringify(expected[oldOrder.indexOf(key)]),
        );
      }
    });
});

describe("version 4: an overview and one slide per app (#709)", () => {
  const vercel = "33333333-3333-4333-8333-333333333333";
  const icon = (n: number) => uuidFor(`icon:${n}`);
  /** Paid with a website, free in Play only, paid in both stores. */
  const apps: StoreAppIdentity[] = [
    {
      productId: `${apple.id}:1001`,
      name: "Focus",
      paid: true,
      icon: icon(1),
      appStore: { connectionId: apple.id, appId: "1001" },
      stores: ["app-store-connect"],
      website: { connectionId: vercel, projectId: "prj_focus" },
    },
    {
      productId: `${google.id}:com.timer`,
      name: "Timer",
      paid: false,
      icon: null,
      appStore: null,
      stores: ["google-play"],
      website: null,
    },
    {
      productId: "product:example",
      name: "Example",
      paid: true,
      icon: icon(3),
      appStore: { connectionId: apple.id, appId: "2002" },
      stores: ["app-store-connect", "google-play"],
      website: null,
    },
  ];
  /**
   * The content hash of the versions with app slides, built from
   * `fixtureInputs` with `apps` (#784): a change to what app slides build
   * needs a new version too.
   */
  const APP_SLIDE_HASHES: Record<number, string> = {
    4: "034364f9fb26ab383278ff8a92015b88fdb1c4d10bc165055f877cb2ec827622",
    5: "71bd572ac6b0d3e39dae1b4f718cf6fdf3ca2b5e261f1c11ee82617d73b4df3d",
    6: "76f0760d5c8493c5fef4479bd42c532a3a03a243f62a5456e2808609d5e8994f",
    7: "52435c8e0011b162f7b24489201dba745bf5692d2f9b7af3da0a720ac2bf6403",
  };
  it("needs a version bump for any app slide change; 4 to 6 stay frozen", () => {
    const hash = (template: typeof storeTemplate) =>
      sha256(JSON.stringify(buildAll({ ...fixtureInputs, apps }, template)));
    expect({
      4: hash(storeTemplateV4),
      5: hash(storeTemplateV5),
      6: hash(storeTemplateV6),
      [STORE_TEMPLATE_VERSION]: hash(storeTemplate),
    }).toEqual(APP_SLIDE_HASHES);
    expect(APP_SLIDE_HASHES[6]).not.toBe(APP_SLIDE_HASHES[5]);
    expect(APP_SLIDE_HASHES[7]).not.toBe(APP_SLIDE_HASHES[6]);
  });
  it("shows both stores on a linked product's slide from version 6 (#784)", () => {
    const linked = (paid: boolean, website: boolean) => ({
      ...apps[2]!,
      paid,
      website: website
        ? { connectionId: apple.id, projectId: "prj_example" }
        : null,
    });
    const slideOf = (app: StoreAppIdentity, locale: "en" | "de" = "en") => {
      const dashboard = dashboardOf(
        { ...fixtureInputs, locale, apps: [app] },
        storeTemplate,
      );
      return createDashboardRequestSchema.parse(dashboard.request).slides![1]!;
    };
    const paid = slideOf(linked(true, true));
    expect(
      paid.widgets.map((widget) => [
        widget.type === "measure"
          ? `measure:${widget.binding.measureIds[0]}:${widget.options.view}`
          : widget.type === "review"
            ? "review"
            : `${widget.type}:${(widget as { metricKey: string }).metricKey}`,
        widget.title,
        widget.x,
        widget.y,
        widget.w,
        widget.h,
      ]),
    ).toEqual([
      // The ratings (listing, country, star) five columns wide over Google
      // Play's proceeds per currency.
      ["measure:rating:table", "Store ratings", 0, 0, 5, 5],
      ["measure:proceeds:table", "Proceeds · Google Play", 0, 5, 5, 3],
      // Both stores' downloads over the last 30 days: the total and a line
      // per store, over the latest review.
      ["measure:downloads:value", "Downloads, last 30 days", 5, 0, 4, 4],
      ["review", null, 5, 4, 4, 4],
      // The App Store's revenue in the display currency, as before, and
      // the website's visitors, each with room for its freshness line.
      [
        "metric:app_store_connect.proceeds",
        "Revenue, last 30 days · App Store",
        9,
        0,
        3,
        4,
      ],
      ["metric:vercel.visitors", "Website visitors, last 30 days", 9, 4, 3, 4],
    ]);
    const split = paid.widgets[2]!;
    if (split.type !== "measure") throw new Error("not a measure");
    expect(split.binding.groupBy).toEqual(["store"]);
    // Its own period, like the App Store widgets'; the date filter does
    // not change it (and says so).
    expect(split.options).toMatchObject({
      view: "value",
      limit: 2,
      period: "last_30_days",
    });
    expect(split.binding.exclusions.map((e) => e.filterId)).toContain("day");
    // The ratings' heads fit five columns: the rating's is its star.
    const ratings = paid.widgets[0]!;
    if (ratings.type !== "measure") throw new Error("not a measure");
    expect(ratings.options.labels).toMatchObject({ rating: "★" });
    expect(ratings.binding.measureIds).toEqual(["rating"]);
    const play = paid.widgets[1]!;
    if (play.type !== "measure") throw new Error("not a measure");
    expect(play.binding.filter).toEqual({
      kind: "call",
      fn: "eq",
      args: [
        { kind: "field", fieldId: "store" },
        { kind: "literal", type: "string", value: "google" },
      ],
    });
    // Free: no revenue on either store; the review stays the App Store's.
    expect(
      slideOf(linked(false, false)).widgets.map((widget) => widget.type),
    ).toEqual(["measure", "review", "measure"]);
    // Both stores' listings show in the ratings table in every format, at
    // the default size and at 1.3, in English and German: rows with
    // realistic cells above the footer the slide shows (its app, both
    // stores' days as the freshness line takes them).
    const hidden: string[] = [];
    for (const locale of ["en", "de"] as const)
      for (const app of [
        linked(true, true),
        linked(false, true),
        linked(true, false),
      ]) {
        const shown = slideOf({ ...app, name: "Focus Timer" }, locale);
        const ratings = shown.widgets.find(
          (widget) =>
            widget.type === "measure" &&
            widget.binding.measureIds[0] === "rating",
        )!;
        if (ratings.type !== "measure") throw new Error("not a measure");
        const columns = storeTableColumns(
          ratings.binding,
          locale,
          ratings.options.labels,
        );
        const de = locale === "de";
        const cells = (listing: string, country: string, rating: string) =>
          [listing, country, rating, de ? "1.280" : "1,280"].slice(
            0,
            columns.length,
          );
        const rows = [
          cells(
            "Focus Timer · App Store",
            de ? "Deutschland" : "Germany",
            de ? "4,6 ★" : "4.6 ★",
          ),
          cells(
            "Focus Timer · Google Play",
            de ? "Alle Länder" : "All countries",
            de ? "4,3 ★" : "4.3 ★",
          ),
        ];
        const levels = de
          ? [
              ["App Store bis 17. Nov. · Google Play bis 11. Nov."],
              ["App Store bis 17.11. · Google Play bis 11.11."],
              ["App Store 17.11. · Google Play 11.11."],
              ["App Store bis 17.11.", "Google Play bis 11.11."],
            ]
          : [
              ["App Store up to Nov 17 · Google Play up to Nov 11"],
              ["App Store up to 11/17 · Google Play up to 11/11"],
              ["App Store 11/17 · Google Play 11/11"],
              ["App Store up to 11/17", "Google Play up to 11/11"],
            ];
        const widgets = shown.widgets.map((widget, index) => ({
          ...widget,
          id: widget === ratings ? "ratings" : `w${index}`,
        }));
        for (const format of SCREEN_FORMAT_KEYS)
          for (const fontScale of [1, 1.3]) {
            const placement = slideLayoutFor({
              widgets,
              primaryFormat: "16x9",
              format,
              custom: null,
            })
              .flat()
              .find((entry) => entry.id === "ratings")!;
            const box = contentBoxIn(placement, format, true);
            const freshness = levels[
              freshnessLevelFit(levels, box.width, fontScale)
            ]!.map(() => null);
            const fit = measureTableRowsShown({
              label: ratings.title ?? "",
              ...box,
              fontScale,
              columns,
              rows,
              total: rows.length,
              footer: [`${de ? "App" : "App"}: Focus Timer`, ...freshness],
              rowsLine: (a, b) => `${a} / ${b}`,
            });
            if (fit.shown !== 2)
              hidden.push(
                `${locale} ${app.paid ? "paid" : "free"}${app.website ? " site" : ""} ${format} ${fontScale}: ${fit.shown}`,
              );
          }
      }
    expect(hidden).toEqual([]);
    // A single-store app keeps version 5's slide.
    for (const single of [apps[0]!, apps[1]!])
      expect(
        dashboardOf({ ...fixtureInputs, apps: [single] }, storeTemplate).request
          .slides![1],
      ).toEqual(
        dashboardOf({ ...fixtureInputs, apps: [single] }, storeTemplateV5)
          .request.slides![1],
      );
  });

  // Version 4 as it shipped (frozen); version 5 changes only the
  // overview's tables and slides (see "fits the overview" and below).
  const dashboardOf = (
    inputs: StoreTemplateInputs,
    template: typeof storeTemplate = storeTemplateV4,
  ) => {
    const record = buildAll(inputs, template).at(-1)!;
    if (record.kind !== "dashboard") throw new Error("no dashboard");
    return record;
  };
  const shape = (slide: { widgets: { type: string }[] }) =>
    slide.widgets.map((widget) =>
      widget.type === "measure"
        ? `measure:${(widget as unknown as { binding: { measureIds: string[] } }).binding.measureIds.join("+")}`
        : widget.type === "review"
          ? "review"
          : `${widget.type}:${(widget as unknown as { metricKey: string }).metricKey}`,
    );

  it("builds the overview, then each app's slide, scoped, with its icon", () => {
    const dashboard = dashboardOf({ ...fixtureInputs, apps });
    const request = createDashboardRequestSchema.parse(dashboard.request);
    expect(request.settings?.autoAdvance).toBe(true);
    const slides = request.slides!;
    expect(slides.map((slide) => slide.name)).toEqual([
      "App portfolio",
      "Focus",
      "Timer",
      "Example",
    ]);
    expect(slides.map((slide) => slide.logoImageId ?? null)).toEqual([
      null,
      icon(1),
      null,
      icon(3),
    ]);
    expect(slides.map((slide) => slide.scope ?? {})).toEqual([
      {},
      ...apps.map((app) => ({
        app: { kind: "values", values: [app.productId] },
      })),
    ]);
    expect(slides.map(shape)).toEqual([
      // Version 3's tables, revenue by app in the display currency, and
      // the linked website's visitors.
      [
        "measure:downloads",
        "measure:proceeds",
        "table:app_store_connect.proceeds",
        "measure:rating+rating_count+checked+availability",
        "table:vercel.visitors",
      ],
      // Paid: revenue, downloads and visitors with their trend, ratings
      // with their count, the latest review.
      [
        "metric:app_store_connect.proceeds",
        "metric:app_store_connect.downloads",
        "metric:vercel.visitors",
        "measure:rating+rating_count",
        "review",
      ],
      // Free, Google Play only, no website: no revenue, no review, no
      // visitors.
      ["measure:downloads", "measure:rating+rating_count"],
      // Paid in both stores, no website: its App Store app's numbers.
      [
        "metric:app_store_connect.proceeds",
        "metric:app_store_connect.downloads",
        "measure:rating+rating_count",
        "review",
      ],
    ]);
    const focus = slides[1]!.widgets;
    expect(focus.find((widget) => widget.type === "review")).toMatchObject({
      connectionId: apple.id,
      dimensions: { resource: "1001" },
    });
    expect(
      focus.find(
        (widget) =>
          widget.type === "metric" && widget.metricKey === "vercel.visitors",
      ),
    ).toMatchObject({
      connectionId: vercel,
      dimensions: { resource: "prj_focus" },
      options: { showSparkline: true, showChange: true },
    });
    // Connection widgets exclude every shared filter, with a reason.
    for (const widget of slides.flatMap((slide) => slide.widgets))
      if (widget.type !== "measure")
        expect(
          widget.filterExclusions?.map((exclusion) => exclusion.filterId),
        ).toEqual(["app", "store", "day", "country", "currency", "storefront"]);
    // A key per widget in reading order and per slide in position order.
    expect(dashboard.widgetKeys).toHaveLength(
      slides.flatMap((slide) => slide.widgets).length,
    );
    expect(new Set(dashboard.widgetKeys).size).toBe(
      dashboard.widgetKeys.length,
    );
    expect(dashboard.slideKeys).toHaveLength(slides.length);
    expect(dashboard.slideKeys![0]).toBe("slide:0");
    expect(storeTemplateInputsSchema.parse({ ...fixtureInputs, apps })).toEqual(
      { ...fixtureInputs, apps },
    );
  });

  it("keeps a dashboard of one app as version 3 built it", () => {
    const fixed = { ...fixtureInputs, fixedProduct: "product:x", apps: [] };
    expect(dashboardOf(fixed).request).toEqual(
      buildAll(fixed, storeTemplateV3).at(-1)!.kind === "dashboard" &&
        (buildAll(fixed, storeTemplateV3).at(-1) as { request: unknown })
          .request,
    );
  });

  it("stops at 12 slides and 48 data widgets; the other apps are named", () => {
    const free = (n: number): StoreAppIdentity => ({
      productId: `${google.id}:app${String(n).padStart(2, "0")}`,
      name: `App ${String(n).padStart(2, "0")}`,
      paid: false,
      icon: null,
      appStore: null,
      stores: ["google-play"],
      website: null,
    });
    const many = Array.from({ length: 14 }, (_, n) => free(n));
    const slides = storeAppSlides({ apps: many, appStore: [] }, 4);
    expect(slides.shown.map((app) => app.name)).toEqual(
      many.slice(0, 11).map((app) => app.name),
    );
    expect(slides.omitted.map((app) => app.name)).toEqual([
      "App 11",
      "App 12",
      "App 13",
    ]);
    expect(
      createDashboardRequestSchema.parse(
        dashboardOf({ ...fixtureInputs, apps: many }).request,
      ).slides,
    ).toHaveLength(12);
    // Paid App Store apps with a website take five data widgets each: the
    // 48 data widgets end before the 12 slides do.
    const paid = Array.from({ length: 11 }, (_, n) => ({
      ...apps[0]!,
      productId: `${apple.id}:${n}`,
      name: `Paid ${String(n).padStart(2, "0")}`,
    }));
    const budget = storeAppSlides(
      {
        apps: paid,
        appStore: [{ id: apple.id, name: apple.name }],
      },
      4,
    );
    expect(budget.shown).toHaveLength(8);
    expect(budget.omitted).toHaveLength(3);
    const request = createDashboardRequestSchema.parse(
      dashboardOf({ ...fixtureInputs, apps: paid }).request,
    );
    expect(
      request.slides!.flatMap((slide) => slide.widgets).length,
    ).toBeLessThanOrEqual(48);
  });

  it("reads the latest review of a product's App Store app, not of its first app", () => {
    const [identity] = storeAppIdentities([
      {
        productId: "product:example",
        name: "Example",
        // Play first in the mapping; the App Store app is the second.
        apps: [
          {
            connectionId: google.id,
            appId: "com.example",
            name: "Example",
            connectorId: "google-play",
          },
          {
            connectionId: apple.id,
            appId: "2002",
            name: "Example",
            connectorId: "app-store-connect",
          },
        ],
        icon: null,
        iconSource: { connectionId: apple.id, resourceId: "2002" },
        pricing: "auto",
        hadProceeds: false,
        paid: false,
        notEditable: null,
        website: null,
      },
      {
        // Only the reports name it: no slide of its own.
        productId: `${google.id}:com.reported`,
        name: "com.reported",
        apps: [
          {
            connectionId: google.id,
            appId: "com.reported",
            name: "com.reported",
            connectorId: "google-play",
          },
        ],
        icon: null,
        iconSource: null,
        pricing: "auto",
        hadProceeds: false,
        paid: false,
        notEditable: null,
        website: null,
      },
    ]);
    expect(identity).toEqual({
      productId: "product:example",
      name: "Example",
      paid: false,
      icon: null,
      appStore: { connectionId: apple.id, appId: "2002" },
      stores: ["app-store-connect", "google-play"],
      website: null,
    });
    const slide = createDashboardRequestSchema.parse(
      dashboardOf({ ...fixtureInputs, apps: [identity!] }).request,
    ).slides![1]!;
    expect(slide.widgets.find((w) => w.type === "review")).toMatchObject({
      connectionId: apple.id,
      dimensions: { resource: "2002" },
    });
  });

  it("fits the overview for 1, 2 and more App Store and Vercel connections", () => {
    const uuid = (label: string) => uuidFor(label);
    for (const appStore of [1, 2, 3])
      for (const vercel of [0, 1, 2, 3])
        for (const locale of ["en", "de"] as const) {
          const asc = Array.from({ length: appStore }, (_, n) => ({
            ...appleSource,
            id: uuid(`asc:${n}`),
            name: `App Store account ${n + 1}`,
          }));
          const apps: StoreAppIdentity[] = Array.from(
            { length: 4 },
            (_, n) => ({
              productId: `${asc[n % appStore]!.id}:${n}`,
              name: `App ${n}`,
              paid: true,
              icon: null,
              appStore: { connectionId: asc[n % appStore]!.id, appId: `${n}` },
              stores: ["app-store-connect"],
              website:
                n < vercel
                  ? { connectionId: uuid(`vercel:${n}`), projectId: `prj_${n}` }
                  : null,
            }),
          );
          // Google Play only, paid, with a website: three measure and
          // metric widgets in its top row.
          apps.push({
            productId: `${google.id}:com.play`,
            name: "Play app",
            paid: true,
            icon: null,
            appStore: null,
            stores: ["google-play"],
            website: { connectionId: uuid("vercel:0"), projectId: "prj_play" },
          });
          const request = createDashboardRequestSchema.parse(
            dashboardOf(
              {
                ...fixtureInputs,
                locale,
                connections: [
                  ...asc,
                  {
                    id: google.id,
                    name: google.name,
                    connectorId: google.connectorId,
                    datasets: google.datasets,
                  },
                ],
                apps,
              },
              storeTemplate,
            ).request,
          );
          const where = `${appStore} App Store, ${vercel} Vercel, ${locale}`;
          const overview = request.slides![0]!;
          // Every connection's table up to the caps: three in all.
          expect(overview.widgets.length, where).toBe(
            3 +
              Math.min(appStore, 2) +
              Math.min(Math.max(vercel, 1), 3 - Math.min(appStore, 2), 2),
          );
          for (const slide of request.slides!) {
            expect(slideLayoutProblem(slide.widgets), where).toBeNull();
            const widgets = slide.widgets.map((widget, index) => ({
              id: `w${index}`,
              type: widget.type,
              x: widget.x,
              y: widget.y,
              w: widget.w,
              h: widget.h,
              label:
                widget.type === "metric" ||
                widget.type === "table" ||
                widget.type === "measure"
                  ? (widget.title ?? null)
                  : null,
              // Measure tables too (#768): their rows above the footer lines.
              rows:
                widget.type === "table"
                  ? widget.options.limit
                  : widget.type === "measure" && widget.options.view === "table"
                    ? widget.options.limit
                    : null,
              columns:
                widget.type === "measure"
                  ? storeTableColumns(
                      widget.binding,
                      locale,
                      widget.options.labels,
                    )
                  : null,
            }));
            for (const fontScale of [1])
              expect(
                slideFormatWarnings(
                  { name: slide.name ?? null, widgets, layouts: {} },
                  {
                    primaryFormat: "16x9",
                    fontScale,
                    showHeader: true,
                    dashboardName: request.name,
                    logoAspect: null,
                  },
                )
                  .filter((warning) => warning.severity === "attention")
                  .map((warning) => `${warning.format} ${warning.code}`),
                `${where} ${slide.name} at ${fontScale}`,
              ).toEqual([]);
          }
        }
  });

  it("never builds a blank slide name: the first app's name, then its id", () => {
    const product = (name: string, apps: [string, string][]) => ({
      productId: `product:${name || "blank"}`,
      name,
      apps: apps.map(([appId, appName]) => ({
        connectionId: apple.id,
        appId,
        name: appName,
        connectorId: "app-store-connect" as const,
      })),
      icon: null,
      iconSource: { connectionId: apple.id, resourceId: apps[0]![0] },
      pricing: "auto" as const,
      hadProceeds: false,
      paid: false,
      notEditable: null,
      website: null,
    });
    const identities = storeAppIdentities([
      product("", [
        ["1", " "],
        ["2", "Second"],
      ]),
      { ...product(" ", [["3", ""]]), productId: "product:spaces" },
    ]);
    expect(identities.map((app) => app.name)).toEqual(["3", "Second"]);
    const slides = createDashboardRequestSchema.parse(
      dashboardOf({
        ...fixtureInputs,
        apps: [...identities, { ...identities[0]!, productId: "x", name: " " }],
      }).request,
    ).slides!;
    expect(slides.map((slide) => slide.name)).toEqual([
      "App portfolio",
      "3",
      "Second",
      "x",
    ]);
  });
});

describe("version 5: the model tables fit their tiles (#768)", () => {
  const apps: StoreAppIdentity[] = [
    {
      productId: `${apple.id}:1001`,
      name: "Focus",
      paid: true,
      icon: null,
      appStore: { connectionId: apple.id, appId: "1001" },
      stores: ["app-store-connect"],
      website: null,
    },
    {
      productId: `${google.id}:com.timer`,
      name: "Timer",
      paid: true,
      icon: null,
      appStore: null,
      stores: ["google-play"],
      website: null,
    },
    // Version 6 (#784): the widest linked product, paid, with a website.
    {
      productId: "product:both",
      name: "Both Stores",
      paid: true,
      icon: null,
      appStore: { connectionId: apple.id, appId: "1002" },
      stores: ["app-store-connect", "google-play"],
      website: { connectionId: apple.id, projectId: "prj_both" },
    },
  ];
  const requestOf = (template: typeof storeTemplate, locale: "en" | "de") => {
    const record = buildAll({ ...fixtureInputs, locale, apps }, template).at(
      -1,
    )!;
    if (record.kind !== "dashboard") throw new Error("no dashboard");
    return createDashboardRequestSchema.parse(record.request);
  };
  /** Each slide's attention warnings at every theme font scale. */
  const attention = (
    template: typeof storeTemplate,
    locale: "en" | "de",
    severity: "attention" | "info" = "attention",
  ) => {
    const request = requestOf(template, locale);
    return request.slides!.flatMap((slide) =>
      [1, 1.15, 1.3].flatMap((fontScale) =>
        slideFormatWarnings(
          {
            name: slide.name ?? null,
            layouts: {},
            widgets: slide.widgets.map((widget, index) => ({
              id: `${slide.name}:${widget.type}:${index}`,
              type: widget.type,
              x: widget.x,
              y: widget.y,
              w: widget.w,
              h: widget.h,
              label:
                widget.type === "metric" ||
                widget.type === "table" ||
                widget.type === "measure"
                  ? (widget.title ?? null)
                  : null,
              rows:
                widget.type === "table" ||
                (widget.type === "measure" && widget.options.view === "table")
                  ? widget.options.limit
                  : null,
              splitLines:
                widget.type === "measure" &&
                widget.options.view === "value" &&
                widget.binding.groupBy.length
                  ? widget.options.limit
                  : null,
              columns:
                widget.type === "measure"
                  ? storeTableColumns(
                      widget.binding,
                      locale,
                      widget.options.labels,
                    )
                  : null,
            })),
          },
          {
            primaryFormat: "16x9",
            fontScale,
            showHeader: true,
            dashboardName: request.name,
            logoAspect: null,
          },
        )
          .filter((warning) => warning.severity === severity)
          .map(
            (warning) =>
              `${warning.widgetId} ${warning.format} ${warning.code} ${fontScale}`,
          ),
      ),
    );
  };

  it("says in every format that version 4's overview tables show the rows that fit", () => {
    // Twenty rows asked for in a four-row tile: screens fit them (info),
    // nothing is cut at the default type size.
    const info = attention(storeTemplateV4, "en", "info");
    for (const index of [0, 1, 3])
      for (const format of ["21x9", "16x9", "4x3", "3x4", "9x16"])
        expect(info).toContain(
          `App portfolio:measure:${index} ${format} rows_cut 1`,
        );
    expect(
      attention(storeTemplateV4, "en").filter((w) => w.endsWith(" 1")),
    ).toEqual([]);
  });

  it("reads well in every format: at least a row everywhere at every theme font scale", () => {
    for (const locale of ["en", "de"] as const) {
      const warnings = attention(storeTemplate, locale);
      expect(
        warnings.filter((w) => w.endsWith(" 1")),
        locale,
      ).toEqual([]);
      // App slides at every theme font scale.
      expect(
        warnings.filter((w) => !/^App(-P| p)ortfolio:/.test(w)),
        locale,
      ).toEqual([]);
      // Every table holds at least a row at every theme font scale.
      expect(warnings, locale).toEqual([]);
    }
  });

  it("ranks the downloads and ratings by their measure; proceeds stay by app", () => {
    const [overview, focus, timer] = requestOf(storeTemplate, "en").slides!;
    // Version 4's overview: one slide, two rows of h 4.
    expect(overview!.widgets.map((widget) => widget.h)).toEqual([
      4, 4, 4, 4, 4,
    ]);
    const tables = overview!.widgets.flatMap((widget) =>
      widget.type === "measure" ? [widget] : [],
    );
    expect(
      tables.map((widget) => [
        widget.binding.measureIds[0],
        widget.options.view,
        widget.options.limit,
        widget.options.order ?? null,
      ]),
    ).toEqual([
      ["downloads", "table", 20, { measureId: "downloads", direction: "desc" }],
      ["proceeds", "table", 20, null],
      ["rating", "table", 20, { measureId: "rating_count", direction: "desc" }],
    ]);
    // The overview's ratings: the rating and its count, as on app slides
    // (six columns leave no row in a third of the width).
    expect(tables[2]!.binding.measureIds).toEqual(["rating", "rating_count"]);
    // An app's ratings rank by their count too.
    expect(
      focus!.widgets.find((widget) => widget.type === "measure")?.options,
    ).toMatchObject({ order: { measureId: "rating_count" } });
    // A Google Play app's proceeds table sits below, beside its ratings,
    // where a row fits at every theme font scale; its downloads stay on top.
    expect(
      timer!.widgets.map((widget) => [
        widget.type === "measure" ? widget.binding.measureIds[0] : widget.type,
        widget.x,
        widget.y,
        widget.w,
      ]),
    ).toEqual([
      ["downloads", 0, 0, 12],
      ["rating", 0, 3, 6],
      ["proceeds", 6, 3, 6],
    ]);
  });
});

describe("version 7: the overview's name and its websites (#779, #787)", () => {
  const vercel = [
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ] as const;
  /** Four apps with a website each: three in one connection, one in another. */
  const apps: StoreAppIdentity[] = [
    ["Atlas", vercel[0], "prj_atlas"],
    ["Birch", vercel[0], "prj_birch"],
    ["Cedar", vercel[1], "prj_cedar"],
    ["Dune", vercel[0], "prj_dune"],
    // A second app on Atlas's website: listed once.
    ["Ember", vercel[0], "prj_atlas"],
    ["Fern", null, null],
  ].map(([name, connectionId, projectId], n) => ({
    productId: `${apple.id}:${n}`,
    name: name!,
    paid: false,
    icon: null,
    appStore: { connectionId: apple.id, appId: `${n}` },
    stores: ["app-store-connect"],
    website: connectionId && projectId ? { connectionId, projectId } : null,
  }));
  const slidesOf = (
    template: typeof storeTemplate,
    locale: "en" | "de" = "en",
    inputs: Partial<StoreTemplateInputs> = {},
  ) => {
    const record = buildAll(
      { ...fixtureInputs, locale, apps, ...inputs },
      template,
    ).at(-1)!;
    if (record.kind !== "dashboard") throw new Error("no dashboard");
    return createDashboardRequestSchema.parse(record.request).slides!;
  };
  const visitorsOf = (slides: ReturnType<typeof slidesOf>) =>
    slides[0]!.widgets.flatMap((widget) =>
      widget.type === "table" && widget.metricKey === "vercel.visitors"
        ? [widget]
        : [],
    );

  it("names the overview slide Overview, not after the dashboard again (#779)", () => {
    // Up to version 6 the first slide carried the template's name, which
    // is the dashboard's default name too.
    expect(slidesOf(storeTemplateV6)[0]!.name).toBe("App portfolio");
    expect(slidesOf(storeTemplateV6, "de")[0]!.name).toBe("App-Portfolio");
    expect(slidesOf(storeTemplate)[0]!.name).toBe("Overview");
    expect(slidesOf(storeTemplate, "de")[0]!.name).toBe("Übersicht");
    // Whatever the dashboard is called.
    expect(slidesOf(storeTemplate, "en", { name: "Overview" })[0]!.name).toBe(
      "Overview",
    );
    // An only slide (no apps to show) keeps the template's name, which
    // headers leave out where it is the dashboard's (#622).
    expect(slidesOf(storeTemplate, "en", { apps: [] })[0]!.name).toBe(
      "App portfolio",
    );
  });

  it("lists only the websites the apps link, per connection (#787)", () => {
    const before = visitorsOf(slidesOf(storeTemplateV6));
    // Version 6 ranked every project of the connection.
    expect(before.map((widget) => widget.options)).toEqual(
      before.map(() => ({
        groupBy: "resource",
        limit: 3,
        showChange: true,
        showOthers: false,
      })),
    );
    for (const locale of ["en", "de"] as const) {
      const tables = visitorsOf(slidesOf(storeTemplate, locale));
      expect(
        tables.map((widget) => [
          widget.connectionId,
          widget.options.groupKeys,
          widget.dimensions ?? {},
        ]),
      ).toEqual([
        [vercel[0], ["prj_atlas", "prj_birch", "prj_dune"], {}],
        [vercel[1], ["prj_cedar"], {}],
      ]);
      // The rows are 30-day sums of a metric named "Daily visitors": the
      // head says so.
      expect(tables.map((widget) => widget.options.valueLabel)).toEqual(
        tables.map(() => (locale === "de" ? "Summe 30 Tage" : "30-day total")),
      );
      expect(tables.map((widget) => widget.period)).toEqual(
        tables.map(() => "last_30_days"),
      );
    }
  });

  it("changes nothing else: the other tiles and every app slide are version 6's", () => {
    for (const locale of ["en", "de"] as const) {
      const [was, ...wasApps] = slidesOf(storeTemplateV6, locale);
      const [now, ...nowApps] = slidesOf(storeTemplate, locale);
      expect(nowApps).toEqual(wasApps);
      expect(
        now!.widgets.map((widget) =>
          widget.type === "table"
            ? {
                ...widget,
                options: {
                  groupBy: widget.options.groupBy,
                  limit: widget.options.limit,
                  showChange: widget.options.showChange,
                  showOthers: widget.options.showOthers,
                },
              }
            : widget,
        ),
      ).toEqual(was!.widgets);
    }
  });

  it("keeps the overview on one page at 16:9 with every number of connection tables (#787)", () => {
    const pages: Record<string, number[]> = {};
    // One or two App Store connections, none to two Vercel connections:
    // four to six tiles (five with one of each, as in the report).
    for (const appStore of [1, 2])
      for (const websites of [0, 1, 2]) {
        const asc = Array.from({ length: appStore }, (_, n) => ({
          ...appleSource,
          id: uuidFor(`asc:${n}`),
          name: `App Store account ${n + 1}`,
        }));
        const overview = slidesOf(storeTemplate, "de", {
          connections: [...asc, fixtureInputs.connections[1]!],
          apps: apps.map((app, n) => ({
            ...app,
            appStore: { connectionId: asc[n % appStore]!.id, appId: `${n}` },
            website:
              app.website &&
              vercel.indexOf(app.website.connectionId as never) < websites
                ? app.website
                : null,
          })),
        })[0]!;
        const widgets = overview.widgets.map((widget, index) => ({
          ...widget,
          id: `w${index}`,
        }));
        expect(slideLayoutProblem(overview.widgets)).toBeNull();
        for (const format of SCREEN_FORMAT_KEYS)
          (pages[format] ??= []).push(
            slideLayoutFor({
              widgets,
              primaryFormat: "16x9",
              format,
              custom: null,
            }).length,
          );
      }
    // An Apple TV (16:9) shows every tile on one page.
    expect(pages["16x9"]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(pages["21x9"]).toEqual([1, 1, 1, 1, 1, 1]);
    // Narrower formats page it (the "1/2" a browser window that is not
    // 16:9 shows): their own grids hold fewer tiles.
    expect(pages["4x3"]).toEqual([2, 2, 2, 2, 2, 2]);
    expect(pages["9x16"]).toEqual([2, 2, 2, 2, 2, 2]);
    expect(pages["3x4"]).toEqual([2, 3, 3, 3, 3, 3]);
  });
});
