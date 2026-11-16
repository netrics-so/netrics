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
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
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
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
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
    const nestedInputs = await service.modelInputs(
      actor,
      model.id,
      model.version,
    );
    expect(nestedInputs.sources.map((input) => input.id)).toContain(
      `prepared:${base.id}:output`,
    );
    expect(nestedInputs.sources.map((input) => input.id)).toContain(
      `prepared:${parent.id}:output`,
    );

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

  it("tells whether a draft differs from its live release by content, not version (#697)", async () => {
    const source = await service.saveManual(actor, {
      definition: definition("unpublished-numbers"),
      records: [{ values: { id: "a", amount: "1" } }],
    });
    const listed = async (id: string) =>
      (await service.listPreparations(actor)).preparations.find(
        (p) => p.id === id,
      )!.hasUnpublishedChanges;
    const g1 = graph(source.datasetId, "2"),
      g2 = graph(source.datasetId, "5");
    let prep = (
      await service.savePreparation(actor, { name: "Marked", graph: g1 })
    ).preparation;
    // Never published: nothing to differ from.
    expect(prep.hasUnpublishedChanges).toBe(false);
    prep = (await service.publishPreparation(actor, prep.id, prep.version))
      .preparation;
    expect(prep.hasUnpublishedChanges).toBe(false);
    const save = async (
      input: { name?: string; graph: PreparationGraph; adopt?: boolean },
      expected: boolean,
    ) => {
      prep = (
        await service.savePreparation(
          actor,
          {
            name: input.name ?? prep.name,
            graph: input.graph,
            version: prep.version,
            ...(input.adopt ? { adoptLatestInputs: true } : {}),
          },
          prep.id,
        )
      ).preparation;
      expect(prep.hasUnpublishedChanges).toBe(expected);
      expect(await listed(prep.id)).toBe(expected);
      expect(
        (await service.getPreparation(actor, prep.id)).preparation
          .hasUnpublishedChanges,
      ).toBe(expected);
    };
    // A rename is not part of a release; the version still moves.
    await save({ name: "Renamed", graph: g1 }, false);
    expect(prep).toMatchObject({ version: 2, publishedVersion: 1 });
    await save({ graph: g2 }, true);
    // Saved back to the released graph.
    await save({ graph: g1 }, false);
    // Restoring the live release reads its inputs: equal.
    prep = (
      await service.restorePreparation(actor, prep.id, {
        version: prep.version,
        publishedVersion: 1,
      })
    ).preparation;
    expect(prep).toMatchObject({ restoredFromVersion: 1 });
    expect(prep.hasUnpublishedChanges).toBe(false);
    // Published while restored: the release keeps reading v1's inputs.
    await save({ graph: g2 }, true);
    prep = (await service.publishPreparation(actor, prep.id, prep.version))
      .preparation;
    expect(prep.hasUnpublishedChanges).toBe(false);
    await save({ name: "Renamed again", graph: g2 }, false);
    // Its only input is a source, which no release pins: the latest inputs
    // are the same.
    await save({ graph: g2, adopt: true }, false);

    // A model reading the preparation pins its published version.
    const semantic = modelDefinition(`prepared:${prep.id}:output`);
    let model = (
      await service.saveModel(actor, {
        name: "Marked model",
        definition: semantic,
      })
    ).model;
    model = (await service.publishModel(actor, model.id, model.version)).model;
    const modelMark = async () => {
      const listedModel = (await service.listModels(actor)).models.find(
        (m) => m.id === model.id,
      )!;
      const got = (await service.getModel(actor, model.id)).model;
      expect(got.hasUnpublishedChanges).toBe(listedModel.hasUnpublishedChanges);
      return listedModel.hasUnpublishedChanges;
    };
    const saveModel = async (
      definition: SemanticModelDefinition,
      expected: boolean,
      adoptLatestInputs = false,
    ) => {
      model = (
        await service.saveModel(
          actor,
          {
            name: "Renamed model",
            definition,
            version: model.version,
            ...(adoptLatestInputs ? { adoptLatestInputs } : {}),
          },
          model.id,
        )
      ).model;
      expect(model.hasUnpublishedChanges).toBe(expected);
      expect(await modelMark()).toBe(expected);
    };
    expect(model.hasUnpublishedChanges).toBe(false);
    await saveModel(semantic, false);
    const changed = modelDefinition(`prepared:${prep.id}:output`);
    changed.measures[0]!.name = "Grand total";
    await saveModel(changed, true);
    await saveModel(semantic, false);
    expect(model).toMatchObject({ version: 4, publishedVersion: 1 });

    // The preparation it reads is published again: the live release still
    // reads the old version, so the model has unpublished changes, before
    // and after a save that changes nothing (publishing would pin the new
    // version).
    prep = (await service.publishPreparation(actor, prep.id, prep.version))
      .preparation;
    expect(await modelMark()).toBe(true);
    await saveModel(semantic, true);
    // Restored from its release, it reads that release's pins again.
    model = (
      await service.restoreModel(actor, model.id, {
        version: model.version,
        publishedVersion: 1,
      })
    ).model;
    expect(model.hasUnpublishedChanges).toBe(false);
    await saveModel(semantic, false);
    await saveModel(semantic, true, true);
    // Published on the latest inputs: equal again.
    model = (await service.publishModel(actor, model.id, model.version)).model;
    expect(model.hasUnpublishedChanges).toBe(false);
    await saveModel(semantic, false);
  });

  it("publishes a published preparation again with the current versions of its inputs, and changes nothing when they are current", async () => {
    const source = await service.saveManual(actor, {
      definition: definition("refresh-numbers"),
      records: [{ values: { id: "a", amount: "1" } }],
    });
    let base = (
      await service.savePreparation(actor, {
        name: "Refresh base",
        graph: graph(source.datasetId, "2"),
      })
    ).preparation;
    await service.publishPreparation(actor, base.id, base.version);
    let parent = (
      await service.savePreparation(actor, {
        name: "Refresh parent",
        graph: graph(`prepared:${base.id}:output`, "3"),
      })
    ).preparation;
    parent = (await service.publishPreparation(actor, parent.id, 1))
      .preparation;
    // Nothing read by the parent moved: publishing again changes nothing.
    expect(
      (await service.publishPreparation(actor, parent.id, 1)).preparation,
    ).toMatchObject({ version: 1, publishedVersion: 1 });

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
    const semantic = modelDefinition(
      `prepared:${parent.id}:output`,
      "scaled_again",
    );
    const model = (
      await service.saveModel(actor, { name: "Refresh", definition: semantic })
    ).model;
    const total = async () =>
      (
        await service.previewModel(actor, semantic, query, {
          id: model.id,
          version: model.version,
        })
      ).rows[0]!.measures.total!.value;
    // The parent still reads the base version it was published with.
    expect(await total()).toBe("6");
    // Publishing it again reads base version 2, as a new parent version.
    const republished = (await service.publishPreparation(actor, parent.id, 1))
      .preparation;
    expect(republished).toMatchObject({ version: 2, publishedVersion: 2 });
    expect(await total()).toBe("12");
    expect(
      (await service.preparationHistory(actor, parent.id, { limit: 5 }))
        .versions,
    ).toMatchObject([
      { version: 2, active: true },
      { version: 1, active: false },
    ]);
    // A stale version number still conflicts.
    await expect(
      service.publishPreparation(actor, parent.id, 1),
    ).rejects.toThrow("version_conflict");
  });

  it("publishes a published model again with the current versions of the preparations it reads, and changes nothing when they are current", async () => {
    const source = await service.saveManual(actor, {
      definition: definition("refresh-model-numbers"),
      records: [{ values: { id: "a", amount: "1" } }],
    });
    let base = (
      await service.savePreparation(actor, {
        name: "Model refresh base",
        graph: graph(source.datasetId, "2"),
      })
    ).preparation;
    await service.publishPreparation(actor, base.id, base.version);
    const semantic = modelDefinition(`prepared:${base.id}:output`);
    let model = (
      await service.saveModel(actor, {
        name: "Model refresh",
        definition: semantic,
      })
    ).model;
    model = (await service.publishModel(actor, model.id, model.version)).model;
    const total = async () =>
      (await service.query(actor, model.id, query)).rows[0]!.measures.total!
        .value;
    expect(await total()).toBe("2");
    // Nothing it reads moved: publishing again changes nothing.
    expect(
      (await service.publishModel(actor, model.id, 1)).model,
    ).toMatchObject({ version: 1, publishedVersion: 1 });

    base = (
      await service.savePreparation(
        actor,
        {
          name: base.name,
          graph: graph(source.datasetId, "5"),
          version: base.version,
        },
        base.id,
      )
    ).preparation;
    await service.publishPreparation(actor, base.id, base.version);
    // The release still reads the base version it was published with.
    expect(await total()).toBe("2");
    expect(
      (await service.publishModel(actor, model.id, 1)).model,
    ).toMatchObject({ version: 2, publishedVersion: 2 });
    expect(await total()).toBe("5");
    await expect(service.publishModel(actor, model.id, 1)).rejects.toThrow(
      "version_conflict",
    );
    // A restored release keeps its inputs: publishing it again changes nothing.
    const restored = (
      await service.restoreModel(actor, model.id, {
        version: 2,
        publishedVersion: 1,
      })
    ).model;
    const published = (
      await service.publishModel(actor, model.id, restored.version)
    ).model;
    expect(
      (await service.publishModel(actor, model.id, published.version)).model,
    ).toMatchObject({ version: published.version });
    expect(await total()).toBe("2");
  });

  it("reloads historical field and removed output identities for restored model and preparation editors", async () => {
    const source = await service.saveManual(actor, {
      definition: definition("history-fields"),
      records: [{ values: { id: "a", amount: "5" } }],
    });
    const shaped = (prefix: string, output = "output"): PreparationGraph => ({
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: source.datasetId },
        {
          id: "amount",
          type: "calculate",
          input: "source",
          fieldId: prefix + "_amount",
          name: prefix + " amount",
          expression: { kind: "field", fieldId: "amount" },
        },
        {
          id: output,
          type: "calculate",
          input: "amount",
          fieldId: prefix + "_group",
          name: prefix + " group",
          expression: { kind: "field", fieldId: "id" },
        },
      ],
      outputs: [output],
    });
    let input = (
      await service.savePreparation(actor, {
        name: "Changing fields",
        graph: shaped("old"),
      })
    ).preparation;
    await service.publishPreparation(actor, input.id, input.version);
    const sourceId = `prepared:${input.id}:output`;
    const semantic = (
      datasetId: string,
      prefix: string,
    ): SemanticModelDefinition => ({
      version: 1,
      datasets: [datasetId],
      relationships: [],
      dimensions: [
        { id: "group", name: "Group", datasetId, fieldId: prefix + "_group" },
      ],
      measures: [
        {
          id: "total",
          name: "Total",
          kind: "aggregate",
          datasetId,
          aggregate: {
            id: "total",
            name: "Total",
            op: "sum",
            fieldId: prefix + "_amount",
          },
        },
      ],
    });
    let model = (
      await service.saveModel(actor, {
        name: "Historical fields",
        definition: semantic(sourceId, "old"),
      })
    ).model;
    await service.publishModel(actor, model.id, model.version);
    const select = (prefix: string): PreparationGraph => ({
      version: 1,
      nodes: [
        { id: "source", type: "source", datasetId: sourceId },
        {
          id: "selected",
          type: "select",
          input: "source",
          fields: [prefix + "_amount", prefix + "_group"],
        },
      ],
      outputs: ["selected"],
    });
    let parent = (
      await service.savePreparation(actor, {
        name: "Historical input",
        graph: select("old"),
      })
    ).preparation;
    await service.publishPreparation(actor, parent.id, parent.version);

    input = (
      await service.savePreparation(
        actor,
        { name: input.name, graph: shaped("new"), version: input.version },
        input.id,
      )
    ).preparation;
    await service.publishPreparation(actor, input.id, input.version);
    parent = (
      await service.savePreparation(
        actor,
        { name: parent.name, graph: select("new"), version: parent.version },
        parent.id,
      )
    ).preparation;
    await service.publishPreparation(actor, parent.id, parent.version);
    model = (
      await service.saveModel(
        actor,
        {
          name: model.name,
          definition: semantic(sourceId, "new"),
          version: model.version,
        },
        model.id,
      )
    ).model;
    await service.publishModel(actor, model.id, model.version);
    expect(
      (await service.listSources(actor)).sources
        .find((item) => item.id === sourceId)!
        .fields.map((field) => field.id),
    ).not.toContain("old_amount");

    model = (
      await service.restoreModel(actor, model.id, {
        version: model.version,
        publishedVersion: 1,
      })
    ).model;
    parent = (
      await service.restorePreparation(actor, parent.id, {
        version: parent.version,
        publishedVersion: 1,
      })
    ).preparation;
    // A fresh editor obtains metadata from persisted draft pins, never from stale client state.
    const reloadedModel = (await service.getModel(actor, model.id)).model;
    const reloadedParent = (await service.getPreparation(actor, parent.id))
      .preparation;
    for (const metadata of [
      await service.modelInputs(actor, model.id, reloadedModel.version),
      await service.preparationInputs(actor, parent.id, reloadedParent.version),
    ]) {
      expect(metadata.sources.find((entry) => entry.id === sourceId)!.id).toBe(
        sourceId,
      );
      expect(
        metadata.sources
          .find((entry) => entry.id === sourceId)!
          .fields.map((field) => field.id),
      ).toContain("old_amount");
      expect(
        metadata.sources
          .find((entry) => entry.id === sourceId)!
          .fields.map((field) => field.id),
      ).toContain("old_group");
      expect(
        metadata.sources
          .find((entry) => entry.id === sourceId)!
          .fields.map((field) => field.id),
      ).not.toContain("new_amount");
    }
    expect(
      (
        await service.preview(actor, sourceId, 100, {
          id: parent.id,
          version: parent.version,
        })
      ).fields.map((field) => field.id),
    ).toContain("old_amount");
    expect(
      (await service.preview(actor, sourceId)).fields.map((field) => field.id),
    ).not.toContain("old_amount");
    const grouping = { measureIds: ["total"], groupBy: ["group"] };
    expect(
      (
        await service.previewModel(actor, model.definition, grouping, {
          id: model.id,
          version: model.version,
        })
      ).rows,
    ).toMatchObject([
      { dimensions: { group: "a" }, measures: { total: { value: "5" } } },
    ]);
    expect(
      (
        await service.previewPreparation(actor, parent.graph, {
          id: parent.id,
          version: parent.version,
        })
      ).outputs.selected!.fields.map((field) => field.id),
    ).toEqual(["old_amount", "old_group"]);

    // The historical output itself may disappear from the current public catalog.
    input = (
      await service.savePreparation(
        actor,
        {
          name: input.name,
          graph: shaped("replacement", "replacement"),
          version: input.version,
        },
        input.id,
      )
    ).preparation;
    await service.publishPreparation(actor, input.id, input.version);
    expect(
      (await service.listSources(actor)).sources.some(
        (item) => item.id === sourceId,
      ),
    ).toBe(false);
    expect(
      (await service.modelInputs(actor, model.id, model.version)).sources.find(
        (entry) => entry.id === sourceId,
      )!.id,
    ).toBe(sourceId);
    expect(
      (
        await service.preparationInputs(actor, parent.id, parent.version)
      ).sources
        .find((entry) => entry.id === sourceId)!
        .fields.map((field) => field.id),
    ).toContain("old_amount");
    await expect(
      service.modelInputs(other, model.id, model.version),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.preparationInputs(other, parent.id, parent.version),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.modelInputs(actor, model.id, model.version - 1),
    ).rejects.toThrow("version_conflict");
    await expect(
      service.preparationInputs(actor, parent.id, parent.version - 1),
    ).rejects.toThrow("version_conflict");
    await service.publishModel(actor, model.id, model.version);
    await service.publishPreparation(actor, parent.id, parent.version);
    expect(
      (await service.query(actor, model.id, grouping)).rows[0]!.measures.total!
        .value,
    ).toBe("5");
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
