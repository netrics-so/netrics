import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDashboardRequestSchema,
  preparationGraphSchema,
  semanticModelDefinitionSchema,
} from "@netrics/contracts";
import {
  executePreparation,
  slideLayoutProblem,
  STUDIO_LIMITS,
  type DataTable,
} from "@netrics/domain";

import { createDefaultRegistry } from "../connectors.js";

import {
  DEVELOPER_DEFAULT_LINKS_MAX,
  DEVELOPER_PROJECT_WIDGETS,
  type DeveloperProjectIdentity,
  type DeveloperSource,
} from "./developer-portfolio.js";
import {
  asStoreInputs,
  developerTemplate,
  developerTemplateV1,
  type DeveloperTemplateInputs,
} from "./developer-template.js";
import { developerProjectIdentities } from "./developer-template-service.js";
import type {
  StoreTemplateIds,
  StoreTemplateRecord,
} from "./store-template.js";
import { apple, inputs as testInputs } from "./test-helpers.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const uuidFor = (key: string) => {
  const hex = sha256(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const source = (
  connectorId: DeveloperSource["connectorId"],
  index: number,
): DeveloperSource => ({
  id: uuidFor(connectorId + index),
  name: connectorId,
  connectorId,
  datasets: {},
});
const ALL = [
  source("railway", 1),
  source("vercel", 1),
  source("hetzner-cloud", 1),
  source("http-check", 1),
  source("posthog", 1),
  source("google-search-console", 1),
  source("app-store-connect", 1),
  source("google-play", 1),
];
const project = (name: string, widgets = [...DEVELOPER_PROJECT_WIDGETS]) =>
  ({
    productId: uuidFor(name),
    name,
    widgets,
  }) satisfies DeveloperProjectIdentity;
const inputs = (
  connections: DeveloperSource[],
  apps: DeveloperProjectIdentity[] = [],
  locale: "en" | "de" = "en",
): DeveloperTemplateInputs => ({
  name: "Developer Portfolio",
  locale,
  projectId: null,
  connections,
  fixedProduct: null,
  groups: null,
  apps,
  // The Railway source's project is Alpha's by default.
  defaults: {
    links: { [`${ALL[0]!.id}:rw-1`]: project("Alpha").productId },
    names: { [project("Alpha").productId]: "Alpha" },
  },
  // Version 2: the name the install seeded into the projects table.
  seededNames: { [project("Alpha").productId]: "Alpha" },
});

function buildAll(
  input: DeveloperTemplateInputs,
  template = developerTemplate,
) {
  const ids = {
    "dataset:mapping": uuidFor("links"),
    "dataset:products": uuidFor("projects"),
  } as StoreTemplateIds;
  const raw = asStoreInputs(input);
  return template.keys(raw).map((key) => {
    const record = template.build(key, raw, ids);
    ids[key] = uuidFor(key);
    return record;
  });
}
const dashboardOf = (records: StoreTemplateRecord[]) => {
  const record = records.find((r) => r.kind === "dashboard");
  if (record?.kind !== "dashboard") throw new Error("no dashboard");
  return record;
};

/**
 * The content hash of every template version, built from the fixture
 * inputs. Changing template content requires a new version: installs
 * remember the version they were made from, and updates compare with it.
 */
const VERSION_HASHES: Record<number, string> = {
  1: "edde3dedbeb7bdffa45c778c3fdcb2abb875b8aeb13662bdde7e2d624af78c1a",
  2: "37a33e63e4cd98297f02f15a8c9df665cbab97508769183011000117b4092034",
};

/** A manual table of string columns. */
const table = (
  columns: string[],
  rows: Record<string, string>[],
): DataTable => ({
  fields: columns.map((id) => ({
    id,
    name: id,
    type: "string",
    nullable: false,
  })),
  rows,
});

/** A connector's source dataset as a table of `rows`. */
const sourceTable = (
  connectorId: DeveloperSource["connectorId"],
  key: string,
  rows: Record<string, unknown>[],
): DataTable => ({
  fields: createDefaultRegistry()
    .get(connectorId)!
    .manifest.datasets!.find((dataset) => dataset.key === key)!
    .fields as DataTable["fields"],
  rows,
});

/** A Railway service state of the project (resource) `projectId`. */
const serviceState = (projectId: string, serviceId = "s1") => ({
  project_id: projectId,
  project_name: projectId,
  service_id: serviceId,
  service_name: "api",
  environment_id: "e1",
  environment_name: "production",
  state: "up",
  active_deployments: 1,
  latest_deployment_id: null,
  latest_status: null,
  latest_created_at: null,
  latest_status_updated_at: null,
  checked_at: "2026-11-24T12:00:00.000Z",
});

/** One record's output rows over `tables`. */
const run = (
  template: typeof developerTemplate,
  key: string,
  input: DeveloperTemplateInputs,
  tables: Map<string, DataTable>,
) => {
  const record = template.build(key, asStoreInputs(input), {
    "dataset:mapping": "links",
    "dataset:products": "projects",
  } as StoreTemplateIds);
  if (record.kind !== "preparation") throw new Error("no preparation");
  return executePreparation(preparationGraphSchema.parse(record.graph), tables)
    .outputs.output!.rows;
};

describe("Developer Portfolio template", () => {
  it("needs a version bump for any content change", () => {
    const records = buildAll(
      inputs(ALL, [project("Alpha"), project("Beta", ["state", "costs"])]),
    );
    expect(sha256(JSON.stringify(records))).toBe(
      VERSION_HASHES[developerTemplate.version],
    );
  });

  it("keeps every released version as it was built", () => {
    // Installs remember their version: version 1 builds exactly as released.
    expect(developerTemplateV1.version).toBe(1);
    expect(
      sha256(
        JSON.stringify(
          buildAll(
            inputs(ALL, [
              project("Alpha"),
              project("Beta", ["state", "costs"]),
            ]),
            developerTemplateV1,
          ),
        ),
      ),
    ).toBe(VERSION_HASHES[1]);
    expect(developerTemplate.version).toBeGreaterThan(1);
  });

  it("dates a Vercel production by the state it reports (#913)", () => {
    const vercel = ALL[1]!;
    const production = (values: Record<string, unknown>) => ({
      project_id: "prj_web",
      project_name: "web",
      web_analytics: true,
      latest_deployment_id: "dpl_new",
      latest_state: null,
      latest_created_at: null,
      latest_ready_at: null,
      live_deployment_id: "dpl_old",
      live_created_at: "2026-11-20T09:00:00.000Z",
      live_ready_at: "2026-11-20T09:05:00.000Z",
      live_url: null,
      rolled_back: false,
      checked_at: "2026-11-24T12:00:00.000Z",
      ...values,
    });
    const tables = new Map<string, DataTable>([
      [
        `pending:${vercel.id}:production_deployments`,
        sourceTable("vercel", "production_deployments", [
          // A new build running while the older one serves.
          production({
            project_id: "prj_building",
            state: "building",
            latest_state: "BUILDING",
            latest_created_at: "2026-11-24T11:50:00.000Z",
          }),
          production({ project_id: "prj_up", state: "up" }),
          production({
            project_id: "prj_failed",
            state: "failed",
            latest_state: "ERROR",
            latest_created_at: "2026-11-24T10:00:00.000Z",
            latest_ready_at: "2026-11-24T10:03:00.000Z",
          }),
          // Down: when it went down is not known.
          production({ project_id: "prj_down", state: "down" }),
        ]),
      ],
      ["links", table(["app_key", "product_id"], [])],
      ["projects", table(["product_id", "product_name"], [])],
    ]);
    const changed = Object.fromEntries(
      run(
        developerTemplate,
        `preparation:ops:state:${vercel.id}`,
        inputs([vercel]),
        tables,
      ).map((row) => [row.item_key, row.changed_at]),
    );
    expect(changed).toEqual({
      [`${vercel.id}:prj_building`]: "2026-11-24T11:50:00.000Z",
      [`${vercel.id}:prj_up`]: "2026-11-20T09:05:00.000Z",
      [`${vercel.id}:prj_failed`]: "2026-11-24T10:03:00.000Z",
      [`${vercel.id}:prj_down`]: null,
    });
  });

  it("names a project by its current name unless the projects table overrides it (#913)", () => {
    const railway = ALL[0]!,
      alpha = project("Alpha").productId,
      beta = project("Beta").productId;
    // The install seeded both names; Alpha was renamed in the workspace
    // since, and the customer named Beta themselves.
    const input: DeveloperTemplateInputs = {
      ...inputs([railway]),
      defaults: {
        links: {
          [`${railway.id}:rw-1`]: alpha,
          [`${railway.id}:rw-2`]: beta,
        },
        names: { [alpha]: "Alpha renamed", [beta]: "Beta" },
      },
      seededNames: { [alpha]: "Alpha", [beta]: "Beta" },
    };
    const projects = table(
      ["product_id", "product_name"],
      [
        { product_id: alpha, product_name: "Alpha" },
        { product_id: beta, product_name: "Beta by the customer" },
      ],
    );
    const rows = run(
      developerTemplate,
      `preparation:ops:state:${railway.id}`,
      input,
      new Map([
        [
          `pending:${railway.id}:service_states`,
          sourceTable("railway", "service_states", [
            serviceState("rw-1"),
            serviceState("rw-2", "s2"),
          ]),
        ],
        ["links", table(["app_key", "product_id"], [])],
        ["projects", projects],
      ]),
    );
    expect(
      Object.fromEntries(rows.map((row) => [row.product_id, row.product_name])),
    ).toEqual({ [alpha]: "Alpha renamed", [beta]: "Beta by the customer" });
    // The slides name them alike.
    expect(
      developerProjectIdentities(
        { projects: projects.rows, links: [] },
        [railway],
        input.defaults,
        input.seededNames,
      ).map((entry) => entry.name),
    ).toEqual(["Alpha renamed", "Beta by the customer"]);
  });

  it("builds default lookups up to the expression engine's JSON limit (#913)", () => {
    const railway = ALL[0]!,
      alpha = project("Alpha").productId;
    const withLinks = (count: number) =>
      run(
        developerTemplate,
        `preparation:ops:state:${railway.id}`,
        {
          ...inputs([railway]),
          defaults: {
            links: Object.fromEntries(
              Array.from({ length: count }, (_, index) => [
                `${railway.id}:rw-${index}`,
                alpha,
              ]),
            ),
            names: { [alpha]: "Alpha" },
          },
        },
        new Map([
          [
            `pending:${railway.id}:service_states`,
            sourceTable("railway", "service_states", [serviceState("rw-0")]),
          ],
          ["links", table(["app_key", "product_id"], [])],
          ["projects", table(["product_id", "product_name"], [])],
        ]),
      );
    expect(
      withLinks(DEVELOPER_DEFAULT_LINKS_MAX).map((row) => row.product_id),
    ).toEqual([alpha]);
    // One more is past the engine's limit: installs and updates refuse a
    // connection with that many (developer-template-service).
    expect(() => withLinks(DEVELOPER_DEFAULT_LINKS_MAX + 1)).toThrow(
      "data_json_limit",
    );
  });

  it("builds a preparation per source and family, appends and a model per family", () => {
    const keys = buildAll(inputs(ALL)).map((record) => record.key);
    const railway = ALL[0]!.id,
      vercel = ALL[1]!.id;
    expect(keys).toEqual(
      expect.arrayContaining([
        `preparation:ops:state:${railway}`,
        `preparation:ops:state:${vercel}`,
        "preparation:ops:state",
        `preparation:ops:deploys:${railway}`,
        "preparation:ops:deploys",
        "preparation:ops:costs",
        "preparation:ops:audience",
        "preparation:labels",
        "model:state",
        "model:deploys",
        "model:costs",
        "model:audience",
        "model:downloads",
        "model:proceeds",
        "model:ratings",
      ]),
    );
    expect(keys.at(-1)).toBe("dashboard:portfolio");
    // One source of a family needs no append.
    expect(buildAll(inputs([ALL[0]!])).map((record) => record.key)).toEqual([
      `preparation:ops:state:${railway}`,
      `preparation:ops:deploys:${railway}`,
      `preparation:ops:costs:${railway}`,
      "model:state",
      "model:deploys",
      "model:costs",
      "dashboard:portfolio",
    ]);
  });

  it.each([
    ["every source", ALL],
    ["only Railway", [ALL[0]!]],
    ["only HTTP checks", [ALL[3]!]],
    ["only PostHog", [ALL[4]!]],
    ["only App Store", [ALL[6]!]],
  ])("builds valid records with %s", (_, connections) => {
    const records = buildAll(
      inputs(connections, [project("Alpha"), project("Beta")]),
    );
    for (const record of records)
      if (record.kind === "model")
        expect(() =>
          semanticModelDefinitionSchema.parse(record.definition),
        ).not.toThrow();
    const { request, widgetKeys, slideKeys } = dashboardOf(records);
    const parsed = createDashboardRequestSchema.parse(request);
    const widgets = parsed.slides!.flatMap((slide) => slide.widgets);
    expect(widgets).toHaveLength(widgetKeys.length);
    expect(slideKeys).toHaveLength(parsed.slides!.length);
    for (const slide of parsed.slides!) {
      expect(slide.widgets.length).toBeGreaterThan(0);
      expect(
        slideLayoutProblem(
          slide.widgets.map((widget) => ({ ...widget, type: widget.type })),
        ),
      ).toBeNull();
    }
    // Every model a widget reads is mapped by the project filter.
    const filter = parsed.settings!.dataFilters!.find(
      (entry) => entry.id === "project",
    )!;
    for (const widget of widgets)
      if ("binding" in widget && widget.binding)
        expect(filter.mappings.map((mapping) => mapping.modelId)).toContain(
          (widget.binding as { modelId: string }).modelId,
        );
  });

  it("keeps within the Studio's limits and names the projects left out", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      project(`Project ${String(index).padStart(2, "0")}`),
    );
    const { request } = dashboardOf(buildAll(inputs(ALL, many)));
    const slides = request.slides!;
    expect(slides.length).toBeLessThanOrEqual(STUDIO_LIMITS.slides);
    expect(slides.flatMap((slide) => slide.widgets).length).toBeLessThanOrEqual(
      STUDIO_LIMITS.dataWidgets,
    );
  });

  it("names everything in English and German", () => {
    const en = dashboardOf(buildAll(inputs(ALL, [project("Alpha")])));
    const de = dashboardOf(buildAll(inputs(ALL, [project("Alpha")], "de")));
    expect(en.request.slides!.map((slide) => slide.name)).toEqual([
      "Overview",
      "Alpha",
    ]);
    expect(de.request.slides!.map((slide) => slide.name)).toEqual([
      "Übersicht",
      "Alpha",
    ]);
    const titles = (record: typeof en) =>
      record.request.slides![0]!.widgets.map((widget) => widget.title);
    expect(titles(en)).toEqual([
      "All services",
      "What is not up",
      "Deploys today",
      "Spend this month",
      "Active users yesterday",
      "Search clicks, newest day",
    ]);
    expect(titles(de)).toEqual([
      "Alle Dienste",
      "Was nicht läuft",
      "Deploys heute",
      "Kosten diesen Monat",
      "Aktive Nutzer gestern",
      "Suchklicks, neuester Tag",
    ]);
  });

  type Widget = NonNullable<
    ReturnType<typeof dashboardOf>["request"]["slides"]
  >[number]["widgets"][number];
  const overviewOf = (connections: DeveloperSource[]) =>
    dashboardOf(buildAll(inputs(connections, [project("Alpha")]))).request
      .slides![0]!.widgets as Widget[];
  const byTitle = (widgets: Widget[], title: string) =>
    widgets.find((widget) => widget.title === title) as Extract<
      Widget,
      { type: "measure" }
    >;

  it("shows the state summary beside the list of everything (owner decision A)", () => {
    const states = overviewOf(ALL).filter((widget) => widget.type === "state");
    expect(
      states.map((widget) =>
        widget.type === "state"
          ? [widget.options?.layout, widget.binding.nameDimensionId]
          : null,
      ),
    ).toEqual([
      ["single", "item_full"],
      ["list", "item_full"],
    ]);
  });

  it("reads deploys, spend and usage in UTC days, usage of yesterday", () => {
    const widgets = overviewOf(ALL);
    expect(byTitle(widgets, "Deploys today").options).toMatchObject({
      period: "today",
      periodTimeZone: "UTC",
    });
    expect(byTitle(widgets, "Spend this month").options).toMatchObject({
      period: "this_month",
      periodTimeZone: "UTC",
    });
    expect(byTitle(widgets, "Active users yesterday").options).toMatchObject({
      period: "today",
      periodWindow: "previous",
      periodTimeZone: "UTC",
    });
  });

  it("shows the usage the installed sources fill", () => {
    const measures = (connections: DeveloperSource[], title: string) =>
      byTitle(overviewOf(connections), title)?.binding.measureIds;
    // Search Console only: its clicks of its newest finalized day, dated;
    // no usage of yesterday, which it has not reported yet.
    expect(measures([ALL[5]!], "Search clicks, newest day")).toEqual([
      "clicks_newest",
      "clicks_day",
    ]);
    expect(measures([ALL[5]!], "Usage yesterday")).toBeUndefined();
    // An unlinked Vercel project: its visitors.
    expect(measures([ALL[1]!], "Usage yesterday")).toEqual(["visitors"]);
    // PostHog: daily, weekly and monthly active users of yesterday.
    expect(measures([ALL[4]!, ALL[5]!], "Active users yesterday")).toEqual([
      "dau",
      "wau",
      "mau",
    ]);
  });

  it("keeps an unlinked store app its own entry, not a shared blank one", () => {
    // The customer unlinked the App Store app "a" (a blank project).
    const tables = testInputs();
    const mapping = tables.get("mapping")!;
    tables.set("mapping", {
      ...mapping,
      rows: [
        ...mapping.rows.filter((row) => row.app_key !== `${apple.id}:a`),
        { app_key: `${apple.id}:a`, product_id: "" },
      ],
    });
    const source: DeveloperSource = {
      id: apple.id,
      name: apple.name,
      connectorId: "app-store-connect",
      datasets: apple.datasets,
    };
    const ids = {
      "dataset:mapping": "mapping",
      "dataset:products": "products",
    } as StoreTemplateIds;
    const record = developerTemplate.build(
      `preparation:source:${apple.id}:downloads`,
      asStoreInputs(inputs([source])),
      ids,
    );
    if (record.kind !== "preparation") throw new Error("no preparation");
    const rows = executePreparation(
      preparationGraphSchema.parse(record.graph),
      tables,
    ).outputs.output!.rows;
    const products = new Set(rows.map((row) => row.product_id));
    expect(products.has("")).toBe(false);
    expect(products).toContain(`${apple.id}:a`);
  });
});
