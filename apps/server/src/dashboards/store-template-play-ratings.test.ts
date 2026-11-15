import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  ingestDatasetPage,
  upsertConnectionResources,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import type { PreparationGraph } from "@netrics/domain";
import { storeTemplatePlanSchema } from "@netrics/contracts";
import { createDefaultRegistry } from "../connectors.js";
import { createDataService } from "../data/service.js";
import { dashboardDimensionValues } from "./data.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { createStoreTemplateService } from "./store-template-service.js";
import { createStoreTemplateUpdateService } from "./store-template-updates.js";
import {
  // Version 2 is what this suite covers up to its last describe, which
  // covers version 3 (the current one).
  storeTemplateV2 as storeTemplate,
  storeTemplateV1,
  type StoreTemplateDefinition,
} from "./store-template.js";
import { apple as appleFixture, google, inputs, now } from "./test-helpers.js";

/**
 * Template version 2 (Play Console rating reports): an install of version 1
 * is offered the change through the template update, which adds the source
 * datasets version 2 reads to the install and changes only the Google Play
 * ratings preparation.
 */
let test: TestDatabase, db: Database, owner: Sql, userId: string;
const registry = createDefaultRegistry();
const actor = (workspaceId: string) => ({
  workspaceId,
  callerId: userId,
  locale: "en" as const,
});

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "play-ratings@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await test?.drop();
});

/** A version 1 install as it was made before version 2 existed. */
async function versionOneInstall() {
  const workspaceId = await createWorkspace(db, {
    name: "Play " + randomUUID().slice(0, 8),
    ownerUserId: userId,
  });
  const connections = [];
  for (const connectorId of ["app-store-connect", "google-play"] as const) {
    const [connection] = await withWorkspace(db, { workspaceId }, (tx) =>
      tx
        .insert(schema.connections)
        .values({
          workspaceId,
          connectorId,
          name: connectorId,
          setupPending: false,
        })
        .returning(),
    );
    connections.push(connection!);
  }
  const apple = connections[0]!,
    play = connections[1]!;
  const requestId = randomUUID();
  await createStoreTemplateService({
    db,
    registry,
    now: () => new Date(now),
    template: storeTemplateV1,
  }).install(actor(workspaceId), {
    requestId,
    name: "App portfolio",
    connections: connections.map((c) => c.id),
    groups: [],
  });
  // Version 1 installs read and registered only these datasets.
  const [install] =
    await owner`select inputs from data_template_installs where request_id=${requestId}`;
  const inputs = install!.inputs as {
    connections: { id: string; datasets: Record<string, string> }[];
  };
  for (const connection of inputs.connections) {
    delete connection.datasets.rating_rows;
    delete connection.datasets.report_status;
  }
  await owner`update data_template_installs set inputs=${owner.json(inputs as never)}
    where request_id=${requestId}`;
  await owner`delete from data_datasets where connection_id=${play.id}
    and key in ('rating_rows', 'report_status')`;
  return { workspaceId, requestId, apple, play };
}

