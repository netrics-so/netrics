import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
  adminSetDataPolicy,
  ingestDatasetPage,
  withWorkspace,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import {
  type SemanticModelDefinition,
  type PreparationGraph,
  type DataExpression,
} from "@netrics/domain";
import { createTestDatabase } from "../test-db.js";
import { createDataService, type DataActor } from "./service.js";

const NOW = new Date("2026-11-05T12:00:00Z");
let db: Database,
  admin: Sql,
  actor: DataActor,
  other: DataActor,
  service: ReturnType<typeof createDataService>;
let productId: string, salesId: string, adsId: string;
let salesDefinition: SourceDatasetDefinition;
let initialModel: SemanticModelDefinition;
const f = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
function definition(
  key: string,
  fields: Array<{ id: string; type: "string" | "decimal" }>,
): SourceDatasetDefinition {
  return sourceDatasetSchema.parse({
    key,
    name: key,
    version: 1,
    mode: "snapshot",
    grain: "one reference record",
    keyFields: ["id"],
    retentionDays: 3650,
    fields: fields.map((field) => ({
      ...field,
      name: field.id,
      nullable: false,
      classification: "internal",
      ...(field.id === "amount"
        ? { unit: "currency", currencyField: "currency", scale: 2 }
        : {}),
    })),
  });
}
beforeAll(async () => {
  const test = await createTestDatabase({ upTo: "0052_source_datasets" });
  admin = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] =
    await admin`insert into users(email,display_name) values ('data-owner@example.com','Owner') returning id`;
  const [a, b] =
    await admin`insert into workspaces(name) values ('A'),('B') returning id`;
  actor = { workspaceId: a!.id as string, callerId: user!.id as string };
  other = { workspaceId: b!.id as string, callerId: user!.id as string };
  await admin`insert into connectors(id,version,manifest) values ('migration-fixture','1.0.0','{}')`;
  const [connection] =
    await admin`insert into connections(workspace_id,connector_id,name) values (${actor.workspaceId},'migration-fixture','Existing') returning id`;
  await admin`insert into data_datasets(workspace_id,connection_id,key,name) values (${actor.workspaceId},${connection!.id},'existing','Existing source')`;
  await test.migrate();
  db = createDatabase(test.appUrl);
  service = createDataService(db, () => NOW);
  const products = definition("products", [
    { id: "id", type: "string" },
    { id: "name", type: "string" },
    { id: "country", type: "string" },
  ]);
  productId = (
    await service.saveManual(actor, {
      definition: products,
      records: [
        { values: { id: "a", name: "App A", country: "DE" } },
        { values: { id: "b", name: "App B", country: "FR" } },
      ],
    })
  ).datasetId;
  salesDefinition = definition("sales", [
    { id: "id", type: "string" },
    { id: "app", type: "string" },
    { id: "amount", type: "decimal" },
    { id: "currency", type: "string" },
  ]);
  salesId = (
    await service.saveManual(actor, {
      definition: salesDefinition,
      records: [
        { values: { id: "s1", app: "a", amount: "100.00", currency: "EUR" } },
        { values: { id: "s2", app: "a", amount: "50.00", currency: "EUR" } },
        { values: { id: "s3", app: "b", amount: "25.00", currency: "EUR" } },
      ],
    })
  ).datasetId;
  adsId = (
    await service.saveManual(actor, {
      definition: { ...salesDefinition, key: "ads", name: "Ads" },
      records: [
        { values: { id: "a1", app: "a", amount: "30.00", currency: "EUR" } },
        { values: { id: "a2", app: "b", amount: "10.00", currency: "EUR" } },
      ],
    })
  ).datasetId;
  initialModel = {
    version: 1,
    datasets: [productId, salesId, adsId],
    relationships: [
      {
        id: "sales-product",
        from: { datasetId: salesId, fieldId: "app" },
        to: { datasetId: productId, fieldId: "id" },
        cardinality: "many_to_one",
      },
      {
        id: "ads-product",
        from: { datasetId: adsId, fieldId: "app" },
        to: { datasetId: productId, fieldId: "id" },
        cardinality: "many_to_one",
      },
    ],
    dimensions: [
      { id: "app", name: "App", datasetId: productId, fieldId: "name" },
      {
        id: "country",
        name: "Country",
        datasetId: productId,
        fieldId: "country",
      },
    ],
    measures: [
      {
        id: "income",
        name: "Income",
        kind: "aggregate",
        datasetId: salesId,
        aggregate: {
          id: "income",
          name: "Income",
          op: "sum",
          fieldId: "amount",
        },
      },
      {
        id: "spend",
        name: "Spend",
        kind: "aggregate",
        datasetId: adsId,
        aggregate: { id: "spend", name: "Spend", op: "sum", fieldId: "amount" },
      },
      {
        id: "contribution",
        name: "Contribution",
        kind: "formula",
        expression: {
          kind: "call",
          fn: "subtract",
          args: [f("income"), f("spend")],
        },
      },
    ],
  };
}, 60000);
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await db?.$client.end({ timeout: 5 });
});

