import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder, runMigrations } from "./index.js";

// Migration 0064 (#507) on data in the previous shape (0063): compare,
// measure and metric widgets keep everything they had. Afterwards a compare
// widget may name a model of its own workspace together with its binding,
// never one without the other, and other widgets still name none.

const LAST_BEFORE = "0063_device_scope";

const serverUrl =
  process.env.NETRICS_TEST_ADMIN_URL ??
  "postgres://netrics:netrics@localhost:5433/postgres";
const name = `netrics_test_${randomBytes(6).toString("hex")}`;
let adminUrl: string;
let folder: string;

/** A copy of the migrations folder that ends at `lastTag`. */
function migrationsUpTo(lastTag: string): string {
  const copy = mkdtempSync(path.join(tmpdir(), "netrics-migrations-"));
  cpSync(migrationsFolder, copy, { recursive: true });
  const journalPath = path.join(copy, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  expect(last).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, last + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return copy;
}

beforeAll(async () => {
  const server = postgres(serverUrl, { max: 1 });
  await server.unsafe(`CREATE DATABASE ${name}`);
  await server.end({ timeout: 5 });
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  adminUrl = url.toString();
  folder = migrationsUpTo(LAST_BEFORE);

  const client = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end({ timeout: 5 });
  }
}, 60_000);

afterAll(async () => {
  rmSync(folder, { recursive: true, force: true });
  const server = postgres(serverUrl, { max: 1 });
  await server.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await server.end({ timeout: 5 });
});

describe("migration 0064 on dashboard widgets", () => {
  it("keeps every widget and lets only compare widgets add a model", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      const [workspace] = await owner`
        insert into workspaces (name) values ('W') returning id`;
      const workspaceId = workspace!.id as string;
      const [foreign] = await owner`
        insert into workspaces (name) values ('F') returning id`;
      await owner`insert into connectors (id, version, manifest)
        values ('c', '1.0.0', '{}'::jsonb)`;
      const [connection] = await owner`
        insert into connections (workspace_id, connector_id, name)
        values (${workspaceId}, 'c', 'Shop') returning id`;
      const connectionId = connection!.id as string;
      const [model] = await owner`
        insert into data_models (workspace_id, name, definition)
        values (${workspaceId}, 'Own', '{}'::jsonb) returning id`;
      const modelId = model!.id as string;
      const [foreignModel] = await owner`
        insert into data_models (workspace_id, name, definition)
        values (${foreign!.id}, 'Foreign', '{}'::jsonb) returning id`;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name)
        values (${workspaceId}, 'D') returning id`;
      const dashboardId = dashboard!.id as string;
      const [slide] = await owner`
        insert into dashboard_slides (dashboard_id, workspace_id, position)
        values (${dashboardId}, ${workspaceId}, 0) returning id`;
      const slideId = slide!.id as string;
      const binding = {
        modelId,
        measureIds: ["ratio"],
        groupBy: [],
        exclusions: [],
      };
      await owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h, connection_id, metric_key, aggregation, period,
          denominator_connection_id, denominator_metric_key,
          denominator_aggregation, options)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'compare', 0, 0,
          3, 3, ${connectionId}, 'c.signups', 'sum', 'this_month',
          ${connectionId}, 'c.visits', 'avg', '{"format":"ratio"}'::jsonb)`;
      await owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h, model_id, model_binding)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'measure', 3, 0,
          3, 3, ${modelId}, ${owner.json(binding)})`;
      await owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h, connection_id, metric_key, aggregation, period)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 6, 0,
          3, 3, ${connectionId}, 'c.visits', 'sum', 'today')`;
      const widgets = () => owner`
        select * from dashboard_widgets order by x`;
      const before = await widgets();

      await runMigrations(adminUrl);

      expect(await widgets()).toEqual(before);
      const measure = {
        modelId,
        dateDimensionId: "date",
        measureIds: {
          numerator: "numerator",
          denominator: "denominator",
          ratio: "ratio",
        },
      };
      // A compare widget binds a model of its own workspace…
      await owner`
        update dashboard_widgets
        set model_id = ${modelId}, model_binding = ${owner.json(measure)}
        where type = 'compare'`;
      await owner`
        update dashboard_widgets set model_id = null, model_binding = null
        where type = 'compare'`;
      // …never only one of the two, nor one of another workspace.
      await expect(
        owner`update dashboard_widgets set model_id = ${modelId}
          where type = 'compare'`,
      ).rejects.toThrow(/dashboard_widgets_model_valid/);
      await expect(
        owner`update dashboard_widgets set model_binding = ${owner.json(measure)}
          where type = 'compare'`,
      ).rejects.toThrow(/dashboard_widgets_model_valid/);
      await expect(
        owner`
          update dashboard_widgets
          set model_id = ${foreignModel!.id}, model_binding = ${owner.json(measure)}
          where type = 'compare'`,
      ).rejects.toThrow(/dashboard_widgets_model_fk/);
      // Other widgets still name no model; a measure widget still must.
      await expect(
        owner`
          update dashboard_widgets
          set model_id = ${modelId}, model_binding = ${owner.json(measure)}
          where type = 'metric'`,
      ).rejects.toThrow(/dashboard_widgets_model_valid/);
      await expect(
        owner`
          update dashboard_widgets set model_id = null, model_binding = null
          where type = 'measure'`,
      ).rejects.toThrow(/dashboard_widgets_model_valid/);
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