describe(
  "store template version 2: Play Console rating reports",
  { timeout: 30_000 },
  () => {
    it("offers version 1 installs the Play ratings change and applies it with the new sources", async () => {
      const { workspaceId, requestId, apple, play } = await versionOneInstall();
      const updates = createStoreTemplateUpdateService({
        db,
        registry,
        now: () => new Date(now),
        template: storeTemplate,
      });
      expect(storeTemplate.version).toBe(2);
      const { installs } = await updates.list(actor(workspaceId));
      expect(installs[0]).toMatchObject({
        templateVersion: 1,
        latestVersion: 2,
        updateAvailable: true,
        error: null,
      });
      const plan = await updates.plan(actor(workspaceId), requestId);
      expect(storeTemplatePlanSchema.parse(plan)).toEqual(plan);
      const ratings = `preparation:source:${play.id}:ratings`;
      const changed = plan.records.filter((record) => record.items.length);
      // Only the ratings records change; nothing asks the customer.
      expect(changed.map((record) => record.key).sort()).toEqual(
        [
          `preparation:source:${apple.id}:ratings`,
          ratings,
          "model:ratings",
        ].sort(),
      );
      expect(
        changed.every((record) =>
          record.items.every((item) => item.outcome === "template"),
        ),
      ).toBe(true);
      // Reviewing registers nothing.
      expect(
        await owner`select 1 from data_datasets where connection_id=${play.id} and key='rating_rows'`,
      ).toHaveLength(0);

      const update = await updates.apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: [],
      });
      expect(update).toMatchObject({ fromVersion: 1, toVersion: 2 });
      const registered = Object.fromEntries(
        (
          await owner`select id, key from data_datasets where connection_id=${play.id}
          and key in ('rating_rows', 'report_status')`
        ).map((row) => [row.key as string, row.id as string]),
      );
      expect(Object.keys(registered).sort()).toEqual([
        "rating_rows",
        "report_status",
      ]);
      // The install now reads them, and the ratings draft is built on them.
      const [install] =
        await owner`select inputs, template_version from data_template_installs where request_id=${requestId}`;
      expect(install!.template_version).toBe(2);
      const inputs = install!.inputs as {
        connections: { id: string; datasets: Record<string, string> }[];
      };
      expect(
        inputs.connections.find((connection) => connection.id === play.id)!
          .datasets,
      ).toMatchObject(registered);
      const [record] =
        await owner`select record_id from data_template_records where request_id=${requestId} and key=${ratings}`;
      const [preparation] =
        await owner`select graph, version, published_version from data_preparations where id=${record!.record_id as string}`;
      const graph = preparation!.graph as PreparationGraph;
      expect(
        graph.nodes
          .filter((node) => node.type === "source")
          .map((node) => node.type === "source" && node.datasetId),
      ).toEqual(
        expect.arrayContaining([
          registered.rating_rows,
          registered.report_status,
        ]),
      );
      expect(JSON.stringify(graph)).not.toContain("pending:");
      // A draft: the published listing-based version stays live until published.
      expect(preparation!.version).toBeGreaterThan(
        preparation!.published_version as number,
      );
      // The update stays open until its drafts are published and the
      // dashboard copy is made, as every template update does.
      expect(
        (await updates.list(actor(workspaceId))).installs[0]!.openUpdate,
      ).toMatchObject({ id: update.id, toVersion: 2 });
    });
    it("refuses an apply whose review is stale", async () => {
      const { workspaceId, requestId } = await versionOneInstall();
      const updates = createStoreTemplateUpdateService({
        db,
        registry,
        now: () => new Date(now),
        template: storeTemplate,
      });
      await expect(
        updates.apply(actor(workspaceId), requestId, {
          basis: "0".repeat(64),
          decisions: [],
        }),
      ).rejects.toThrow("store_update_stale");
      expect(
        await owner`select 1 from data_datasets where key='rating_rows'
        and workspace_id=${workspaceId}`,
      ).toHaveLength(0);
    });
  },
);

/**
 * Synthetic reports of both stores, as their syncs deliver them after the
 * upgrade (the fixture tables of test-helpers, per connection).
 */
async function ingestReports(
  workspaceId: string,
  connections: { apple: { id: string }; play: { id: string } },
  /** App names to use instead of the fixture's, by connection and app id. */
  rename: Record<string, Record<string, string>> = {},
) {
  const fixtures = inputs();
  for (const [connection, fixture] of [
    [connections.apple, appleFixture],
    [connections.play, google],
  ] as const) {
    const manifest = registry.get(fixture.connectorId)!.manifest;
    for (const [key, fixtureId] of Object.entries(fixture.datasets)) {
      const definition = manifest.datasets!.find((d) => d.key === key)!;
      await withWorkspace(db, { workspaceId }, (tx) =>
        ingestDatasetPage(tx, {
          workspaceId,
          connectionId: connection.id,
          definition,
          page: {
            datasetKey: key,
            schemaVersion: definition.version,
            refreshKey: "first-report",
            pageKey: "page-1",
            previousPageKey: null,
            complete: true,
            ...(definition.mode === "replace_window"
              ? {
                  window: {
                    from: "2026-10-01",
                    toExclusive: "2026-11-01",
                    partition: {},
                  },
                }
              : {}),
            records: fixtures.get(fixtureId)!.rows.map((values, index) => ({
              values: {
                ...values,
                ...(Object.hasOwn(values, "row_id")
                  ? { row_id: String(index) }
                  : {}),
              },
            })),
          },
          now: new Date(now),
        }),
      );
    }
    const names = fixtures.get(`resources:${fixture.id}`)!.rows;
    await withWorkspace(db, { workspaceId }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId,
        connectionId: connection.id,
        resources: names.map((row) => ({
          id: row.resource_id as string,
          name:
            rename[connection.id]?.[row.resource_id as string] ??
            (row.name as string),
          kind: row.kind as string,
        })),
        now: new Date(now),
      }),
    );
  }
}

