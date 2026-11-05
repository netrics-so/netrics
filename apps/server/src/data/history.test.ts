import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";
import { sourceDatasetSchema } from "@netrics/contracts";
import type {
  PreparationGraph,
  SemanticModelDefinition,
} from "@netrics/domain";
import { createTestDatabase } from "../test-db.js";
import { createDataService, type DataActor } from "./service.js";

const NOW = new Date("2026-11-05T12:00:00Z");
let db: Database, admin: Sql, actor: DataActor, other: DataActor;
let legacyPreparation: string, legacyModel: string;
let service: ReturnType<typeof createDataService>;
const definition = (key: string, retentionDays: number | null = null) =>
  sourceDatasetSchema.parse({
    key,
    name: key,
    version: 1,
    mode: "snapshot",
    grain: "One row",
    keyFields: ["id"],
    retentionDays,
    fields: [
      {
        id: "id",
        name: "ID",
        type: "string",
        nullable: false,
        classification: "internal",
      },
      {
        id: "amount",
        name: "Amount",
        type: "decimal",
        nullable: false,
        classification: "internal",
      },
    ],
  });
const graph = (source: string, factor = "1"): PreparationGraph => ({
  version: 1,
  nodes: [
    { id: "source", type: "source", datasetId: source },
    {
      id: "output",
      type: "calculate",
      input: "source",
      fieldId: source.startsWith("prepared:") ? "scaled_again" : "scaled",
      name: "Scaled",
      expression: {
        kind: "call",
        fn: "multiply",
        args: [
          {
            kind: "field",
            fieldId: source.startsWith("prepared:") ? "scaled" : "amount",
          },
          { kind: "literal", type: "decimal", value: factor },
        ],
      },
    },
  ],
  outputs: ["output"],
});
const modelDefinition = (
  source: string,
  fieldId = "scaled",
): SemanticModelDefinition => ({
  version: 1,
  datasets: [source],
  relationships: [],
  dimensions: [],
  measures: [
    {
      id: "total",
      name: "Total",
      kind: "aggregate",
      datasetId: source,
      aggregate: { id: "total", name: "Total", op: "sum", fieldId },
    },
  ],
});
const query = { measureIds: ["total"], groupBy: [] };

beforeAll(async () => {
  const test = await createTestDatabase({
    upTo: "0058_connector_report_staging",
  });
  admin = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] =
    await admin`insert into users(email,display_name) values ('history@example.com','Owner') returning id`;
  const [a, b] =
    await admin`insert into workspaces(name) values ('History A'),('History B') returning id`;
  actor = { workspaceId: a!.id as string, callerId: user!.id as string };
  other = { workspaceId: b!.id as string, callerId: user!.id as string };
  const legacyGraph = graph("legacy-source");
  const [prep] =
    await admin`insert into data_preparations(workspace_id,name,graph) values (${actor.workspaceId},'Legacy preparation',${JSON.stringify(legacyGraph)}::jsonb) returning id`;
  legacyPreparation = prep!.id as string;
  await admin`insert into data_preparation_versions(preparation_id,workspace_id,version,graph,output_schemas,dependencies) values (${legacyPreparation},${actor.workspaceId},1,${JSON.stringify(legacyGraph)}::jsonb,'{}','{"prepared":{}}')`;
  await admin`update data_preparations set published_version=1 where id=${legacyPreparation}`;
  const legacyDefinition = modelDefinition(
    "prepared:" + legacyPreparation + ":output",
  );
  const [model] =
    await admin`insert into data_models(workspace_id,name,definition) values (${actor.workspaceId},'Legacy model',${JSON.stringify(legacyDefinition)}::jsonb) returning id`;
  legacyModel = model!.id as string;
  await admin`insert into data_model_releases(model_id,workspace_id,version,definition,dependencies,schema_bindings) values (${legacyModel},${actor.workspaceId},1,${JSON.stringify(legacyDefinition)}::jsonb,'{"prepared":{}}','{}')`;
  await admin`update data_models set published_version=1 where id=${legacyModel}`;
  await test.migrate();
  db = createDatabase(test.appUrl);
  service = createDataService(db, () => NOW);
}, 60000);
afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await db?.$client.end({ timeout: 5 });
});

