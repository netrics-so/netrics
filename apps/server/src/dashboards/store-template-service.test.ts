import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  withWorkspace,
  schema,
  adminSetDataPolicy,
  ingestDatasetPage,
  upsertConnectionResources,
  type Database,
  type Sql,
} from "@netrics/database";
import { createDefaultRegistry } from "../connectors.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { syncCatalog } from "../sync/catalog.js";
import { createDataService } from "../data/service.js";
import { createStoreTemplateService } from "./store-template-service.js";
import { queryDashboardData, dashboardDimensionValues } from "./data.js";
import { createDashboardService } from "./service.js";
import { buildStoreDashboard } from "./store-portfolio.js";
import { createDashboardRequestSchema } from "@netrics/contracts";
import { apple, google, inputs, now } from "./test-helpers.js";
import type {
  StoreTemplateRequest,
  StoreTemplateResult,
} from "@netrics/contracts";

let db: Database,
  owner: Sql,
  workspaceId: string,
  otherId: string,
  userId: string;
const registry = createDefaultRegistry(),
  actor = () => ({ workspaceId, callerId: userId, locale: "en" as const });
const requestId = randomUUID(),
  groupId = randomUUID();
let installed: StoreTemplateResult;
const input: StoreTemplateRequest = {
  requestId,
  name: "App portfolio",
  connections: [apple.id, google.id],
  groups: [
    {
      id: groupId,
      name: "Example app",
      apps: [
        { connectionId: apple.id, appId: "a" },
        { connectionId: google.id, appId: "com.example.alpha" },
      ],
    },
  ],
};
beforeAll(async () => {
  const test = await createTestDatabase({
    upTo: "0056_dataset_publication_state",
  });
  db = createDatabase(test.appUrl);
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const admin = createDatabase(test.adminUrl, { max: 1 });
  await syncCatalog(admin, registry);
  await admin.$client.end({ timeout: 5 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "store-template@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
  workspaceId = await createWorkspace(db, {
    name: "Stores",
    ownerUserId: userId,
  });
  otherId = await createWorkspace(db, { name: "Other", ownerUserId: userId });
  // Raw SQL: the schema is older than drizzle's current connection columns.
  for (const source of [apple, google])
    await owner`insert into connections(id,workspace_id,connector_id,name,setup_pending)
      values (${source.id},${workspaceId},${source.connectorId},${source.name},false)`;
  await test.migrate();
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});
const service = () =>
  createStoreTemplateService({ db, registry, now: () => new Date(now) });
const count = async (table: string, workspace = workspaceId) =>
  (
    await owner.unsafe(
      `select count(*)::int as count from ${table} where workspace_id=$1`,
      [workspace],
    )
  )[0]!.count;

// Each test here runs hundreds of statements one after another; the product
// edit runs about 700 in 10 transactions. They take 0.3-0.7 s alone and up to
// 3.4 s in a full `pnpm test` run on a loaded machine, close to vitest's 5 s
// default, which the product edit went over once (#555). Their time follows
// the server's latency, not the test, so the budget is about six times the
// slowest full-run time seen.
const TIMEOUT_MS = 20_000;

describe("atomic editable store templates", { timeout: TIMEOUT_MS }, () => {
  it("installs definitions before the first reports without fake raw or prepared generations", async () => {
    installed = await service().install(actor(), input);
    expect(await count("dashboards")).toBe(1);
    expect(await count("data_models")).toBe(3);
    expect(await count("data_preparations")).toBe(9);
    expect(await count("data_template_installs")).toBe(1);
    const [data] =
      await owner`select count(*)::int as count from data_generations g join data_datasets d on d.id=g.dataset_id where d.workspace_id=${workspaceId} and d.kind='source'`;
    expect(data!.count).toBe(0);
    expect(await count("data_prepared_generations")).toBe(0);
    const result = await createDataService(db, () => new Date(now)).query(
      actor(),
      installed.models.downloads,
      { measureIds: ["downloads"], groupBy: ["app", "store"] },
    );
    expect(result.rows).toEqual([]);
    expect(result.pendingSources).toHaveLength(2);
    const choices = await withWorkspace(db, { workspaceId }, (tx) =>
      dashboardDimensionValues(
        tx,
        workspaceId,
        installed.models.downloads,
        "app",
        { search: "", offset: 0, limit: 50 },
        new Date(now),
      ),
    );
    expect(choices.values).toEqual([]);
    const [dashboard] =
      await owner`select data_filters from dashboards where id=${installed.dashboardId}`;
    expect(dashboard!.data_filters).toHaveLength(6);
  });
  it("reuses the same request without duplicates or overwriting customer edits", async () => {
    expect(
      await service().install(actor(), {
        ...input,
        connections: [google.id, apple.id],
      }),
    ).toEqual(installed);
    await owner`update dashboards set name='Customer edited' where id=${installed.dashboardId}`;
    expect(await service().install(actor(), input)).toEqual(installed);
    expect(
      (
        await owner`select name from dashboards where id=${installed.dashboardId}`
      )[0]!.name,
    ).toBe("Customer edited");
    expect(await count("dashboards")).toBe(1);
    await expect(
      service().install(actor(), { ...input, name: "Changed request" }),
    ).rejects.toThrow("store_template_request_reused");
  });
  it("rolls back every new record after a policy failure and refuses foreign connections", async () => {
    await adminSetDataPolicy(db, otherId, { maxModels: 1 });
    const [connection] = await withWorkspace(
      db,
      { workspaceId: otherId },
      (tx) =>
        tx
          .insert(schema.connections)
          .values({
            workspaceId: otherId,
            connectorId: "app-store-connect",
            name: "Other Apple",
            setupPending: false,
          })
          .returning(),
    );
    await expect(
      service().install(
        { ...actor(), workspaceId: otherId },
        {
          requestId: randomUUID(),
          name: "Fails atomically",
          connections: [connection!.id],
          groups: [],
        },
      ),
    ).rejects.toThrow("data_model_limit");
    for (const table of [
      "dashboards",
      "data_datasets",
      "data_preparations",
      "data_models",
      "data_template_installs",
    ])
      expect(await count(table, otherId)).toBe(0);
    await expect(
      service().install({ ...actor(), workspaceId: otherId }, input),
    ).rejects.toThrow("connection_not_found");
    const visible = await withWorkspace(db, { workspaceId: otherId }, (tx) =>
      tx.select().from(schema.dataTemplateInstalls),
    );
    expect(visible).toHaveLength(0);
  });
  it("reads real completed reports through the same definitions and invalidates names without changing identities", async () => {
    const fixtures = inputs();
    for (const source of [apple, google]) {
      const manifest = registry.get(source.connectorId)!.manifest;
      for (const [key, fixtureId] of Object.entries(source.datasets)) {
        const definition = manifest.datasets!.find(
          (dataset) => dataset.key === key,
        )!;
        const table = fixtures.get(fixtureId)!;
        await withWorkspace(db, { workspaceId }, (tx) =>
          ingestDatasetPage(tx, {
            workspaceId,
            connectionId: source.id,
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
              records: table.rows.map((values, index) => ({
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
      const names = fixtures.get(`resources:${source.id}`)!.rows;
      await withWorkspace(db, { workspaceId }, (tx) =>
        upsertConnectionResources(tx, {
          workspaceId,
          connectionId: source.id,
          resources: names.map((row) => ({
            id: row.resource_id as string,
            name: row.name as string,
            kind: row.kind as string,
          })),
          now: new Date(now),
        }),
      );
    }
    const data = createDataService(db, () => new Date(now));
    const result = await data.query(actor(), installed.models.proceeds, {
      measureIds: ["proceeds"],
      groupBy: ["app", "currency"],
    });
    const product = result.rows.find(
      (row) => row.dimensions.app === "product:" + groupId,
    )!;
    expect(product.dimensionLabels?.app).toBe("Example app");
    expect(product.measures.proceeds).toMatchObject({
      value: "6.2",
      currency: "USD",
      status: "ok",
    });
    expect(result.pendingSources).toBeUndefined();
    expect(result.receivedAt).toBe(now);
    const ratings = await data.query(actor(), installed.models.ratings, {
      measureIds: ["rating"],
      groupBy: ["listing", "storefront"],
    });
    expect(ratings.rows).toHaveLength(2);
    await expect(
      data.query(actor(), installed.models.ratings, {
        measureIds: ["rating"],
        groupBy: ["app"],
      }),
    ).rejects.toThrow("model_measure_scope_required");
    const before = await data.query(actor(), installed.models.downloads, {
      measureIds: ["downloads"],
      groupBy: ["app", "store"],
    });
    await withWorkspace(db, { workspaceId }, (tx) =>
      upsertConnectionResources(tx, {
        workspaceId,
        connectionId: google.id,
        resources: [
          { id: "com.example.beta", name: "Renamed app", kind: "Android" },
        ],
        now: new Date(now),
      }),
    );
    const after = await data.query(actor(), installed.models.downloads, {
      measureIds: ["downloads"],
      groupBy: ["app", "store"],
    });
    const beta = after.rows.find(
      (row) => row.dimensions.app === google.id + ":com.example.beta",
    )!;
    expect(beta.dimensionLabels?.app).toBe("Renamed app");
    expect(beta.measures.downloads?.value).toBe("4");
    expect(after.provenance).not.toEqual(before.provenance);
  });
  it("updates every dependent model from one product edit and keeps history visible with actionable source health", async () => {
    const data = createDataService(db, () => new Date(now));
    const table = await data.readManual(actor(), installed.productDatasetId, {
      offset: 0,
      limit: 1000,
    });
    await data.saveManualPage(actor(), {
      datasetId: installed.productDatasetId,
      generationId: table.generationId,
      definition: table.definition,
      refreshId: randomUUID(),
      page: 0,
      complete: true,
      records: table.records.map((record) => ({
        values: {
          ...record.values,
          ...(record.values.product_id === "product:" + groupId
            ? { product_name: "Renamed product" }
            : {}),
        },
      })),
    });
    for (const [metric, measure, groupBy] of [
      ["downloads", "downloads", ["app", "store"]],
      ["proceeds", "proceeds", ["app", "currency"]],
      ["ratings", "rating_count", ["app", "listing", "storefront"]],
    ] as const) {
      const result = await data.query(actor(), installed.models[metric], {
        measureIds: [measure],
        groupBy: [...groupBy],
      });
      expect(
        result.rows
          .filter((row) => row.dimensions.app === "product:" + groupId)
          .every((row) => row.dimensionLabels?.app === "Renamed product"),
      ).toBe(true);
    }
    const choices = await withWorkspace(db, { workspaceId }, (tx) =>
      dashboardDimensionValues(
        tx,
        workspaceId,
        installed.models.proceeds,
        "app",
        { search: "renamed product", offset: 0, limit: 50 },
        new Date(now),
      ),
    );
    expect(choices).toMatchObject({
      values: ["product:" + groupId],
      labels: ["Renamed product"],
    });
    const filtered = await data.query(actor(), installed.models.proceeds, {
      measureIds: ["proceeds"],
      groupBy: ["currency"],
      filter: {
        kind: "call",
        fn: "in",
        args: [
          { kind: "field", fieldId: "app" },
          { kind: "literal", type: "json", value: ["product:" + groupId] },
        ],
      },
    });
    expect(filtered.filterValueLabels).toEqual([
      {
        dimensionId: "app",
        value: "product:" + groupId,
        label: "Renamed product",
      },
    ]);
    const query = () =>
      withWorkspace(db, { workspaceId }, async (tx) => {
        const [dashboard] = await tx
          .select()
          .from(schema.dashboards)
          .where(
            and(
              eq(schema.dashboards.workspaceId, workspaceId),
              eq(schema.dashboards.id, installed.dashboardId),
            ),
          );
        const widgets = await tx
          .select()
          .from(schema.dashboardWidgets)
          .where(
            and(
              eq(schema.dashboardWidgets.workspaceId, workspaceId),
              eq(schema.dashboardWidgets.dashboardId, installed.dashboardId),
            ),
          );
        return queryDashboardData(
          tx,
          workspaceId,
          widgets,
          dashboard!.dataFilters,
          {},
          new Date(now),
        );
      });
    await owner`insert into connection_state(workspace_id,connection_id,auth_state,last_success_at) values (${workspaceId},${google.id},'needs_reauthorization',${new Date(now)})`;
    let result = await query();
    expect(
      result.widgets.every((widget) =>
        widget.sourceHealth?.some(
          (source) =>
            source.connectionId === google.id &&
            source.status === "needs_reauthorization",
        ),
      ),
    ).toBe(true);
    expect(
      result.widgets.every(
        (widget) =>
          widget.result &&
          widget.error === null &&
          widget.exclusions.length === 0,
      ),
    ).toBe(true);
    await owner`update connection_state set auth_state='ok',consecutive_failures=2 where workspace_id=${workspaceId} and connection_id=${google.id}`;
    result = await query();
    expect(
      result.widgets.every((widget) =>
        widget.sourceHealth?.some((source) => source.status === "outage"),
      ),
    ).toBe(true);
    await owner`update connection_state set consecutive_failures=0 where workspace_id=${workspaceId} and connection_id=${google.id}`;
    await owner`update connections set config='{"resourceSelection":[]}' where workspace_id=${workspaceId} and id=${google.id}`;
    result = await query();
    expect(
      result.widgets.every(
        (widget) =>
          widget.sourceHealth?.some((source) => source.status === "paused") &&
          widget.result,
      ),
    ).toBe(true);
  });
  it("publishes one changed calculation to several dependent dashboards while drafts stay private", async () => {
    const dashboards = createDashboardService({ db });
    const second = await dashboards.create(
      actor(),
      createDashboardRequestSchema.parse(
        buildStoreDashboard("Second overview", installed.models, "en"),
      ),
    );
    if (!second.ok) throw new Error(second.error);
    const data = createDataService(db, () => new Date(now));
    const original = (await data.getModel(actor(), installed.models.proceeds))
      .model;
    const saved = await data.saveModel(
      actor(),
      {
        name: original.name,
        version: original.version,
        definition: {
          ...original.definition,
          measures: [
            ...original.definition.measures.map((measure) =>
              measure.id === "proceeds"
                ? { ...measure, id: "original" }
                : measure,
            ),
            {
              id: "proceeds",
              name: "Doubled proceeds",
              kind: "formula",
              expression: {
                kind: "call",
                fn: "multiply",
                args: [
                  { kind: "field", fieldId: "original" },
                  { kind: "literal", type: "decimal", value: "2" },
                ],
              },
            },
          ],
        },
      },
      installed.models.proceeds,
    );
    const read = (dashboardId: string) =>
      withWorkspace(db, { workspaceId }, async (tx) => {
        const widgets = await tx
          .select()
          .from(schema.dashboardWidgets)
          .where(
            and(
              eq(schema.dashboardWidgets.workspaceId, workspaceId),
              eq(schema.dashboardWidgets.dashboardId, dashboardId),
            ),
          );
        const [dashboard] = await tx
          .select()
          .from(schema.dashboards)
          .where(
            and(
              eq(schema.dashboards.workspaceId, workspaceId),
              eq(schema.dashboards.id, dashboardId),
            ),
          );
        const result = await queryDashboardData(
          tx,
          workspaceId,
          widgets,
          dashboard!.dataFilters,
          {},
          new Date(now),
        );
        return result.widgets
          .find(
            (widget) => widget.metadata?.modelId === installed.models.proceeds,
          )!
          .result!.rows.find(
            (row) => row.dimensions.app === "product:" + groupId,
          )!.measures.proceeds!.value;
      });
    expect(await read(installed.dashboardId)).toBe("6.2");
    expect(await read(second.value.id)).toBe("6.2");
    await data.publishModel(
      actor(),
      installed.models.proceeds,
      saved.model.version,
    );
    expect(await read(installed.dashboardId)).toBe("12.4");
    expect(await read(second.value.id)).toBe("12.4");
  });
});