describe("publication before the first complete report", () => {
  it("publishes ordinary definitions without fake generations, then reads the first completed input", async () => {
    const [connection] =
      await admin`select id from connections where workspace_id=${actor.workspaceId} limit 1`;
    const pendingDefinition = { ...salesDefinition, key: "pending-sales" };
    const page = {
      datasetKey: pendingDefinition.key,
      schemaVersion: 1,
      refreshKey: "first-report",
      pageKey: "p1",
      previousPageKey: null,
      complete: false,
      records: [
        {
          values: {
            id: "pending-order",
            app: "a",
            amount: "3.50",
            currency: "EUR",
          },
        },
      ],
    };
    const input = {
      workspaceId: actor.workspaceId,
      connectionId: connection!.id as string,
      definition: pendingDefinition,
      page,
      now: NOW,
    };
    const first = await withWorkspace(
      db,
      { workspaceId: actor.workspaceId },
      (tx) => ingestDatasetPage(tx, input),
    );
    expect(first.generationId).toBeNull();
    const graph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: first.datasetId },
        {
          id: "double",
          type: "calculate",
          input: "source",
          fieldId: "double",
          name: "Double",
          expression: {
            kind: "call",
            fn: "multiply",
            args: [f("amount"), { kind: "literal", type: "integer", value: 2 }],
          },
        },
      ],
      outputs: ["double"],
    };
    const preparationPreview = await service.previewPreparation(actor, graph);
    expect(preparationPreview.outputs.double?.rows).toEqual([]);
    expect(preparationPreview.warnings).toContain("data_source_pending");
    const preparation = await service.savePreparation(actor, {
      name: "Waiting calculation",
      graph,
    });
    await service.publishPreparation(actor, preparation.preparation.id, 1);
    const prepared = `prepared:${preparation.preparation.id}:double`;
    const definition: SemanticModelDefinition = {
      version: 1,
      datasets: [prepared],
      relationships: [],
      dimensions: [],
      measures: [
        {
          id: "count",
          name: "Count",
          kind: "aggregate",
          datasetId: prepared,
          aggregate: { id: "count", name: "Count", op: "count" },
        },
        {
          id: "double",
          name: "Double",
          kind: "aggregate",
          datasetId: prepared,
          aggregate: {
            id: "double",
            name: "Double",
            op: "sum",
            fieldId: "double",
          },
        },
      ],
    };
    const modelPreview = await service.previewModel(actor, definition, {
      measureIds: ["count", "double"],
      groupBy: [],
    });
    expect(modelPreview.rows).toEqual([]);
    expect(modelPreview.warnings).toContain("data_source_pending");
    const model = await service.saveModel(actor, {
      name: "Waiting model",
      definition,
    });
    await service.publishModel(actor, model.model.id, 1);
    const mapping = await service.saveManual(actor, {
      definition: { ...pendingDefinition, key: "waiting-map" },
      records: [
        { values: { id: "map-1", app: "a", amount: "0", currency: "EUR" } },
        { values: { id: "map-2", app: "a", amount: "0", currency: "EUR" } },
      ],
    });
    const badMapping = await service.saveModel(actor, {
      name: "Bad mapping beside pending input",
      definition: {
        ...definition,
        datasets: [prepared, mapping.datasetId],
        relationships: [
          {
            id: "mapping",
            from: { datasetId: prepared, fieldId: "app" },
            to: { datasetId: mapping.datasetId, fieldId: "app" },
            cardinality: "many_to_one",
          },
        ],
      },
    });
    await expect(
      service.publishModel(actor, badMapping.model.id, 1),
    ).rejects.toThrow("model_relationship_cardinality_violation");
    expect(
      await admin`select id from data_generations where dataset_id=${first.datasetId}`,
    ).toHaveLength(0);
    expect(
      await admin`select id from data_prepared_generations where preparation_id=${preparation.preparation.id}`,
    ).toHaveLength(0);
    const waiting = await service.query(actor, model.model.id, {
      measureIds: ["count"],
      groupBy: [],
    });
    expect(waiting.rows[0]?.measures.count).toMatchObject({
      value: null,
      status: "missing",
    });
    expect(waiting.pendingSources).toEqual([first.datasetId]);
    expect(waiting.warnings).toContain("data_source_pending");
    expect(
      await admin`select query_key from data_model_query_snapshots where release_id=${waiting.releaseId!}`,
    ).toHaveLength(0);
    const combinedGraph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "ready", type: "source", datasetId: salesId },
        { id: "waiting", type: "source", datasetId: first.datasetId },
        { id: "combined", type: "append", inputs: ["ready", "waiting"] },
      ],
      outputs: ["combined"],
    };
    const combinedPreparation = await service.savePreparation(actor, {
      name: "Known and pending reports",
      graph: combinedGraph,
    });
    await service.publishPreparation(
      actor,
      combinedPreparation.preparation.id,
      1,
    );
    const combinedSource = `prepared:${combinedPreparation.preparation.id}:combined`;
    const combinedModel = await service.saveModel(actor, {
      name: "Partial proceeds",
      definition: {
        version: 1,
        datasets: [combinedSource],
        relationships: [],
        dimensions: [],
        measures: [
          {
            id: "proceeds",
            name: "Proceeds",
            kind: "aggregate",
            datasetId: combinedSource,
            aggregate: {
              id: "proceeds",
              name: "Proceeds",
              op: "sum",
              fieldId: "amount",
            },
          },
        ],
      },
    });
    await service.publishModel(actor, combinedModel.model.id, 1);
    const partial = await service.query(actor, combinedModel.model.id, {
      measureIds: ["proceeds"],
      groupBy: [],
    });
    expect(partial.rows[0]?.measures.proceeds).toMatchObject({
      value: "175",
      currency: "EUR",
      status: "partial",
    });
    expect(partial.pendingSources).toEqual([first.datasetId]);
    expect(partial.receivedAt).toBeNull();
    expect(
      await admin`select id from data_prepared_generations where preparation_id=${combinedPreparation.preparation.id}`,
    ).toHaveLength(0);
    await expect(service.preview(actor, first.datasetId)).rejects.toThrow(
      "data_source_pending",
    );
    const foreign = await service.saveModel(other, {
      name: "Forbidden schema",
      definition,
    });
    await expect(
      service.publishModel(other, foreign.model.id, 1),
    ).rejects.toThrow("data_source_not_found");
    const completed = await withWorkspace(
      db,
      { workspaceId: actor.workspaceId },
      (tx) =>
        ingestDatasetPage(tx, {
          ...input,
          page: {
            ...page,
            pageKey: "p2",
            previousPageKey: "p1",
            complete: true,
            records: [],
          },
        }),
    );
    expect(completed.generationId).toBeTruthy();
    const result = await service.query(actor, model.model.id, {
      measureIds: ["count", "double"],
      groupBy: [],
    });
    expect(result.rows[0]?.measures.count).toMatchObject({
      value: 1,
      status: "ok",
    });
    expect(result.rows[0]?.measures.double).toMatchObject({
      value: "7",
      currency: "EUR",
      status: "ok",
    });
    expect(result.provenance).toContainEqual({
      datasetId: first.datasetId,
      generationId: completed.generationId,
    });
    const completeTotal = await service.query(actor, combinedModel.model.id, {
      measureIds: ["proceeds"],
      groupBy: [],
    });
    expect(completeTotal.rows[0]?.measures.proceeds).toMatchObject({
      value: "178.5",
      status: "ok",
    });
    expect(completeTotal.pendingSources).toBeUndefined();

    // A source that once had data never turns back into an empty first import.
    await admin`delete from data_generations where dataset_id=${first.datasetId}`;
    expect(
      (
        await admin`select has_published_data from data_datasets where id=${first.datasetId}`
      )[0]!.has_published_data,
    ).toBe(true);
    const changed = await service.saveModel(
      actor,
      { name: "Waiting model", definition, version: 1 },
      model.model.id,
    );
    await expect(
      service.publishModel(actor, model.model.id, changed.model.version),
    ).rejects.toThrow("data_source_history_unavailable");
  });
});

