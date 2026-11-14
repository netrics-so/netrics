import { randomUUID } from "node:crypto";
import type {
  PreparationGraph,
  SemanticModelDefinition,
} from "@netrics/domain";
import { describe, expect, it } from "vitest";
import {
  completeLegacyInstall,
  v1PreparationKeys,
  type LegacyDashboardSnapshot,
} from "./store-template-legacy.js";
import {
  buildStoreAppend,
  buildStoreDashboard,
  buildStoreModel,
  buildStorePreparation,
  type StoreMetric,
  type StoreTemplateSource,
} from "./store-portfolio.js";
import { storeTemplate } from "./store-template.js";
import { apple, google } from "./test-helpers.js";

const metrics: StoreMetric[] = ["downloads", "proceeds", "ratings"];

/** An install as the pre-version code made it, from the same builders. */
function legacyFixture(
  sources: StoreTemplateSource[],
  locale: "en" | "de",
  productId?: string,
) {
  const mappingDatasetId = randomUUID(),
    productDatasetId = randomUUID();
  const preparations: { id: string; graph: PreparationGraph }[] = [];
  const publish = (graph: PreparationGraph) => {
    const id = randomUUID();
    preparations.push({ id, graph });
    return `prepared:${id}:${graph.outputs[0]!}`;
  };
  const outputs: Record<StoreMetric, string[]> = {
    downloads: [],
    proceeds: [],
    ratings: [],
  };
  // The install read its connections ordered by id.
  for (const source of [...sources].sort((a, b) => a.id.localeCompare(b.id)))
    for (const metric of metrics)
      outputs[metric].push(
        publish(
          buildStorePreparation(
            source,
            metric,
            mappingDatasetId,
            productDatasetId,
            locale,
          ),
        ),
      );
  const combine = (inputs: string[]): string => {
    if (inputs.length === 1) return inputs[0]!;
    const next: string[] = [];
    for (let offset = 0; offset < inputs.length; offset += 80)
      next.push(publish(buildStoreAppend(inputs.slice(offset, offset + 80))));
    return next.length === 1 ? next[0]! : combine(next);
  };
  const models = {} as Record<StoreMetric, SemanticModelDefinition>,
    modelIds = {} as Record<StoreMetric, string>;
  for (const metric of metrics) {
    models[metric] = buildStoreModel(metric, combine(outputs[metric]), locale);
    modelIds[metric] = randomUUID();
  }
  const request = buildStoreDashboard(
    "Customer name",
    modelIds,
    locale,
    productId,
  );
  const widgets = [
    ...request.slides![0]!.widgets!,
    // The customer's own widget on a template model, below the template's.
    { ...request.slides![0]!.widgets![0]!, y: 8, title: "Mine" },
  ].map((widget, index) => ({
    id: `widget-${index}`,
    type: widget.type,
    x: widget.x,
    y: widget.y,
    model_id: widget.type === "measure" ? widget.binding.modelId : null,
    model_binding: widget.type === "measure" ? widget.binding : null,
  }));
  const snapshot: LegacyDashboardSnapshot = {
    dashboard: {
      id: randomUUID(),
      name: "Customer name",
      project_id: null,
      data_filters: request.settings!.dataFilters!,
    },
    // Reading order is restored from position, y and x.
    slides: [{ id: randomUUID(), position: 0, widgets: widgets.reverse() }],
  };
  return {
    result: {
      dashboardId: snapshot.dashboard.id as string,
      mappingDatasetId,
      productDatasetId,
      models: modelIds,
      preparationIds: preparations.map((p) => p.id),
    },
    preparations,
    models,
    snapshot,
    connections: sources.map(({ id, name, connectorId }) => ({
      id,
      name,
      connectorId,
      datasets: {},
    })),
  };
}

// Given out of id order; the inputs list them sorted, as the install did.
const germanFixture = legacyFixture([google, apple], "de");