describe("publishing a two-store template update", { timeout: 30_000 }, () => {
  it("previews and publishes the ratings model after the drafts are published in their listed order", async () => {
    const { workspaceId, requestId, apple, play } = await versionOneInstall();
    await ingestReports(workspaceId, { apple, play });
    const updates = createStoreTemplateUpdateService({
      db,
      registry,
      now: () => new Date(now),
      template: storeTemplate,
    });
    const plan = await updates.plan(actor(workspaceId), requestId);
    const update = await updates.apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: [],
    });
    // The combined ratings preparation reads both changed sources: it gets
    // a draft too, listed after them, so publishing it reads their new
    // versions (a published preparation keeps the input versions it was
    // published with).
    const keys = update.drafts.map((draft) => draft.key);
    expect(keys.slice(0, 2).sort()).toEqual(
      [
        `preparation:source:${apple.id}:ratings`,
        `preparation:source:${play.id}:ratings`,
      ].sort(),
    );
    expect(keys.slice(2)).toEqual([
      "preparation:append:ratings:0:0",
      "model:ratings",
    ]);
    const data = createDataService(db, () => new Date(now));
    const user = { workspaceId, callerId: userId };
    for (const draft of update.drafts)
      if (draft.kind === "preparation")
        await data.publishPreparation(user, draft.recordId, draft.version);
    const modelDraft = update.drafts.find((draft) => draft.kind === "model")!;
    const { model } = await data.getModel(user, modelDraft.recordId);
    const query = {
      measureIds: ["rating", "rating_count", "availability"],
      groupBy: ["listing", "storefront"],
    };
    const rows = (result: {
      rows: Awaited<ReturnType<typeof data.previewModel>>["rows"];
    }) =>
      result.rows
        .map((row) => [
          row.dimensions.listing,
          row.dimensions.storefront,
          row.dimensionLabels?.storefront,
          row.measures.rating?.value,
          row.measures.rating_count?.value,
          row.measures.availability?.value,
        ])
        .filter((row) =>
          [`${apple.id}:a`, `${play.id}:com.example.alpha`].includes(
            row[0] as string,
          ),
        )
        .sort();
    const expected = [
      // Apple: its storefront code, rating and count.
      [`${apple.id}:a`, "US", "US", "4.5", 100, "Available"],
      // Play: the report's Total Average Rating, all countries, no count.
      [
        `${play.id}:com.example.alpha`,
        "ALL",
        "All countries",
        "4.3333",
        null,
        "Available",
      ],
    ].sort();
    expect(
      rows(
        await data.previewModel(user, model.definition, query, {
          id: model.id,
          version: model.version,
        }),
      ),
    ).toEqual(expected);
    // A draft is still unpublished: the update is open.
    expect(
      (await updates.list(actor(workspaceId))).installs[0]!.openUpdate,
    ).toMatchObject({ id: update.id });
    await data.publishModel(user, model.id, model.version);
    expect(rows(await data.query(user, model.id, query))).toEqual(expected);
    // Everything is published and the update has no dashboards: it is done,
    // so the next version's review is not hidden behind it.
    const finished = (await updates.list(actor(workspaceId))).installs[0]!;
    expect(finished.openUpdate).toBeNull();
    expect(finished.lastUpdate).toMatchObject({
      id: update.id,
      dashboards: [],
    });
    expect(finished.lastUpdate!.drafts.every((d) => d.published)).toBe(true);
    // A version that changes something (one that changes nothing is no
    // update to offer).
    const third = createStoreTemplateUpdateService({
      db,
      registry,
      now: () => new Date(now),
      template: contentOnly(false),
    });
    expect((await third.list(actor(workspaceId))).installs[0]).toMatchObject({
      updateAvailable: true,
      openUpdate: null,
    });
    const next = await third.plan(actor(workspaceId), requestId);
    expect(next).toMatchObject({ fromVersion: 2, toVersion: 3 });
  });
  it("recovers when the combined preparation was published before its inputs: publishing it again reads them", async () => {
    const { workspaceId, requestId, apple, play } = await versionOneInstall();
    await ingestReports(workspaceId, { apple, play });
    const updates = createStoreTemplateUpdateService({
      db,
      registry,
      now: () => new Date(now),
      template: storeTemplate,
    });
    const plan = await updates.plan(actor(workspaceId), requestId);
    const update = await updates.apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: [],
    });
    const data = createDataService(db, () => new Date(now));
    const user = { workspaceId, callerId: userId };
    const append = update.drafts.find(
      (draft) => draft.key === "preparation:append:ratings:0:0",
    )!;
    // Out of order (as an update applied before this fix was left): the
    // combined preparation first, still reading the sources' old versions.
    await data.publishPreparation(user, append.recordId, append.version);
    for (const draft of update.drafts)
      if (draft.kind === "preparation" && draft !== append)
        await data.publishPreparation(user, draft.recordId, draft.version);
    const { model } = await data.getModel(
      user,
      update.drafts.find((draft) => draft.kind === "model")!.recordId,
    );
    const preview = () =>
      data.previewModel(
        user,
        model.definition,
        { measureIds: ["rating"], groupBy: ["listing", "storefront"] },
        { id: model.id, version: model.version },
      );
    await expect(preview()).rejects.toThrow("model_dimension_label_invalid");
    // Publishing the combined preparation again reads the new sources.
    const { preparation } = await data.getPreparation(user, append.recordId);
    await data.publishPreparation(user, append.recordId, preparation.version);
    const rows = (await preview()).rows;
    expect(
      rows.find(
        (row) => row.dimensions.listing === `${play.id}:com.example.alpha`,
      )?.measures.rating?.value,
    ).toBe("4.3333");
    await data.publishModel(user, model.id, model.version);
  });
});

