import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDashboardRequestSchema,
  semanticModelDefinitionSchema,
} from "@netrics/contracts";
import { slideLayoutProblem, STUDIO_LIMITS } from "@netrics/domain";

import {
  DEVELOPER_PROJECT_WIDGETS,
  type DeveloperProjectIdentity,
  type DeveloperSource,
} from "./developer-portfolio.js";
import {
  asStoreInputs,
  developerTemplate,
  type DeveloperTemplateInputs,
} from "./developer-template.js";
import type {
  StoreTemplateIds,
  StoreTemplateRecord,
} from "./store-template.js";

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
});

function buildAll(input: DeveloperTemplateInputs) {
  const ids = {
    "dataset:mapping": uuidFor("links"),
    "dataset:products": uuidFor("projects"),
  } as StoreTemplateIds;
  const raw = asStoreInputs(input);
  return developerTemplate.keys(raw).map((key) => {
    const record = developerTemplate.build(key, raw, ids);
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
  1: "96fafddb6bb12a7efe7e35f0849d934a2618f84ce1b2a1d9d25a98d9932a3762",
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
      "What is not up",
      "Deploys today",
      "Spend this month",
      "Active users",
      "Downloads (30 days)",
    ]);
    expect(titles(de)).toEqual([
      "Was nicht läuft",
      "Deploys heute",
      "Kosten diesen Monat",
      "Aktive Nutzer",
      "Downloads (30 Tage)",
    ]);
  });
});
