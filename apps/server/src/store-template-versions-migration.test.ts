import { createHash, randomUUID } from "node:crypto";
import {
  createDatabase,
  createRawSqlClient,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import type {
  PreparationGraph,
  SemanticModelDefinition,
} from "@netrics/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildStoreAppend,
  buildStoreDashboard,
  buildStoreModel,
  buildStorePreparation,
  type StoreMetric,
  type StoreTemplateSource,
} from "./dashboards/store-portfolio.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// 0072 on installs made before template versions (11E baseline,
// builder-check call): originals are the first published preparation
// version / model release, and the dashboard's original is its content at
// migration time. Fixtures are raw SQL; the drizzle schema is newer.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

const LAST_BEFORE = "0071_project_archive_data_projects";
const metrics: StoreMetric[] = ["downloads", "proceeds", "ratings"];

interface Seeded {
  requestId: string;
  sources: StoreTemplateSource[];
  prepIds: string[];
  prepV1: PreparationGraph[];
  models: Record<StoreMetric, string>;
  modelV1: Record<StoreMetric, SemanticModelDefinition>;
  dashboardId: string;
  mappingId: string;
  productsId: string;
  widgetIds: string[];
}

let testDb: TestDatabase;
let owner: Sql;
let db: Database;
let workspaceId: string;
let otherId: string;
let main: Seeded;
let other: Seeded;

const source = (
  connectorId: StoreTemplateSource["connectorId"],
  name: string,
): StoreTemplateSource => ({
  id: randomUUID(),
  name,
  connectorId,
  datasets:
    connectorId === "app-store-connect"
      ? { sales_rows: randomUUID(), store_ratings: randomUUID() }
      : {
          install_rows: randomUUID(),
          earning_rows: randomUUID(),
          store_ratings: randomUUID(),
        },
});

/** A customer edit published after the install: a renamed step. */
function edited(graph: PreparationGraph): PreparationGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) =>
      node.type === "calculate"
        ? { ...node, name: node.name + " (edited)" }
        : node,
    ),
  };
}

async function seedInstall(
  workspace: string,
  sources: StoreTemplateSource[],
): Promise<Seeded> {
  const mappingId = randomUUID(),
    productsId = randomUUID();
  for (const s of sources)
    await owner`insert into connections (id, workspace_id, connector_id, name, setup_pending)
      values (${s.id}, ${workspace}, ${s.connectorId}, ${s.name}, false)`;
  const prepIds: string[] = [],
    prepV1: PreparationGraph[] = [];
  const preparation = async (name: string, graph: PreparationGraph) => {
    const id = randomUUID();
    const v2 = edited(graph);
    await owner`insert into data_preparations (id, workspace_id, name, graph, version, published_version)
      values (${id}, ${workspace}, ${name}, ${owner.json(v2 as never)}, 2, null)`;
    for (const [version, content] of [
      [1, graph],
      [2, v2],
    ] as const)
      await owner`insert into data_preparation_versions (preparation_id, workspace_id, version, graph, output_schemas, dependencies)
        values (${id}, ${workspace}, ${version}, ${owner.json(content as never)}, '{}', '[]')`;
    await owner`update data_preparations set published_version=2 where id=${id}`;
    prepIds.push(id);
    prepV1.push(graph);
    return `prepared:${id}:${graph.outputs[0]!}`;
  };
  const outputs: Record<StoreMetric, string[]> = {
    downloads: [],
    proceeds: [],
    ratings: [],
  };
  for (const s of sources)
    for (const metric of metrics)
      outputs[metric].push(
        await preparation(
          `${metric} · ${s.name}`,
          buildStorePreparation(s, metric, mappingId, productsId, "de"),
        ),
      );
  const models = {} as Record<StoreMetric, string>,
    modelV1 = {} as Record<StoreMetric, SemanticModelDefinition>;
  for (const metric of metrics) {
    const input =
      outputs[metric].length === 1
        ? outputs[metric][0]!
        : await preparation(metric, buildStoreAppend(outputs[metric]));
    const v1 = buildStoreModel(metric, input, "de");
    const v2 = {
      ...v1,
      measures: v1.measures.map((m) => ({ ...m, name: m.name + " (edited)" })),
    };
    const [model] =
      await owner`insert into data_models (workspace_id, name, definition, version, published_version)
      values (${workspace}, ${"Portfolio · " + metric}, ${owner.json(v2 as never)}, 2, null) returning id`;
    for (const [version, content] of [
      [1, v1],
      [2, v2],
    ] as const)
      await owner`insert into data_model_releases (model_id, workspace_id, version, definition, dependencies, schema_bindings)
        values (${model!.id}, ${workspace}, ${version}, ${owner.json(content as never)}, '[]', '{}')`;
    await owner`update data_models set published_version=2 where id=${model!.id}`;
    models[metric] = model!.id as string;
    modelV1[metric] = v1;
  }
  const request = buildStoreDashboard("App-Portfolio", models, "de");
  const [dashboard] =
    await owner`insert into dashboards (workspace_id, name, show_header, auto_advance, data_filters)
    values (${workspace}, 'Customer name', true, false, ${owner.json(request.settings!.dataFilters as never)}) returning id`;
  const dashboardId = dashboard!.id as string;
  const [slide] =
    await owner`insert into dashboard_slides (dashboard_id, workspace_id, position, name)
    values (${dashboardId}, ${workspace}, 0, ${request.slides![0]!.name!}) returning id`;
  const widgets = [
    ...request.slides![0]!.widgets!,
    // The customer's own widget, bound to a template model.
    { ...request.slides![0]!.widgets![0]!, y: 8, title: "My downloads" },
  ];
  const widgetIds: string[] = [];
  for (const widget of widgets) {
    if (widget.type !== "measure") throw new Error("measure widgets only");
    const [row] =
      await owner`insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type, x, y, w, h, title, model_id, model_binding, options)
      values (${slide!.id}, ${dashboardId}, ${workspace}, 'measure', ${widget.x}, ${widget.y}, ${widget.w}, ${widget.h}, ${widget.title ?? null},
        ${widget.binding.modelId}, ${owner.json(widget.binding as never)}, ${owner.json(widget.options as never)}) returning id`;
    widgetIds.push(row!.id as string);
  }
  const requestId = randomUUID();
  await owner`insert into data_template_installs (workspace_id, request_id, request_hash, result)
    values (${workspace}, ${requestId}, ${createHash("sha256").update(requestId).digest("hex")},
      ${owner.json({
        dashboardId,
        mappingDatasetId: mappingId,
        productDatasetId: productsId,
        models,
        preparationIds: prepIds,
      })})`;
  return {
    requestId,
    sources,
    prepIds,
    prepV1,
    models,
    modelV1,
    dashboardId,
    mappingId,
    productsId,
    widgetIds,
  };
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: LAST_BEFORE });
  owner = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  const [workspace] =
    await owner`insert into workspaces (name) values ('Stores') returning id`;
  workspaceId = workspace!.id as string;
  const [second] =
    await owner`insert into workspaces (name) values ('Other') returning id`;
  otherId = second!.id as string;
  main = await seedInstall(workspaceId, [
    source("app-store-connect", "Apple team"),
    source("google-play", "Play account"),
  ]);
  other = await seedInstall(otherId, [source("google-play", "Other Play")]);
  // Deleted before the migration: the install keeps pointing at it.
  await owner`delete from dashboards where id=${other.dashboardId}`;
  await testDb.migrate();
  db = createDatabase(testDb.appUrl);
});
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});