describe("completing installs made before template versions", () => {
  it("reconstructs inputs and keys of a two-store German install", () => {
    const done = completeLegacyInstall(germanFixture);
    expect(done).toMatchObject({
      ok: true,
      inputs: {
        name: "Customer name",
        locale: "de",
        projectId: null,
        fixedProduct: null,
        groups: null,
        connections: [
          { id: apple.id, name: apple.name, datasets: apple.datasets },
          { id: google.id, name: google.name, datasets: google.datasets },
        ],
      },
    });
    if (!done.ok) throw new Error(done.code);
    expect(Object.values(done.keys)).toContain(
      "preparation:append:ratings:0:0",
    );
    expect(Object.values(done.widgetKeys).sort()).toEqual([
      "slide:0",
      "widget:downloads",
      "widget:proceeds",
      "widget:ratings",
    ]);
    expect(done.widgetKeys["widget-3"]).toBeUndefined();
  });
  it("finds exactly the keys the current template builds for those inputs", () => {
    const done = completeLegacyInstall(germanFixture);
    if (!done.ok) throw new Error(done.code);
    const keys = [
      ...Object.values(done.keys),
      ...metrics.map((metric) => `model:${metric}`),
      "dashboard:portfolio",
    ].sort();
    expect(keys).toEqual(storeTemplate.keys(done.inputs).sort());
    // Each preparation got the key of the record the template builds.
    const ids: Record<string, string> = {
      "dataset:mapping": germanFixture.result.mappingDatasetId,
      "dataset:products": germanFixture.result.productDatasetId,
    };
    for (const [legacy, key] of Object.entries(done.keys))
      ids[key] = legacy.slice("legacy:".length);
    for (const { id, graph } of germanFixture.preparations) {
      const built = storeTemplate.build(
        done.keys[`legacy:${id}`]!,
        done.inputs,
        ids as never,
      );
      expect(built).toMatchObject({ kind: "preparation", graph });
    }
  });
  it("reads English, a single store, a fixed app scope and many sources", () => {
    const single = legacyFixture([apple], "en", "product:x");
    const done = completeLegacyInstall(single);
    expect(done).toMatchObject({
      ok: true,
      inputs: { locale: "en", fixedProduct: "product:x" },
    });
    if (!done.ok) throw new Error(done.code);
    expect(Object.values(done.keys).sort()).toEqual(
      metrics
        .map((metric) => `preparation:source:${apple.id}:${metric}`)
        .sort(),
    );
    const many = legacyFixture(
      Array.from({ length: 81 }, (_, index) => ({
        ...google,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        name: `Play ${index}`,
      })),
      "en",
    );
    const large = completeLegacyInstall(many);
    if (!large.ok) throw new Error(large.code);
    expect(
      Object.values(large.keys)
        .filter((key) => key.startsWith("preparation:append:downloads"))
        .sort(),
    ).toEqual([
      "preparation:append:downloads:0:0",
      "preparation:append:downloads:0:1",
      "preparation:append:downloads:1:0",
    ]);
  });
  it("refuses an install whose preparations no longer read as the template", () => {
    const unavailable = {
      ok: false,
      code: "store_template_baseline_unavailable",
    };
    expect(
      completeLegacyInstall({ ...germanFixture, preparations: [] }),
    ).toEqual(unavailable);
    expect(
      completeLegacyInstall({
        ...germanFixture,
        preparations: germanFixture.preparations.slice(1),
      }),
    ).toEqual(unavailable);
    expect(
      completeLegacyInstall({
        ...germanFixture,
        preparations: germanFixture.preparations.map((p, index) =>
          index === 0
            ? {
                ...p,
                graph: {
                  ...p.graph,
                  nodes: p.graph.nodes.filter((n) => n.id !== "output"),
                },
              }
            : p,
        ),
      }),
    ).toEqual(unavailable);
    expect(
      completeLegacyInstall({ ...germanFixture, connections: [] }),
    ).toEqual(unavailable);
    expect(completeLegacyInstall({ ...germanFixture, snapshot: null })).toEqual(
      unavailable,
    );
  });
  it("refuses an append tree version 1 would not build for its sources", () => {
    // A hand-edited extra round: a pass-through append over the downloads
    // append of two sources, read by the model. Every preparation still
    // parses and the model reads a top, but version 1 builds one round.
    const fixture = legacyFixture([apple, google], "en");
    const top = fixture.models.downloads.datasets[0]!;
    const extra = { id: randomUUID(), graph: buildStoreAppend([top]) };
    const tampered = {
      ...fixture,
      preparations: [...fixture.preparations, extra],
      result: {
        ...fixture.result,
        preparationIds: [...fixture.result.preparationIds, extra.id],
      },
      models: {
        ...fixture.models,
        downloads: buildStoreModel(
          "downloads",
          `prepared:${extra.id}:${extra.graph.outputs[0]!}`,
          "en",
        ),
      },
    };
    expect(completeLegacyInstall(fixture).ok).toBe(true);
    expect(completeLegacyInstall(tampered)).toEqual({
      ok: false,
      code: "store_template_baseline_unavailable",
    });
  });
  it("derives the keys of version 1 frozen, whatever the current template", () => {
    for (const count of [1, 2, 80, 81, 6401]) {
      const ids = Array.from({ length: count }, (_, index) => `c${index}`);
      const inputs = {
        name: "x",
        locale: "en" as const,
        projectId: null,
        connections: ids.map((id) => ({
          id,
          name: id,
          connectorId: "google-play" as const,
          datasets: {},
        })),
        fixedProduct: null,
        groups: null,
      };
      if (storeTemplate.version === 1)
        expect(v1PreparationKeys(ids).sort()).toEqual(
          storeTemplate
            .keys(inputs)
            .filter((key) => key.startsWith("preparation:"))
            .sort(),
        );
    }
  });
});