/**
 * A later template version that changes content only (same columns): the
 * ratings label "Available" becomes "Available (v3)"; with `retitle` it also
 * retitles the ratings widget, so the update has a dashboard.
 */
function contentOnly(retitle: boolean): StoreTemplateDefinition {
  return {
    version: storeTemplate.version + 1,
    keys: (inputs) => storeTemplate.keys(inputs),
    build(key, inputs, ids) {
      const record = storeTemplate.build(key, inputs, ids);
      if (record.kind === "preparation" && key.endsWith(":ratings")) {
        const graph = JSON.parse(
          JSON.stringify(record.graph).replace(
            '"value":"Available"',
            '"value":"Available (v3)"',
          ),
        ) as PreparationGraph;
        return { ...record, graph };
      }
      if (record.kind === "dashboard" && retitle) {
        const request = structuredClone(record.request);
        request.slides![0]!.widgets![2]!.title = "Ratings (v3)";
        return { ...record, request };
      }
      return record;
    },
  };
}

describe("drafts published before their inputs", { timeout: 30_000 }, () => {
  for (const retitle of [false, true])
    it(`count as not published until published again (${retitle ? "with" : "without"} a dashboard)`, async () => {
      const workspaceId = await createWorkspace(db, {
        name: "Order " + randomUUID().slice(0, 8),
        ownerUserId: userId,
      });
      const connections = [];
      for (const connectorId of ["app-store-connect", "google-play"] as const) {
        const [connection] = await withWorkspace(db, { workspaceId }, (tx) =>
          tx
            .insert(schema.connections)
            .values({
              workspaceId,
              connectorId,
              name: connectorId,
              setupPending: false,
            })
            .returning(),
        );
        connections.push(connection!);
      }
      const [apple, play] = connections as [
        (typeof connections)[number],
        (typeof connections)[number],
      ];
      const requestId = randomUUID();
      await createStoreTemplateService({
        db,
        registry,
        now: () => new Date(now),
        template: storeTemplate,
      }).install(actor(workspaceId), {
        requestId,
        name: "App portfolio",
        connections: connections.map((c) => c.id),
        groups: [],
      });
      await ingestReports(workspaceId, { apple, play });
      const updates = createStoreTemplateUpdateService({
        db,
        registry,
        now: () => new Date(now),
        template: contentOnly(retitle),
      });
      const plan = await updates.plan(actor(workspaceId), requestId);
      const update = await updates.apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: [],
      });
      expect(update.dashboards).toHaveLength(retitle ? 1 : 0);
      const data = createDataService(db, () => new Date(now));
      const user = { workspaceId, callerId: userId };
      const byKey = Object.fromEntries(update.drafts.map((d) => [d.key, d]));
      const model = byKey["model:ratings"]!,
        append = byKey["preparation:append:ratings:0:0"]!;
      // Out of order: what reads the sources first, then the sources.
      await data.publishModel(user, model.recordId, model.version);
      await data.publishPreparation(user, append.recordId, append.version);
      for (const draft of update.drafts)
        if (draft.key.startsWith("preparation:source:"))
          await data.publishPreparation(user, draft.recordId, draft.version);
      const availability = async () =>
        (
          await data.query(user, model.recordId, {
            measureIds: ["availability"],
            groupBy: ["listing", "storefront"],
          })
        ).rows.find(
          (row) => row.dimensions.listing === `${play.id}:com.example.alpha`,
        )?.measures.availability?.value;
      // Live, but still reading the sources' earlier versions.
      expect(await availability()).toBe("Available");
      const open = async () =>
        (await updates.list(actor(workspaceId))).installs[0]!;
      let state = await open();
      expect(
        Object.fromEntries(
          state.openUpdate!.drafts.map((d) => [d.key, [d.published, d.stale]]),
        ),
      ).toMatchObject({
        "model:ratings": [false, true],
        "preparation:append:ratings:0:0": [false, true],
        [`preparation:source:${play.id}:ratings`]: [true, false],
        [`preparation:source:${apple.id}:ratings`]: [true, false],
      });
      if (retitle) expect(state.openUpdate!.dashboards[0]!.ready).toBe(false);
      await expect(
        updates.createCopy(
          actor(workspaceId),
          update.id,
          "dashboard:portfolio",
        ),
      ).rejects.toThrow();

      // Published again, in order: the combined preparation, then the model.
      for (const draft of [append, model]) {
        const current =
          draft.kind === "model"
            ? (await data.getModel(user, draft.recordId)).model.version
            : (await data.getPreparation(user, draft.recordId)).preparation
                .version;
        if (draft.kind === "model")
          await data.publishModel(user, draft.recordId, current);
        else await data.publishPreparation(user, draft.recordId, current);
      }
      expect(await availability()).toBe("Available (v3)");
      state = await open();
      if (retitle) {
        expect(state.openUpdate!.drafts.every((d) => d.published)).toBe(true);
        expect(state.openUpdate!.dashboards[0]!.ready).toBe(true);
      } else {
        // No dashboards: done once everything reads the new versions.
        expect(state.openUpdate).toBeNull();
        expect(state.lastUpdate?.drafts.every((d) => d.published)).toBe(true);
      }
    });
});