describe("0072 store template versions", () => {
  it("gives existing installs version 1 with first-published originals and the dashboard as it is now", async () => {
    const [install] =
      await owner`select template_id, template_version, inputs from data_template_installs where workspace_id=${workspaceId}`;
    expect(install).toEqual({
      template_id: "store_portfolio",
      template_version: 1,
      inputs: null,
    });
    const records =
      await owner`select key, kind, record_id, template_version, original, widget_keys from data_template_records where workspace_id=${workspaceId} order by key`;
    expect(records).toHaveLength(9 + 3 + 1 + 2);
    expect(records.every((r) => r.template_version === 1)).toBe(true);
    expect(
      records.find((r) => r.key === "model:proceeds")!.original.definition,
    ).toEqual(main.modelV1.proceeds);
    expect(records.find((r) => r.key === "model:proceeds")!.record_id).toBe(
      main.models.proceeds,
    );
    main.prepIds.forEach((id, index) =>
      expect(
        records.find((r) => r.key === `legacy:${id}`)!.original.graph,
      ).toEqual(main.prepV1[index]),
    );
    expect(records.find((r) => r.key === "dataset:mapping")).toMatchObject({
      kind: "dataset",
      record_id: main.mappingId,
      original: null,
    });
    expect(records.find((r) => r.key === "dataset:products")).toMatchObject({
      kind: "dataset",
      record_id: main.productsId,
      original: null,
    });
    const dashboard = records.find((r) => r.key === "dashboard:portfolio")!;
    expect(dashboard.widget_keys).toBeNull();
    const snapshot = dashboard.original.legacySnapshot;
    expect(snapshot.dashboard.name).toBe("Customer name");
    expect(snapshot.dashboard.data_filters).toHaveLength(6);
    expect(snapshot.slides[0].widgets).toHaveLength(4);
    expect(snapshot.slides[0].widgets.map((w: { id: string }) => w.id)).toEqual(
      main.widgetIds,
    );
  });
  it("keeps the records of each workspace private under the app role", async () => {
    const tables =
      await owner`select relname, relrowsecurity, relforcerowsecurity from pg_class
        where relname in ('data_template_records', 'data_template_updates') order by relname`;
    expect(tables).toEqual([
      {
        relname: "data_template_records",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "data_template_updates",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
    for (const id of [workspaceId, otherId]) {
      const rows = await withWorkspace(db, { workspaceId: id }, (tx) =>
        tx.select().from(schema.dataTemplateRecords),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.workspaceId === id)).toBe(true);
    }
    const none = await withWorkspace(db, { workspaceId: randomUUID() }, (tx) =>
      tx.select().from(schema.dataTemplateRecords),
    );
    expect(none).toEqual([]);
  });
  it("skips records deleted before the migration without failing", async () => {
    const keys = (
      await owner`select key from data_template_records where workspace_id=${otherId} order by key`
    ).map((r) => r.key as string);
    expect(keys).not.toContain("dashboard:portfolio");
    expect(keys.filter((key) => key.startsWith("model:"))).toEqual([
      "model:downloads",
      "model:proceeds",
      "model:ratings",
    ]);
    expect(keys.filter((key) => key.startsWith("legacy:"))).toHaveLength(3);
  });
});