describe("persistent reusable data processing", () => {
  it("upgrades source metadata on a populated prior database", async () => {
    expect(
      (await admin`select kind from data_datasets where key='existing'`)[0]
        ?.kind,
    ).toBe("source");
  });
  it("lists and previews typed manual sources without requiring another service connection", async () => {
    const listed = await service.listSources(actor);
    expect(
      listed.sources.some((s) => s.id === salesId && s.kind === "manual"),
    ).toBe(true);
    const preview = await service.preview(actor, salesId);
    expect(preview.rows).toHaveLength(3);
    expect(preview.fields.find((f) => f.id === "amount")?.type).toBe("decimal");
    await expect(service.preview(other, salesId)).rejects.toThrow(
      "data_source_not_found",
    );
  });
  it("does not let creation overwrite an existing manual table key", async () => {
    await expect(
      service.saveManual(actor, { definition: salesDefinition, records: [] }),
    ).rejects.toThrow("data_source_key_taken");
  });
  it("requires the current generation before replacing reference data", async () => {
    await expect(
      service.saveManual(
        actor,
        {
          definition: salesDefinition,
          records: [],
          generationId: randomUUID(),
        },
        salesId,
      ),
    ).rejects.toThrow("version_conflict");
    expect((await service.preview(actor, salesId)).rows).toHaveLength(3);
  });
  it("previews changes and keeps published queries independent from drafts", async () => {
    const created = await service.saveModel(actor, {
      name: "Overview",
      definition: initialModel,
    });
    await expect(
      service.query(actor, created.model.id, {
        measureIds: ["contribution"],
        groupBy: [],
      }),
    ).rejects.toThrow("data_model_not_published");
    const published = await service.publishModel(
      actor,
      created.model.id,
      created.model.version,
    );
    const filter: DataExpression = {
      kind: "call",
      fn: "eq",
      args: [f("country"), { kind: "literal", type: "string", value: "DE" }],
    };
    const first = await service.query(actor, created.model.id, {
      measureIds: ["contribution"],
      groupBy: [],
      filter,
    });
    expect(first.rows[0]?.measures.contribution).toMatchObject({
      value: "120",
      currency: "EUR",
    });
    const changed: SemanticModelDefinition = {
      ...initialModel,
      measures: initialModel.measures.map((m) =>
        m.id === "contribution"
          ? { id: m.id, name: m.name, kind: "formula", expression: f("income") }
          : m,
      ),
    };
    const saved = await service.saveModel(
      actor,
      {
        name: "Overview",
        definition: changed,
        version: published.model.version,
      },
      created.model.id,
    );
    expect(
      (
        await service.query(actor, created.model.id, {
          measureIds: ["contribution"],
          groupBy: [],
          filter,
        })
      ).rows[0]?.measures.contribution?.value,
    ).toBe("120");
    expect(
      (
        await service.query(
          actor,
          created.model.id,
          { measureIds: ["contribution"], groupBy: [], filter },
          true,
        )
      ).rows[0]?.measures.contribution?.value,
    ).toBe("150");
    await service.publishModel(actor, created.model.id, saved.model.version);
    expect(
      (
        await service.query(actor, created.model.id, {
          measureIds: ["contribution"],
          groupBy: [],
          filter,
        })
      ).rows[0]?.measures.contribution?.value,
    ).toBe("150");
  });
  it("rejects stale draft writes and hides models from another workspace", async () => {
    const created = await service.saveModel(actor, {
      name: "Concurrent",
      definition: initialModel,
    });
    await service.saveModel(
      actor,
      { name: "Changed", definition: initialModel, version: 1 },
      created.model.id,
    );
    await expect(
      service.saveModel(
        actor,
        { name: "Lost edit", definition: initialModel, version: 1 },
        created.model.id,
      ),
    ).rejects.toThrow("version_conflict");
    await expect(service.getModel(other, created.model.id)).rejects.toThrow(
      "data_model_not_found",
    );
    await expect(
      service.query(other, created.model.id, {
        measureIds: ["income"],
        groupBy: [],
      }),
    ).rejects.toThrow("data_model_not_found");
  });
  it("publishes a reusable preparation and reads its output through a model", async () => {
    const graph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: salesId },
        {
          id: "calculated",
          type: "calculate",
          input: "source",
          fieldId: "double",
          name: "Double income",
          expression: {
            kind: "call",
            fn: "multiply",
            args: [f("amount"), { kind: "literal", type: "integer", value: 2 }],
          },
        },
      ],
      outputs: ["calculated"],
    };
    const created = await service.savePreparation(actor, {
      name: "Prepared sales",
      graph,
    });
    const preview = await service.previewPreparation(actor, graph);
    expect(preview.outputs.calculated?.rows[0]?.double).toBe("200");
    await service.publishPreparation(actor, created.preparation.id, 1);
    const sourceId = "prepared:" + created.preparation.id + ":calculated";
    expect((await service.preview(actor, sourceId)).rows[0]?.double).toBe(
      "200",
    );
    const definition: SemanticModelDefinition = {
      version: 1,
      datasets: [sourceId],
      relationships: [],
      dimensions: [],
      measures: [
        {
          id: "double",
          name: "Double",
          kind: "aggregate",
          datasetId: sourceId,
          aggregate: {
            id: "double",
            name: "Double",
            op: "sum",
            fieldId: "double",
          },
        },
      ],
    };
    const model = await service.saveModel(actor, {
      name: "Prepared model",
      definition,
    });
    await service.publishModel(actor, model.model.id, 1);
    expect(
      (
        await service.query(actor, model.model.id, {
          measureIds: ["double"],
          groupBy: [],
        })
      ).rows[0]?.measures.double?.value,
    ).toBe("350");
    const [firstBuild] =
      await admin`select id from data_prepared_generations where preparation_id=${created.preparation.id}`;
    expect(firstBuild?.id).toBeTruthy();
    const unchanged = await service.query(actor, model.model.id, {
      measureIds: ["double"],
      groupBy: [],
    });
    expect(unchanged.provenance).toContainEqual({
      datasetId: sourceId,
      generationId: firstBuild!.id,
    });
    const changed: PreparationGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.type === "calculate"
          ? {
              ...node,
              expression: {
                kind: "call",
                fn: "multiply",
                args: [
                  f("amount"),
                  { kind: "literal", type: "integer", value: 3 },
                ],
              },
            }
          : node,
      ),
    };
    await service.savePreparation(
      actor,
      { name: "Prepared sales", graph: changed, version: 1 },
      created.preparation.id,
    );
    await service.publishPreparation(actor, created.preparation.id, 2);
    // Existing published models keep their dependency revision until republished.
    expect(
      (
        await service.query(actor, model.model.id, {
          measureIds: ["double"],
          groupBy: [],
        })
      ).rows[0]?.measures.double?.value,
    ).toBe("350");
    expect((await service.preview(actor, sourceId)).rows[0]?.double).toBe(
      "300",
    );
    await service.saveModel(
      actor,
      { name: "Prepared model", definition, version: 1 },
      model.model.id,
    );
    await service.publishModel(actor, model.model.id, 2);
    expect(
      (
        await service.query(actor, model.model.id, {
          measureIds: ["double"],
          groupBy: [],
        })
      ).rows[0]?.measures.double?.value,
    ).toBe("525");
    await expect(
      service.getPreparation(other, created.preparation.id),
    ).rejects.toThrow("data_preparation_not_found");
  });
  it("rolls back a failed publication and keeps its old release available", async () => {
    const created = await service.saveModel(actor, {
      name: "Safe publish",
      definition: initialModel,
    });
    await service.publishModel(actor, created.model.id, 1);
    const invalid: SemanticModelDefinition = {
      ...initialModel,
      measures: [
        {
          id: "broken",
          name: "Broken",
          kind: "aggregate",
          datasetId: salesId,
          aggregate: {
            id: "broken",
            name: "Broken",
            op: "sum",
            fieldId: "missing",
          },
        },
      ],
    };
    const updated = await service.saveModel(
      actor,
      { name: "Safe publish", definition: invalid, version: 1 },
      created.model.id,
    );
    await expect(
      service.publishModel(actor, created.model.id, updated.model.version),
    ).rejects.toThrow("data_field_not_found");
    expect(
      (
        await service.query(actor, created.model.id, {
          measureIds: ["income"],
          groupBy: [],
        })
      ).rows[0]?.measures.income?.value,
    ).toBe("175");
  });
  it("forces tenant RLS on version, release and snapshot metadata", async () => {
    for (const table of [
      "data_preparations",
      "data_preparation_versions",
      "data_models",
      "data_model_releases",
      "data_model_query_snapshots",
      "data_prepared_generations",
    ]) {
      const rows = await db.execute(
        (await import("drizzle-orm")).sql.raw("select * from " + table),
      );
      expect(rows).toHaveLength(0);
    }
  });
  it("applies tier policy, permits uncapped retention, and never revives expired data", async () => {
    const [workspace] =
      await admin`insert into workspaces(name) values ('Policy') returning id`;
    const scoped = { ...actor, workspaceId: workspace!.id as string };
    const reference = {
      ...definition("reference", [{ id: "id", type: "string" }]),
      retentionDays: null,
    };
    const source = await service.saveManual(scoped, {
      definition: reference,
      records: [{ values: { id: "a" } }, { values: { id: "b" } }],
    });
    const future = createDataService(
      db,
      () => new Date("2070-01-01T00:00:00Z"),
    );
    expect((await future.preview(scoped, source.datasetId)).rows).toHaveLength(
      2,
    );
    const [stored] =
      await admin`select expires_at from data_generations where id=${source.generationId}`;
    expect(stored!.expires_at).toBeNull();
    await adminSetDataPolicy(db, scoped.workspaceId, {
      queryRows: 1,
      maxSources: 1,
    });
    await expect(service.preview(scoped, source.datasetId)).rejects.toThrow(
      "data_source_row_limit",
    );
    await expect(
      service.saveManual(scoped, {
        definition: { ...reference, key: "second" },
        records: [],
      }),
    ).rejects.toThrow("dataset_source_quota");
    expect((await service.listSources(scoped)).sources).toHaveLength(1);
    await adminSetDataPolicy(db, scoped.workspaceId, { queryRows: null });
    expect((await service.preview(scoped, source.datasetId)).rows).toHaveLength(
      2,
    );
    await adminSetDataPolicy(db, scoped.workspaceId, { maxRetentionDays: 1 });
    await expect(future.preview(scoped, source.datasetId)).rejects.toThrow(
      "data_source_expired",
    );
    await adminSetDataPolicy(db, scoped.workspaceId, {});
    await expect(future.preview(scoped, source.datasetId)).rejects.toThrow(
      "data_source_expired",
    );
    await expect(service.preview(other, source.datasetId)).rejects.toThrow(
      "data_source_not_found",
    );
  });
  it("falls back to one complete valid generation vector after a cardinality failure", async () => {
    const mappingDefinition = definition("fallback-mapping", [
      { id: "id", type: "string" },
      { id: "app", type: "string" },
    ]);
    const mapping = await service.saveManual(actor, {
      definition: mappingDefinition,
      records: [{ values: { id: "p1", app: "a" } }],
    });
    const model = await service.saveModel(actor, {
      name: "Fallback",
      definition: {
        ...initialModel,
        datasets: [salesId, mapping.datasetId],
        relationships: [
          {
            id: "mapping",
            from: { datasetId: salesId, fieldId: "app" },
            to: { datasetId: mapping.datasetId, fieldId: "app" },
            cardinality: "many_to_one",
          },
        ],
        dimensions: [
          {
            id: "app",
            name: "App",
            datasetId: mapping.datasetId,
            fieldId: "app",
          },
        ],
        measures: [initialModel.measures[0]!],
      },
    });
    await service.publishModel(actor, model.model.id, 1);
    const query = { measureIds: ["income"], groupBy: ["app"] };
    const first = await service.query(actor, model.model.id, query);
    expect(first.stale).toBe(false);
    await service.saveManual(
      actor,
      {
        definition: mappingDefinition,
        generationId: mapping.generationId,
        records: [
          { values: { id: "p1", app: "a" } },
          { values: { id: "p2", app: "a" } },
        ],
      },
      mapping.datasetId,
    );
    const fallback = await service.query(actor, model.model.id, query);
    expect(fallback).toMatchObject({
      stale: true,
      warnings: ["using_last_valid_source_snapshot"],
    });
    expect(fallback.rows).toEqual(first.rows);
    expect(fallback.provenance).toEqual(first.provenance);
    // A different query cannot borrow a snapshot with different filters/grain.
    await expect(
      service.query(actor, model.model.id, { ...query, limit: 10 }),
    ).rejects.toThrow();
    // Cached identities never extend the source/cache retention.
    const later = createDataService(
      db,
      () => new Date(NOW.getTime() + 2 * 86400000),
    );
    await expect(later.query(actor, model.model.id, query)).rejects.toThrow();
  });
});