describe("a finished update without dashboards", { timeout: 30_000 }, () => {
  /**
   * A current install with the content-only version 3 applied and every
   * draft published in the listed order; `list` is never read in between.
   */
  async function finishedUpdate() {
    const workspaceId = await createWorkspace(db, {
      name: "Finished " + randomUUID().slice(0, 8),
      ownerUserId: userId,
    });
    const connections = [];
    for (const connectorId of ["app-store-connect", "google-play"] as const) {
      const [connection] = await withWorkspace(db, { workspaceId }, (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId,
            connectorId,
            name: connectorId,
            setupPending: false,
          })
          .returning(),
      );
      connections.push(connection!);
    }
    const [apple, play] = connections as [
      (typeof connections)[number],
      (typeof connections)[number],
    ];
    const requestId = randomUUID();
    await createStoreTemplateService({
      db,
      registry,
      now: () => new Date(now),
      template: storeTemplate,
    }).install(actor(workspaceId), {
      requestId,
      name: "App portfolio",
      connections: connections.map((c) => c.id),
      groups: [],
    });
    await ingestReports(workspaceId, { apple, play });
    const updates = createStoreTemplateUpdateService({
      db,
      registry,
      now: () => new Date(now),
      template: contentOnly(false),
    });
    const plan = await updates.plan(actor(workspaceId), requestId);
    const update = await updates.apply(actor(workspaceId), requestId, {
      basis: plan.basis,
      decisions: [],
    });
    expect(update.dashboards).toHaveLength(0);
    const data = createDataService(db, () => new Date(now));
    const user = { workspaceId, callerId: userId };
    for (const draft of update.drafts)
      if (draft.kind === "model")
        await data.publishModel(user, draft.recordId, draft.version);
      else await data.publishPreparation(user, draft.recordId, draft.version);
    return { workspaceId, requestId, play, update, updates, data, user };
  }
  /** Publishes a source preparation again, renamed: an unrelated change. */
  async function republishSource(
    data: ReturnType<typeof createDataService>,
    user: { workspaceId: string; callerId: string },
    id: string,
  ) {
    const { preparation } = await data.getPreparation(user, id);
    const { preparation: saved } = await data.savePreparation(
      user,
      {
        name: preparation.name + " (renamed)",
        graph: preparation.graph,
        version: preparation.version,
      },
      id,
    );
    await data.publishPreparation(user, id, saved.version);
  }

  it("stays closed when one of its inputs is published again later (#626)", async () => {
    const { workspaceId, requestId, play, update, updates, data, user } =
      await finishedUpdate();
    await republishSource(
      data,
      user,
      update.drafts.find(
        (draft) => draft.key === `preparation:source:${play.id}:ratings`,
      )!.recordId,
    );
    const state = (await updates.list(actor(workspaceId))).installs[0]!;
    expect(state.openUpdate).toBeNull();
    expect(state.lastUpdate).toMatchObject({ id: update.id });
    expect(
      state.lastUpdate!.drafts.map((draft) => [draft.published, draft.stale]),
    ).toEqual(update.drafts.map(() => [true, false]));
    // Persisted: the update is closed, not only shown as done.
    const [row] =
      await owner`select closed_at from data_template_updates where id=${update.id}`;
    expect(row!.closed_at).not.toBeNull();
    // The next version applies; nothing is left open in the finished one.
    const fourth = createStoreTemplateUpdateService({
      db,
      registry,
      now: () => new Date(now),
      template: {
        version: storeTemplate.version + 2,
        keys: (inputs) => storeTemplate.keys(inputs),
        build(key, inputs, ids) {
          const record = contentOnly(false).build(key, inputs, ids);
          return record.kind === "preparation" && key.endsWith(":ratings")
            ? {
                ...record,
                graph: JSON.parse(
                  JSON.stringify(record.graph).replace(
                    '"value":"Available (v3)"',
                    '"value":"Available (v4)"',
                  ),
                ) as PreparationGraph,
              }
            : record;
        },
      },
    });
    const next = await fourth.plan(actor(workspaceId), requestId);
    await expect(
      fourth.apply(actor(workspaceId), requestId, {
        basis: next.basis,
        decisions: [],
      }),
    ).resolves.toMatchObject({ fromVersion: 3, toVersion: 4 });
  });

  it("is not offered again when the new version has nothing left to change (#625)", async () => {
    const { workspaceId, requestId, updates } = await finishedUpdate();
    // The dashboard record keeps its version (the update did not change
    // it), but applying again would change nothing.
    const [install] = (await updates.list(actor(workspaceId))).installs;
    expect(install).toMatchObject({
      updateAvailable: false,
      summary: null,
      openUpdate: null,
    });
    await expect(updates.plan(actor(workspaceId), requestId)).rejects.toThrow(
      "store_template_up_to_date",
    );
    await expect(
      updates.apply(actor(workspaceId), requestId, {
        basis: "anything",
        decisions: [],
      }),
    ).rejects.toThrow("store_template_up_to_date");
  });
});

