import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  schema,
  type Database,
  type Sql,
} from "@netrics/database";

import { createDefaultRegistry } from "../connectors.js";
import {
  createTestDatabase,
  TEST_DATABASE_DROP_TIMEOUT_MS,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { findDashboard, withWorkspace } from "@netrics/database";

import { presentDashboard } from "./service.js";
import { createStoreTemplateService } from "./store-template-service.js";

/**
 * The statements one store-template install sends (#668). An install holds
 * the global install lock (#604) for all of them, so every statement is
 * waiting time for the next install in any workspace. Before #668 the
 * e2e journeys' two-connection install sent 1,102 statements, about 58 per
 * template record: every preparation and model publication loaded each
 * source again, and a preparation's publication evaluated its graph twice,
 * loading every input again for the second pass. Now the install's data
 * service is one batch whose loaders share source loads and preparation rows.
 */
let test: TestDatabase, db: Database, owner: Sql, userId: string;
const statements: string[] = [];
const registry = createDefaultRegistry();

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl, {
    max: 1,
    onQuery: (query) => statements.push(query),
  });
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "store-queries@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await test?.drop();
}, TEST_DATABASE_DROP_TIMEOUT_MS);

/** A workspace with the e2e journeys' two connections, stored as set up. */
async function workspace(name: string) {
  const id = await createWorkspace(db, { name, ownerUserId: userId });
  const connections: string[] = [];
  for (const connectorId of ["app-store-connect", "google-play"]) {
    const [row] = await owner<{ id: string }[]>`
      insert into connections(workspace_id,connector_id,name,setup_pending)
      values (${id},${connectorId},${connectorId},false) returning id`;
    connections.push(row!.id);
  }
  return { id, connections };
}

const reads = (sent: string[], table: string) =>
  sent.filter(
    (statement) =>
      statement.startsWith("select") && statement.includes(`from "${table}"`),
  ).length;

describe("store-template install statements (#668)", () => {
  it("sends at most 20 statements per template record and loads each source once", async () => {
    for (const name of ["First", "Second"]) {
      const target = await workspace(name),
        requestId = randomUUID();
      statements.length = 0;
      await createStoreTemplateService({ db, registry }).install(
        { workspaceId: target.id, callerId: userId, locale: "en" },
        {
          requestId,
          name: "App portfolio",
          connections: target.connections,
          groups: [],
        },
      );
      const sent = [...statements];
      const [records] = await owner<{ n: number; preparations: number }[]>`
        select count(*)::int as n,
               count(*) filter (where kind = 'preparation')::int as preparations
        from data_template_records
        where workspace_id = ${target.id} and request_id = ${requestId}`;
      expect(records!.n).toBeGreaterThan(10);
      // 320 statements for 19 records (13 preparations) when written.
      expect(sent.length).toBeLessThanOrEqual(20 * records!.n);
      // The two manual datasets' rows and each connection's resource
      // catalog: read once, by the first preparation that reads them.
      expect(reads(sent, "data_records")).toBe(2);
      expect(reads(sent, "connection_resources")).toBe(2);
      // Each published version read once, by its publication's second pass.
      expect(reads(sent, "data_preparation_versions")).toBeLessThanOrEqual(
        records!.preparations,
      );
    }
  }, 120_000);

  it("reads each published model once when a dashboard is shown (#835)", async () => {
    // The App portfolio has measure tables and value views split by store
    // over the same models: their column heads and units come from one
    // read of the published releases, and each model's units from one
    // probe, however many widgets and measures.
    const target = await workspace("Shown");
    await createStoreTemplateService({ db, registry }).install(
      { workspaceId: target.id, callerId: userId, locale: "en" },
      {
        requestId: randomUUID(),
        name: "App portfolio",
        connections: target.connections,
        groups: [],
      },
    );
    // Beside each measure table, the same model as a value view split by
    // the table's first grouping (#784): its units are read too.
    const tables = await owner<{ id: string }[]>`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
        x, y, w, h, title, model_id, model_binding, options)
      select slide_id, dashboard_id, workspace_id, type, x, y, w, h, title,
        model_id, model_binding, jsonb_build_object('view', 'value', 'limit', 2)
      from dashboard_widgets
      where workspace_id = ${target.id} and type = 'measure'
        and options->>'view' = 'table'
        and jsonb_array_length(model_binding->'groupBy') > 0
      returning id`;
    expect(tables.length).toBeGreaterThan(0);
    const dashboards = await owner<{ id: string }[]>`
      select id from dashboards where workspace_id = ${target.id}`;
    expect(dashboards.length).toBeGreaterThan(0);
    for (const { id } of dashboards) {
      statements.length = 0;
      await withWorkspace(db, { workspaceId: target.id }, async (tx) => {
        const dashboard = (await findDashboard(tx, target.id, id))!;
        await presentDashboard(tx, target.id, dashboard, "en");
      });
      // Joined from the models: any statement that reads a release.
      const releaseReads = statements.filter(
        (statement) =>
          statement.startsWith("select") &&
          statement.includes('"data_model_releases"'),
      ).length;
      expect(releaseReads).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});