describe("paged reference editing", () => {
  it("publishes all pages atomically, reads pinned generations and rejects stale writers", async () => {
    const def = definition("paged_edit", [
      { id: "id", type: "string" },
      { id: "amount", type: "decimal" },
      { id: "currency", type: "string" },
    ]);
    def.fields = def.fields.map((field) =>
      field.id === "amount" ? { ...field, scale: 4 } : field,
    );
    const records = Array.from({ length: 1205 }, (_, index) => ({
      values: {
        id: String(index).padStart(5, "0"),
        amount: "12345678901234567890.1200",
        currency: "EUR",
      },
    }));
    const refreshId = randomUUID();
    const staged = await service.saveManualPage(actor, {
      definition: def,
      generationId: null,
      refreshId,
      page: 0,
      complete: false,
      records: records.slice(0, 1000),
    });
    expect(staged.generationId).toBeNull();
    const empty = await service.readManual(actor, staged.datasetId, {
      offset: 0,
      limit: 1000,
    });
    expect(empty.records).toEqual([]);
    const finalPage = {
      definition: def,
      datasetId: staged.datasetId,
      generationId: null,
      refreshId,
      page: 1,
      complete: true,
      records: records.slice(1000),
    };
    const completed = await service.saveManualPage(actor, finalPage);
    expect(completed.generationId).toBeTruthy();
    expect(await service.saveManualPage(actor, finalPage)).toEqual(completed);
    const first = await service.readManual(actor, staged.datasetId, {
      generationId: completed.generationId!,
      offset: 0,
      limit: 1000,
    });
    const second = await service.readManual(actor, staged.datasetId, {
      generationId: completed.generationId!,
      offset: first.records.length,
      limit: 1000,
    });
    expect(first.total).toBe(1205);
    expect([...first.records, ...second.records]).toEqual(records);
    await expect(
      service.readManual(other, staged.datasetId, { offset: 0, limit: 1000 }),
    ).rejects.toThrow("data_source_not_found");
    await expect(
      service.saveManualPage(other, { ...finalPage, refreshId: randomUUID() }),
    ).rejects.toThrow("data_source_not_found");

    // A cancelled edit can reserve a schema version without publishing any row.
    await service.saveManualPage(actor, {
      ...finalPage,
      definition: { ...def, name: "Cancelled" },
      generationId: completed.generationId,
      refreshId: randomUUID(),
      page: 0,
      complete: false,
      records: [],
    });
    const proposal = {
      ...finalPage,
      definition: { ...def, name: "Edited" },
      generationId: completed.generationId,
      page: 0,
      records: [{ values: { id: "new", amount: "0.10", currency: "EUR" } }],
    };
    const writes = await Promise.allSettled([
      service.saveManualPage(actor, { ...proposal, refreshId: randomUUID() }),
      service.saveManualPage(actor, { ...proposal, refreshId: randomUUID() }),
    ]);
    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = writes.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("version_conflict");
    const latest = await service.readManual(actor, staged.datasetId, {
      offset: 0,
      limit: 1000,
    });
    expect(latest.definition.name).toBe("Edited");
    expect(latest.records).toEqual(proposal.records);
    expect(
      (
        await service.readManual(actor, staged.datasetId, {
          generationId: completed.generationId!,
          offset: 1000,
          limit: 1000,
        })
      ).records,
    ).toHaveLength(205);
    await expect(service.saveManualPage(actor, finalPage)).rejects.toThrow(
      "version_conflict",
    );
    await admin`delete from data_generations where dataset_id=${staged.datasetId}`;
    await expect(
      service.readManual(actor, staged.datasetId, { offset: 0, limit: 1000 }),
    ).rejects.toThrow("data_source_history_unavailable");
  });
});