describe(
  "store template version 3: proceeds and app labels (#620, #621)",
  { timeout: 30_000 },
  () => {
    it("offers version 2 installs the change as a template update, not silently", async () => {
      const workspaceId = await createWorkspace(db, {
        name: "Labels " + randomUUID().slice(0, 8),
        ownerUserId: userId,
      });
      const connections = [];
      for (const connectorId of ["app-store-connect", "google-play"] as const) {
        const [connection] = await withWorkspace(db, { workspaceId }, (tx) =>
          tx
            .insert(schema.connections)
            .values({
              workspaceId,
              connectorId,
              name: connectorId,
              setupPending: false,
            })
            .returning(),
        );
        connections.push(connection!);
      }
      const requestId = randomUUID();
      await createStoreTemplateService({
        db,
        registry,
        now: () => new Date(now),
        template: storeTemplate,
      }).install(actor(workspaceId), {
        requestId,
        name: "App portfolio",
        connections: connections.map((c) => c.id),
        groups: [],
      });
      // The current template is version 3; the install keeps version 2.
      const updates = createStoreTemplateUpdateService({
        db,
        registry,
        now: () => new Date(now),
      });
      const { installs } = await updates.list(actor(workspaceId));
      expect(installs[0]).toMatchObject({
        templateVersion: 2,
        latestVersion: 3,
        updateAvailable: true,
        error: null,
      });
      const recordKeys = async () =>
        (
          await owner`select key from data_template_records
            where request_id=${requestId} and detached_at is null`
        ).map((row) => row.key as string);
      expect(await recordKeys()).not.toContain("preparation:labels");

      const plan = await updates.plan(actor(workspaceId), requestId);
      const changed = plan.records
        .filter((record) => record.items.length)
        .map((record) => record.key);
      // The proceeds sources, the new label preparations and the models
      // change; the dashboard does not.
      expect(changed).toEqual(
        expect.arrayContaining([
          `preparation:source:${connections[0]!.id}:proceeds`,
          `preparation:source:${connections[1]!.id}:proceeds`,
          "preparation:labels",
          "preparation:labelled:proceeds",
          "model:proceeds",
          "model:downloads",
          "model:ratings",
        ]),
      );
      expect(changed).not.toContain("dashboard:portfolio");
      const update = await updates.apply(actor(workspaceId), requestId, {
        basis: plan.basis,
        decisions: [],
      });
      expect(update).toMatchObject({ fromVersion: 2, toVersion: 3 });
      expect(await recordKeys()).toEqual(
        expect.arrayContaining([
          "preparation:labels",
          "preparation:labelled:downloads",
          "preparation:labelled:proceeds",
          "preparation:labelled:ratings",
        ]),
      );
      // Drafts: the published version 2 stays live until published.
      const [draft] =
        await owner`select p.graph, p.version, p.published_version from data_preparations p
        join data_template_records r on r.record_id = p.id
        where r.request_id=${requestId}
        and r.key = ${`preparation:source:${connections[0]!.id}:proceeds`}`;
      expect(JSON.stringify(draft!.graph)).toContain("paid_rows");
      expect(draft!.version).toBeGreaterThan(
        draft!.published_version as number,
      );

      // Published in the listed order, every model and the app filter give
      // each app the same label; same-name apps of the two stores say which.
      const [apple, play] = connections;
      await ingestReports(
        workspaceId,
        { apple: apple!, play: play! },
        {
          [apple!.id]: { a: "Other app" },
          [play!.id]: { "com.example.beta": "Other app" },
        },
      );
      const data = createDataService(db, () => new Date(now));
      const user = { workspaceId, callerId: userId };
      for (const kind of ["preparation", "model"] as const)
        for (const each of update.drafts)
          if (each.kind === kind && kind === "preparation")
            await data.publishPreparation(user, each.recordId, each.version);
          else if (each.kind === kind)
            await data.publishModel(user, each.recordId, each.version);
      const models = Object.fromEntries(
        (
          await owner`select key, record_id from data_template_records
            where request_id=${requestId} and key like 'model:%'`
        ).map((row) => [row.key as string, row.record_id as string]),
      );
      const groupBy: Record<string, [string, string[]]> = {
        "model:downloads": ["downloads", ["app", "store"]],
        "model:proceeds": ["proceeds", ["app", "currency"]],
        "model:ratings": ["rating", ["app", "listing", "storefront"]],
      };
      const appleApp = `${apple!.id}:a`,
        playApp = `${play!.id}:com.example.beta`;
      const expected = {
        [appleApp]: "Other app · Apple App Store",
        [playApp]: "Other app · Google Play",
      };
      for (const [key, [measure, dimensions]] of Object.entries(groupBy)) {
        const result = await data.query(user, models[key]!, {
          measureIds: [measure],
          groupBy: dimensions,
        });
        const labels = Object.fromEntries(
          result.rows
            .filter((row) => String(row.dimensions.app) in expected)
            .map((row) => [row.dimensions.app, row.dimensionLabels?.app]),
        );
        expect(labels, key).toEqual(expected);
      }
      const filter = await withWorkspace(db, { workspaceId }, (tx) =>
        dashboardDimensionValues(
          tx,
          workspaceId,
          models["model:downloads"]!,
          "app",
          { search: "", offset: 0, limit: 50 },
          new Date(now),
        ),
      );
      expect(
        Object.fromEntries(
          filter.values
            .map((value, index) => [value, filter.labels?.[index]])
            .filter(([value]) => String(value) in expected),
        ),
      ).toEqual(expected);
    });
  },
);
