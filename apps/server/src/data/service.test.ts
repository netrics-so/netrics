import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
  adminSetDataPolicy,
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
