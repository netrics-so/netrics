import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import {
  sourceDatasetSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import type { DatasetField } from "@netrics/connector-sdk";
import type {
  DataExpression,
  PreparationGraph,
  SemanticModelDefinition,
} from "@netrics/domain";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { createDataService, type DataActor } from "./service.js";

const NOW = new Date("2026-11-06T12:00:00Z");
const query = { measureIds: ["total"], groupBy: [] };
let db: Database, admin: Sql, callerId: string;
const field = (
  id: string,
  type: DatasetField["type"],
  extra: Partial<DatasetField> = {},
): DatasetField => ({
  id,
  name: id,
  type,
  nullable: false,
  classification: "internal",
  ...extra,
});
const ref = (fieldId: string): DataExpression => ({ kind: "field", fieldId });
const literal = (value: number): DataExpression => ({
  kind: "literal",
  type: "integer",
  value,
});
const multiply = (
  left: DataExpression,
  right: DataExpression,
): DataExpression => ({ kind: "call", fn: "multiply", args: [left, right] });
const tableDefinition = (key: string, fields: DatasetField[]) =>
  sourceDatasetSchema.parse({
    key,
    name: key,
    version: 1,
    mode: "snapshot",
    grain: "One reference row",
    keyFields: ["id"],
    retentionDays: null,
    fields: [field("id", "string"), ...fields],
  });
type Service = ReturnType<typeof createDataService>;
type Model = Awaited<ReturnType<Service["saveModel"]>>["model"];
interface Table {
  id: string;
  generationId: string;
  definition: SourceDatasetDefinition;
}
interface Fixture {
  actor: DataActor;
  service: Service;
}
beforeAll(async () => {
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  admin = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] =
    await admin`insert into users(email,display_name) values ('model-bindings@example.com','Owner') returning id`;
  callerId = user!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});
async function fixture(): Promise<Fixture> {
  const [workspace] =
    await admin`insert into workspaces(name) values ('Model schema bindings') returning id`;
  return {
    actor: { workspaceId: workspace!.id as string, callerId },
    service: createDataService(db, () => NOW),
  };
}
async function enter(
  f: Fixture,
  key: string,
  fields: DatasetField[],
  rows: Record<string, unknown>[],
): Promise<Table> {
  const definition = tableDefinition(key, fields);
  const result = await f.service.saveManual(f.actor, {
    definition,
    records: rows.map((values) => ({ values })),
  });
  return {
    id: result.datasetId,
    generationId: result.generationId,
    definition,
  };
}
async function replace(
  f: Fixture,
  table: Table,
  fields: DatasetField[],
  rows: Record<string, unknown>[],
) {
  const definition = sourceDatasetSchema.parse({
    ...table.definition,
    version: table.definition.version + 1,
    fields: [field("id", "string"), ...fields],
  });
  const result = await f.service.saveManual(
    f.actor,
    {
      definition,
      generationId: table.generationId,
      records: rows.map((values) => ({ values })),
    },
    table.id,
  );
  table.definition = definition;
  table.generationId = result.generationId;
}
function semantic(
  datasetId: string,
  fieldId = "amount",
): SemanticModelDefinition {
  return {
    version: 1,
    datasets: [datasetId],
    relationships: [],
    dimensions: [],
    measures: [
      {
        id: "total",
        name: "Total",
        kind: "aggregate",
        datasetId,
        aggregate: { id: "total", name: "Total", op: "sum", fieldId },
      },
    ],
  };
}
async function publishModel(
  f: Fixture,
  definition: SemanticModelDefinition,
): Promise<Model> {
  const model = (
    await f.service.saveModel(f.actor, { name: "Model", definition })
  ).model;
  return (await f.service.publishModel(f.actor, model.id, model.version)).model;
}
async function restore(f: Fixture, model: Model) {
  return (
    await f.service.restoreModel(f.actor, model.id, {
      version: model.version,
      publishedVersion: 1,
    })
  ).model;
}
async function prep(f: Fixture, graph: PreparationGraph) {
  const saved = (
    await f.service.savePreparation(f.actor, { name: "Preparation", graph })
  ).preparation;
  return (await f.service.publishPreparation(f.actor, saved.id, saved.version))
    .preparation;
}
async function expectUsedDriftRejected(f: Fixture, model: Model) {
  // Metadata must remain readable for repair, even while compatibility blocks use.
  expect(
    (await f.service.modelInputs(f.actor, model.id, model.version)).sources
      .length,
  ).toBeGreaterThan(0);
  await expect(
    f.service.previewModel(f.actor, model.definition, query, {
      id: model.id,
      version: model.version,
    }),
  ).rejects.toThrow("data_model_schema_changed");
  await expect(f.service.query(f.actor, model.id, query, true)).rejects.toThrow(
    "data_model_schema_changed",
  );
  await expect(
    f.service.publishModel(f.actor, model.id, model.version),
  ).rejects.toThrow("data_model_schema_changed");
  // No pre-change query seeded a fallback for these fixtures.
  await expect(f.service.query(f.actor, model.id, query)).rejects.toThrow(
    "data_model_schema_changed",
  );
  expect(
    (await f.service.getModel(f.actor, model.id)).model.publishedVersion,
  ).toBe(1);
}

