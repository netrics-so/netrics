import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import type { PreparationGraph } from "@netrics/domain";
import { storeTemplatePlanSchema } from "@netrics/contracts";
import { createDefaultRegistry } from "../connectors.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { createStoreTemplateService } from "./store-template-service.js";
import { createStoreTemplateUpdateService } from "./store-template-updates.js";
import { storeTemplate, storeTemplateV1 } from "./store-template.js";
import { now } from "./test-helpers.js";

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

describe("store template version 2: Play Console rating reports", () => {
  it("offers version 1 installs the Play ratings change and applies it with the new sources", async () => {
    const { workspaceId, requestId, apple, play } = await versionOneInstall();
    const updates = createStoreTemplateUpdateService({
      db,
      registry,
      now: () => new Date(now),
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
});