describe("published definition history", () => {
  it("migrates populated previous-shape drafts and publications without changing their identity", async () => {
    expect(
      (await service.getPreparation(actor, legacyPreparation)).preparation,
    ).toMatchObject({
      version: 1,
      publishedVersion: 1,
      restoredFromVersion: null,
    });
    expect((await service.getModel(actor, legacyModel)).model).toMatchObject({
      version: 1,
      publishedVersion: 1,
      restoredFromVersion: null,
    });
    expect(
      (
        await service.preparationHistory(actor, legacyPreparation, {
          limit: 20,
        })
      ).versions,
    ).toMatchObject([{ version: 1, active: true }]);
    expect(
      (await service.modelHistory(actor, legacyModel, { limit: 20 })).versions,
    ).toMatchObject([{ version: 1, active: true }]);
  });

  it("restores nested preparation/model pins as new drafts, then adopts latest inputs only explicitly", async () => {
    const sourceDefinition = definition("history-numbers");
    const source = await service.saveManual(actor, {
      definition: sourceDefinition,
      records: [{ values: { id: "a", amount: "1" } }],
    });
    let base = (
      await service.savePreparation(actor, {
        name: "Base",
        graph: graph(source.datasetId, "2"),
      })
    ).preparation;
    await service.publishPreparation(actor, base.id, base.version);
    const parentGraph = graph(`prepared:${base.id}:output`, "3");
    let parent = (
      await service.savePreparation(actor, {
        name: "Parent",
        graph: parentGraph,
      })
    ).preparation;
    await service.publishPreparation(actor, parent.id, parent.version);
    const semantic = modelDefinition(
      `prepared:${parent.id}:output`,
      "scaled_again",
    );
    let model = (
      await service.saveModel(actor, { name: "Model", definition: semantic })
    ).model;
    await service.publishModel(actor, model.id, model.version);
    const result = async () =>
      (await service.query(actor, model.id, query)).rows[0]!.measures.total!
        .value;
    expect(await result()).toBe("6");

    base = (
      await service.savePreparation(
        actor,
        {
          name: base.name,
          graph: graph(source.datasetId, "4"),
          version: base.version,
        },
        base.id,
      )
    ).preparation;
    await service.publishPreparation(actor, base.id, base.version);
    parent = (
      await service.savePreparation(
        actor,
        {
          name: "Current parent name",
          graph: parentGraph,
          version: parent.version,
        },
        parent.id,
      )
    ).preparation;
    await service.publishPreparation(actor, parent.id, parent.version);
    model = (
      await service.saveModel(
        actor,
        {
          name: "Current model name",
          definition: semantic,
          version: model.version,
        },
        model.id,
      )
    ).model;
    await service.publishModel(actor, model.id, model.version);
    expect(await result()).toBe("12");

    const history = await service.modelHistory(actor, model.id, { limit: 1 });
    expect(history).toMatchObject({
      versions: [{ version: 2, active: true }],
      nextBeforeVersion: 2,
    });
    expect(
      await service.modelHistory(actor, model.id, {
        limit: 1,
        beforeVersion: 2,
      }),
    ).toMatchObject({
      versions: [{ version: 1, active: false }],
      nextBeforeVersion: null,
    });
    expect(
      await service.preparationHistory(actor, parent.id, { limit: 1 }),
    ).toMatchObject({
      versions: [{ version: 2, active: true }],
      nextBeforeVersion: 2,
    });

    parent = (
      await service.restorePreparation(actor, parent.id, {
        version: parent.version,
        publishedVersion: 1,
      })
    ).preparation;
    expect(parent).toMatchObject({
      name: "Current parent name",
      version: 3,
      publishedVersion: 2,
      restoredFromVersion: 1,
    });
    const preview = await service.previewPreparation(actor, parent.graph, {
      id: parent.id,
      version: parent.version,
    });
    expect(preview.outputs.output!.rows[0]!.scaled_again).toBe("6");
    expect(await result()).toBe("12");
    await service.publishPreparation(actor, parent.id, parent.version);

    model = (
      await service.restoreModel(actor, model.id, {
        version: model.version,
        publishedVersion: 1,
      })
    ).model;
    expect(model).toMatchObject({
      name: "Current model name",
      version: 3,
      publishedVersion: 2,
      restoredFromVersion: 1,
    });
    expect(
      (
        await service.previewModel(actor, semantic, query, {
          id: model.id,
          version: model.version,
        })
      ).rows[0]!.measures.total!.value,
    ).toBe("6");
    expect(
      (await service.query(actor, model.id, query, true)).rows[0]!.measures
        .total!.value,
    ).toBe("6");
    // Saving a restored draft preserves pins, even if a client reloads before publication.
    model = (
      await service.saveModel(
        actor,
        { name: model.name, definition: semantic, version: model.version },
        model.id,
      )
    ).model;
    expect(model.restoredFromVersion).toBe(1);
    expect(await result()).toBe("12");
    await service.publishModel(actor, model.id, model.version);
    expect(await result()).toBe("6");

    await service.saveManual(
      actor,
      {
        definition: sourceDefinition,
        generationId: source.generationId,
        records: [{ values: { id: "a", amount: "3" } }],
      },
      source.datasetId,
    );
    expect(await result()).toBe("18"); // Definition rollback never resurrects old source values.
    parent = (
      await service.savePreparation(
        actor,
        {
          name: parent.name,
          graph: parentGraph,
          version: parent.version,
          adoptLatestInputs: true,
        },
        parent.id,
      )
    ).preparation;
    expect(parent.restoredFromVersion).toBeNull();
    await service.publishPreparation(actor, parent.id, parent.version);
    expect(await result()).toBe("18");
    model = (
      await service.saveModel(
        actor,
        {
          name: model.name,
          definition: semantic,
          version: model.version,
          adoptLatestInputs: true,
        },
        model.id,
      )
    ).model;
    expect(model.restoredFromVersion).toBeNull();
    expect(
      (
        await service.previewModel(actor, semantic, query, {
          id: model.id,
          version: model.version,
        })
      ).rows[0]!.measures.total!.value,
    ).toBe("36");
    await service.publishModel(actor, model.id, model.version);
    expect(await result()).toBe("36");

    const events =
      await admin`select action,metadata from audit_events where workspace_id=${actor.workspaceId} and target=${model.id} and action='data.model_restored'`;
    expect(events).toMatchObject([
      {
        action: "data.model_restored",
        metadata: { fromVersion: 1, draftVersion: 3 },
      },
    ]);
  });

  it("rejects foreign publications, stale draft versions, removed and expired inputs atomically", async () => {
    const source = await service.saveManual(actor, {
      definition: definition("history-expiry", 1),
      records: [{ values: { id: "a", amount: "1" } }],
    });
    const prep = (
      await service.savePreparation(actor, {
        name: "Expiry",
        graph: graph(source.datasetId),
      })
    ).preparation;
    await service.publishPreparation(actor, prep.id, prep.version);
    const semantic = modelDefinition(`prepared:${prep.id}:output`);
    const model = (
      await service.saveModel(actor, { name: "Expiry", definition: semantic })
    ).model;
    await service.publishModel(actor, model.id, model.version);
    for (const operation of [
      () => service.preparationHistory(other, prep.id, { limit: 20 }),
      () => service.modelHistory(other, model.id, { limit: 20 }),
      () =>
        service.restorePreparation(other, prep.id, {
          version: 1,
          publishedVersion: 1,
        }),
      () =>
        service.restoreModel(other, model.id, {
          version: 1,
          publishedVersion: 1,
        }),
    ])
      await expect(operation()).rejects.toMatchObject({ status: 404 });
    await expect(
      service.restorePreparation(actor, prep.id, {
        version: 99,
        publishedVersion: 1,
      }),
    ).rejects.toThrow("version_conflict");
    await expect(
      service.restoreModel(actor, model.id, {
        version: 99,
        publishedVersion: 1,
      }),
    ).rejects.toThrow("version_conflict");
    await expect(
      service.restoreModel(actor, model.id, {
        version: 1,
        publishedVersion: 99,
      }),
    ).rejects.toThrow("data_publication_not_found");
    const expired = createDataService(
      db,
      () => new Date(NOW.getTime() + 2 * 86400000),
    );
    await expect(
      expired.restorePreparation(actor, prep.id, {
        version: 1,
        publishedVersion: 1,
      }),
    ).rejects.toThrow("data_source_expired");
    await expect(
      expired.restoreModel(actor, model.id, {
        version: 1,
        publishedVersion: 1,
      }),
    ).rejects.toThrow("data_source_expired");
    // A failed publication does not replace the active release, even after a restore.
    const restoredPrep = (
      await service.restorePreparation(actor, prep.id, {
        version: 1,
        publishedVersion: 1,
      })
    ).preparation;
    const restored = (
      await service.restoreModel(actor, model.id, {
        version: 1,
        publishedVersion: 1,
      })
    ).model;
    await expect(
      expired.publishPreparation(actor, prep.id, restoredPrep.version),
    ).rejects.toThrow("data_source_expired");
    await expect(
      expired.publishModel(actor, model.id, restored.version),
    ).rejects.toThrow("data_source_expired");
    await admin`delete from data_datasets where id=${source.datasetId}`;
    await expect(
      service.publishPreparation(actor, prep.id, restoredPrep.version),
    ).rejects.toThrow("data_source_not_found");
    await expect(
      service.publishModel(actor, model.id, restored.version),
    ).rejects.toThrow("data_source_not_found");
    await expect(
      service.restorePreparation(actor, prep.id, {
        version: restoredPrep.version,
        publishedVersion: 1,
      }),
    ).rejects.toThrow("data_source_not_found");
    await expect(
      service.restoreModel(actor, model.id, {
        version: restored.version,
        publishedVersion: 1,
      }),
    ).rejects.toThrow("data_source_not_found");
    expect(
      (await service.getPreparation(actor, prep.id)).preparation,
    ).toMatchObject({
      version: restoredPrep.version,
      publishedVersion: 1,
      restoredFromVersion: 1,
    });
    expect((await service.getModel(actor, model.id)).model).toMatchObject({
      version: restored.version,
      publishedVersion: 1,
      restoredFromVersion: 1,
    });
  });
});
