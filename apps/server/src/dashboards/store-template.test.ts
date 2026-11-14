import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STORE_TEMPLATE_VERSION,
  storeTemplate,
  storeTemplateInputsSchema,
  type StoreTemplateIds,
  type StoreTemplateInputs,
  type StoreTemplateRecord,
} from "./store-template.js";
import {
  buildStoreAppend,
  buildStoreDashboard,
  buildStoreModel,
  buildStorePreparation,
  storeTemplateCopy,
  type StoreMetric,
} from "./store-portfolio.js";
import { apple, google } from "./test-helpers.js";

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
function buildAll(inputs: StoreTemplateInputs): StoreTemplateRecord[] {
  const ids = fakeIds();
  return storeTemplate.keys(inputs).map((key) => {
    const record = storeTemplate.build(key, inputs, ids);
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
};
const VERSION_1_HASH = VERSION_HASHES[1];

describe("versioned store template", () => {
  it("builds version 1 exactly as the install did before versions existed", () => {
    const records = buildAll(fixtureInputs);
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
  it("needs a version bump for any content change", () => {
    expect(VERSION_HASHES[STORE_TEMPLATE_VERSION]).toBe(
      sha256(JSON.stringify(buildAll(fixtureInputs))),
    );
  });
  it("keeps a single connection without an append preparation", () => {
    const single = { ...fixtureInputs, connections: [appleSource] };
    expect(storeTemplate.keys(single)).not.toContain(
      "preparation:append:downloads:0:0",
    );
    const model = buildAll(single).find((r) => r.key === "model:downloads");
    expect(model).toMatchObject({
      kind: "model",
      definition: {
        datasets: [
          `prepared:${uuidFor(`preparation:source:${apple.id}:downloads`)}:output`,
        ],
      },
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
    const records = buildAll(many);
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
  });
  it("records the dashboard's widget keys in reading order and accepts its inputs", () => {
    const dashboard = buildAll(fixtureInputs).at(-1)!;
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
      const keys = storeTemplate.keys(inputs);
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
        const record = storeTemplate.build(key, inputs, ids);
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