describe("restored model schema dependencies", () => {
  it("ignores unused snapshot drift while keeping nested preparation pins and ordinary release guards", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "nested",
      [field("amount", "decimal"), field("x", "string")],
      [{ id: "a", amount: "5", x: "extra" }],
    );
    const scaled = (factor: number): PreparationGraph => ({
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: raw.id },
        {
          id: "output",
          type: "calculate",
          input: "source",
          fieldId: "scaled",
          name: "Scaled",
          expression: multiply(ref("amount"), literal(factor)),
        },
      ],
      outputs: ["output"],
    });
    let base = await prep(f, scaled(2));
    const parentGraph: PreparationGraph = {
      version: 1,
      nodes: [
        {
          id: "source",
          type: "source",
          datasetId: `prepared:${base.id}:output`,
        },
        {
          id: "output",
          type: "select",
          input: "source",
          fields: ["id", "scaled"],
        },
      ],
      outputs: ["output"],
    };
    const parent = await prep(f, parentGraph);
    let model = await publishModel(
      f,
      semantic(`prepared:${parent.id}:output`, "scaled"),
    );
    expect(
      (await f.service.query(f.actor, model.id, query)).rows[0]!.measures.total!
        .value,
    ).toBe("10");
    model = await restore(f, model);
    base = (
      await f.service.savePreparation(
        f.actor,
        { name: base.name, graph: scaled(3), version: base.version },
        base.id,
      )
    ).preparation;
    await f.service.publishPreparation(f.actor, base.id, base.version);
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("x", "integer")],
      [{ id: "a", amount: "10", x: 7 }],
    );
    const metadata = await f.service.modelInputs(
      f.actor,
      model.id,
      model.version,
    );
    expect(
      metadata.sources
        .find((source) => source.id === raw.id)!
        .fields.find((entry) => entry.id === "x")!.type,
    ).toBe("integer");
    const preview = await f.service.previewModel(
      f.actor,
      model.definition,
      query,
      { id: model.id, version: model.version },
    );
    expect(preview.rows[0]!.measures.total!.value).toBe("20");
    expect(
      (await f.service.query(f.actor, model.id, query, true)).rows[0]!.measures
        .total!.value,
    ).toBe("20");
    const old = await f.service.query(f.actor, model.id, query);
    expect(old).toMatchObject({
      stale: true,
      error: "data_model_schema_changed",
    });
    expect(old.rows[0]!.measures.total!.value).toBe("10");
    expect(
      (await f.service.previewPreparation(f.actor, parentGraph)).outputs.output!
        .rows[0]!.scaled,
    ).toBe("30");
    await f.service.publishModel(f.actor, model.id, model.version);
    const published = await f.service.query(f.actor, model.id, query);
    expect(published.stale).toBe(false);
    expect(published.rows[0]!.measures.total!.value).toBe("20");
    expect(published.provenance).toContainEqual({
      datasetId: raw.id,
      generationId: raw.generationId,
    });
  });

  it("restores after unused drift without confusing measure references with same-named source fields", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "formula",
      [field("amount", "decimal"), field("total", "string")],
      [{ id: "a", amount: "5", total: "unrelated" }],
    );
    const definition = semantic(raw.id);
    definition.measures.push({
      id: "doubled",
      name: "Doubled",
      kind: "formula",
      expression: multiply(ref("total"), literal(2)),
    });
    let model = await publishModel(f, definition);
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("total", "integer")],
      [{ id: "a", amount: "5", total: 42 }],
    );
    model = await restore(f, model);
    expect(
      (
        await f.service.previewModel(
          f.actor,
          model.definition,
          { measureIds: ["doubled"], groupBy: [] },
          { id: model.id, version: model.version },
        )
      ).rows[0]!.measures.doubled!.value,
    ).toBe("10");
    await f.service.publishModel(f.actor, model.id, model.version);
    const result = await f.service.query(f.actor, model.id, {
      measureIds: ["doubled"],
      groupBy: [],
    });
    expect(result.stale).toBe(false);
    expect(result.rows[0]!.measures.doubled!.value).toBe("10");
  });

  it("allows reloading metadata and repairing a restored definition by dropping a changed used field", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "repair",
      [field("amount", "decimal"), field("x", "decimal")],
      [{ id: "a", amount: "5", x: "1" }],
    );
    const definition = semantic(raw.id);
    definition.measures.push({
      id: "obsolete",
      name: "Obsolete",
      kind: "aggregate",
      datasetId: raw.id,
      aggregate: { id: "obsolete", name: "Obsolete", op: "sum", fieldId: "x" },
    });
    let model = await restore(f, await publishModel(f, definition));
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("x", "integer")],
      [{ id: "a", amount: "5", x: 1 }],
    );
    const reloaded = (await f.service.getModel(f.actor, model.id)).model;
    const metadata = await f.service.modelInputs(
      f.actor,
      model.id,
      reloaded.version,
    );
    expect(
      metadata.sources
        .find((source) => source.id === raw.id)!
        .fields.find((entry) => entry.id === "x")!.type,
    ).toBe("integer");
    await expectUsedDriftRejected(f, model); // The unselected obsolete measure is still declared.
    model = (
      await f.service.saveModel(
        f.actor,
        {
          name: model.name,
          definition: {
            ...model.definition,
            measures: model.definition.measures.filter(
              (measure) => measure.id !== "obsolete",
            ),
          },
          version: model.version,
        },
        model.id,
      )
    ).model;
    expect(model.restoredFromVersion).toBe(1);
    expect(
      (
        await f.service.previewModel(f.actor, model.definition, query, {
          id: model.id,
          version: model.version,
        })
      ).rows[0]!.measures.total!.value,
    ).toBe("5");
    await f.service.publishModel(f.actor, model.id, model.version);
    expect((await f.service.query(f.actor, model.id, query)).stale).toBe(false);
  });

  it("protects a transitive cast input across shared raw/prepared branches and warm caches", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "cast",
      [field("amount", "decimal"), field("x", "string")],
      [{ id: "a", amount: "5", x: "5" }],
    );
    const graph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: raw.id },
        {
          id: "output",
          type: "cast",
          input: "source",
          fieldId: "x",
          to: "decimal",
          onError: "reject",
        },
      ],
      outputs: ["output"],
    };
    const prepared = await prep(f, graph);
    const definition = semantic(raw.id);
    const preparedId = `prepared:${prepared.id}:output`;
    definition.datasets.push(preparedId);
    definition.measures.push({
      id: "cast_x",
      name: "Cast X",
      kind: "aggregate",
      datasetId: preparedId,
      aggregate: { id: "cast_x", name: "Cast X", op: "sum", fieldId: "x" },
    });
    const model = await restore(f, await publishModel(f, definition));
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("x", "integer")],
      [{ id: "a", amount: "5", x: 5 }],
    );
    const current = await f.service.previewPreparation(f.actor, graph);
    expect(
      current.outputs.output!.fields.find((entry) => entry.id === "x")!.type,
    ).toBe("decimal");
    expect(current.outputs.output!.rows[0]!.x).toBe("5");
    expect(
      (await f.service.previewModel(f.actor, model.definition, query)).rows[0]!
        .measures.total!.value,
    ).toBe("5");
    await expectUsedDriftRejected(f, model);
  });

  it("protects row-control inputs for COUNT star even when no output column uses them", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "count-control",
      [field("x", "decimal")],
      [
        { id: "a", x: "1" },
        { id: "b", x: "0" },
      ],
    );
    const graph: PreparationGraph = {
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: raw.id },
        {
          id: "filtered",
          type: "filter",
          input: "source",
          expression: { kind: "call", fn: "gt", args: [ref("x"), literal(0)] },
        },
        { id: "output", type: "select", input: "filtered", fields: ["id"] },
      ],
      outputs: ["output"],
    };
    const prepared = await prep(f, graph);
    const datasetId = `prepared:${prepared.id}:output`;
    const definition: SemanticModelDefinition = {
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions: [],
      measures: [
        {
          id: "total",
          name: "Count",
          kind: "aggregate",
          datasetId,
          aggregate: { id: "total", name: "Count", op: "count" },
        },
      ],
    };
    const model = await restore(f, await publishModel(f, definition));
    await replace(
      f,
      raw,
      [field("x", "integer")],
      [
        { id: "a", x: 1 },
        { id: "b", x: 0 },
      ],
    );
    expect(
      (
        await f.service.previewPreparation(f.actor, graph)
      ).outputs.output!.fields.map((entry) => entry.id),
    ).toEqual(["id"]);
    expect(
      (await f.service.previewModel(f.actor, model.definition, query)).rows[0]!
        .measures.total!.value,
    ).toBe(1);
    await expectUsedDriftRejected(f, model);
  });

  it("adopts an added field as an actual-schema baseline and protects it after publication", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "new-field",
      [field("amount", "decimal")],
      [{ id: "a", amount: "5" }],
    );
    let model = await restore(f, await publishModel(f, semantic(raw.id)));
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("bonus", "decimal")],
      [{ id: "a", amount: "5", bonus: "2" }],
    );
    model = (
      await f.service.saveModel(
        f.actor,
        {
          name: model.name,
          version: model.version,
          definition: {
            ...model.definition,
            measures: [
              ...model.definition.measures,
              {
                id: "bonus",
                name: "Bonus",
                kind: "aggregate",
                datasetId: raw.id,
                aggregate: {
                  id: "bonus",
                  name: "Bonus",
                  op: "sum",
                  fieldId: "bonus",
                },
              },
            ],
          },
        },
        model.id,
      )
    ).model;
    const selection = { measureIds: ["total", "bonus"], groupBy: [] };
    expect(
      (
        await f.service.previewModel(f.actor, model.definition, selection, {
          id: model.id,
          version: model.version,
        })
      ).rows[0]!.measures.bonus!.value,
    ).toBe("2");
    const published = (
      await f.service.publishModel(f.actor, model.id, model.version)
    ).model;
    expect(
      (await f.service.query(f.actor, model.id, selection)).rows[0]!.measures
        .bonus!.value,
    ).toBe("2");
    model = (
      await f.service.restoreModel(f.actor, model.id, {
        version: published.version,
        publishedVersion: published.version,
      })
    ).model;
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("bonus", "integer")],
      [{ id: "a", amount: "5", bonus: 2 }],
    );
    await expect(
      f.service.previewModel(f.actor, model.definition, selection, {
        id: model.id,
        version: model.version,
      }),
    ).rejects.toThrow("data_model_schema_changed");
    await expect(
      f.service.publishModel(f.actor, model.id, model.version),
    ).rejects.toThrow("data_model_schema_changed");
    expect(
      (await f.service.getModel(f.actor, model.id)).model.publishedVersion,
    ).toBe(published.version);
  });

  it("protects both relationship keys when a supported rebuild changes them to the same new type", async () => {
    const f = await fixture();
    const fact = await enter(
      f,
      "facts",
      [field("amount", "decimal"), field("match", "string")],
      [{ id: "a", amount: "5", match: "1" }],
    );
    const dimension = await enter(
      f,
      "dimension",
      [field("match", "string")],
      [{ id: "one", match: "1" }],
    );
    const definition = semantic(fact.id);
    definition.datasets.push(dimension.id);
    definition.relationships.push({
      id: "dimension",
      from: { datasetId: fact.id, fieldId: "match" },
      to: { datasetId: dimension.id, fieldId: "match" },
      cardinality: "many_to_one",
    });
    const model = await restore(f, await publishModel(f, definition));
    await replace(
      f,
      fact,
      [field("amount", "decimal"), field("match", "integer")],
      [{ id: "a", amount: "5", match: 1 }],
    );
    await replace(
      f,
      dimension,
      [field("match", "integer")],
      [{ id: "one", match: 1 }],
    );
    expect(
      (await f.service.previewModel(f.actor, model.definition, query)).rows[0]!
        .measures.total!.value,
    ).toBe("5");
    await expectUsedDriftRejected(f, model);
  });

  it("protects fields used only by an aggregate filter", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "filtered",
      [field("amount", "decimal"), field("x", "decimal")],
      [{ id: "a", amount: "5", x: "1" }],
    );
    const definition = semantic(raw.id);
    const measure = definition.measures[0]!;
    if (measure.kind !== "aggregate")
      throw new Error("Aggregate fixture required");
    measure.aggregate.filter = {
      kind: "call",
      fn: "gt",
      args: [ref("x"), literal(0)],
    };
    const model = await restore(f, await publishModel(f, definition));
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("x", "integer")],
      [{ id: "a", amount: "5", x: 1 }],
    );
    expect(
      (await f.service.previewModel(f.actor, model.definition, query)).rows[0]!
        .measures.total!.value,
    ).toBe("5");
    await expectUsedDriftRejected(f, model);
  });

  it("protects declared LAST ordering even when a query only requests another measure", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "last",
      [field("amount", "decimal"), field("at", "date")],
      [{ id: "a", amount: "5", at: "2026-11-01" }],
    );
    const definition = semantic(raw.id);
    definition.measures.push({
      id: "latest",
      name: "Latest",
      kind: "aggregate",
      datasetId: raw.id,
      aggregate: {
        id: "latest",
        name: "Latest",
        op: "last",
        fieldId: "amount",
        orderBy: "at",
      },
    });
    const model = await restore(f, await publishModel(f, definition));
    await replace(
      f,
      raw,
      [field("amount", "decimal"), field("at", "timestamp")],
      [{ id: "a", amount: "5", at: "2026-11-01T00:00:00Z" }],
    );
    expect(
      (
        await f.service.previewModel(f.actor, model.definition, {
          measureIds: ["latest"],
          groupBy: [],
        })
      ).rows[0]!.measures.latest!.value,
    ).toBe("5");
    await expectUsedDriftRejected(f, model);
  });

  it("protects dimension display-name fields even when their values remain valid strings", async () => {
    const f = await fixture();
    const raw = await enter(
      f,
      "labels",
      [field("amount", "decimal"), field("label", "string")],
      [{ id: "a", amount: "5", label: "Alpha" }],
    );
    const definition = semantic(raw.id);
    definition.dimensions.push({
      id: "item",
      name: "Item",
      datasetId: raw.id,
      fieldId: "id",
      labelFieldId: "label",
    });
    const model = await restore(f, await publishModel(f, definition));
    await replace(
      f,
      raw,
      [
        field("amount", "decimal"),
        field("label", "string", { unit: "caption" }),
      ],
      [{ id: "a", amount: "5", label: "Alpha" }],
    );
    expect(
      (
        await f.service.previewModel(f.actor, model.definition, {
          ...query,
          groupBy: ["item"],
        })
      ).rows[0]!.dimensionLabels!.item,
    ).toBe("Alpha");
    await expectUsedDriftRejected(f, model);
  });

  it.each(["currency field binding", "currency companion metadata"] as const)(
    "protects %s on exact monetary measures",
    async (change) => {
      const f = await fixture();
      const amount = field("amount", "decimal", {
        unit: "currency",
        currencyField: "currency",
      });
      const raw = await enter(
        f,
        "money",
        [
          amount,
          field("currency", "string"),
          field("other_currency", "string"),
        ],
        [{ id: "a", amount: "5", currency: "EUR", other_currency: "EUR" }],
      );
      const model = await restore(f, await publishModel(f, semantic(raw.id)));
      const fields =
        change === "currency field binding"
          ? [
              { ...amount, currencyField: "other_currency" },
              field("currency", "string"),
              field("other_currency", "string"),
            ]
          : [
              amount,
              field("currency", "string", { unit: "iso4217" }),
              field("other_currency", "string"),
            ];
      await replace(f, raw, fields, [
        { id: "a", amount: "5", currency: "EUR", other_currency: "EUR" },
      ]);
      expect(
        (await f.service.previewModel(f.actor, model.definition, query))
          .rows[0]!.measures.total,
      ).toMatchObject({ value: "5", currency: "EUR" });
      await expectUsedDriftRejected(f, model);
    },
  );
  it.each(["anchor date", "base measure field"] as const)(
    "protects the %s of a restored rolling measure",
    async (change) => {
      const f = await fixture();
      const raw = await enter(
        f,
        "windowed",
        [field("amount", "decimal"), field("day", "date")],
        [{ id: "a", amount: "5", day: "2026-11-01" }],
      );
      const definition = semantic(raw.id);
      definition.dimensions.push({
        id: "day",
        name: "Day",
        datasetId: raw.id,
        fieldId: "day",
        timeAlignment: "reporting_date",
      });
      definition.measures.push({
        id: "total_7d",
        name: "Total, 7 days",
        kind: "rolling",
        baseMeasureId: "total",
        timeDimensionId: "day",
        window: { unit: "day", length: 7 },
      });
      const model = await restore(f, await publishModel(f, definition));
      await replace(
        f,
        raw,
        change === "anchor date"
          ? [field("amount", "decimal"), field("day", "timestamp")]
          : [field("amount", "integer"), field("day", "date")],
        [
          change === "anchor date"
            ? { id: "a", amount: "5", day: "2026-11-01T00:00:00Z" }
            : { id: "a", amount: 5, day: "2026-11-01" },
        ],
      );
      await expectUsedDriftRejected(f, model);
      await expect(
        f.service.query(f.actor, model.id, {
          measureIds: ["total_7d"],
          groupBy: ["day"],
        }),
      ).rejects.toThrow("data_model_schema_changed");
    },
  );
});
