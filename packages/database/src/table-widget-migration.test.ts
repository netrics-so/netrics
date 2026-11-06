import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The table widget's migration (#332, ADR 0019 sections 2 and 6) on data in
// the previous shape: every stored widget type keeps satisfying the type
// checks, and afterwards `table` is accepted with a metric binding (like
// `bar`) and refused without one. The migration is found by its name, not
// its number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_table_widget";

/** The tag of the migration just before this one. */
function lastBefore(): string {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith(TAG_SUFFIX),
  );
  expect(at).toBeGreaterThan(0);
  return journal.entries[at - 1]!.tag;
}

let testDb: TestDatabase;
let owner: postgres.Sql;
let workspaceId: string;
let connectionId: string;
let dashboardId: string;
let slideId: string;

const snapshot = () => owner`
  select type, x, y, w, h, connection_id, metric_key, aggregation, period,
         text, options
  from dashboard_widgets order by y, x`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Demo') returning id`;
  connectionId = connection!.id as string;
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspaceId}, 'Studio') returning id`;
  dashboardId = dashboard!.id as string;
  const [slide] = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position)
    values (${dashboardId}, ${workspaceId}, 0) returning id`;
  slideId = slide!.id as string;

  // Every type of the previous shape (an image needs an image row; its
  // check is unchanged, so the five others stand for it).
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period, options)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 0, 0, 3, 2,
       ${connectionId}, 'visits', 'sum', 'today', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'line', 3, 0, 4, 3,
       ${connectionId}, 'visits', 'sum', 'last_30_days', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'bar', 7, 0, 4, 3,
       ${connectionId}, 'visits', 'sum', 'last_7_days',
       '{"groupBy":"route","limit":5}'::jsonb)`;
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, text)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'text', 0, 3, 6, 1,
       'Hello'),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'clock', 6, 3, 2, 1,
       null)`;
}, 60_000);

afterAll(async () => {
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

describe("the table widget migration", () => {
  it("refuses a table before it", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 0, 4, 4, 4,
        ${connectionId}, 'visits', 'sum', 'last_30_days')`).rejects.toThrow(
      /dashboard_widgets_type_(valid|columns)/,
    );
  });

  it("keeps every widget and accepts a table with a metric binding", async () => {
    const before = await snapshot();
    expect(before.length).toBe(5);

    await testDb.migrate();

    expect(await snapshot()).toEqual(before);
    await owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period,
        dimensions, options)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 0, 4, 4, 4,
        ${connectionId}, 'visits', 'sum', 'last_30_days',
        '{"resource":"prj_1"}'::jsonb,
        '{"groupBy":"route","limit":8,"showChange":true,"showOthers":false}'::jsonb)`;
    const [table] = await owner`
      select type, options from dashboard_widgets where type = 'table'`;
    expect(table!.options).toEqual({
      groupBy: "route",
      limit: 8,
      showChange: true,
      showOthers: false,
    });
  });

  it("refuses a table without a binding, or with text, and later types", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 4, 4, 4,
        4)`).rejects.toThrow(/dashboard_widgets_type_columns/);
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period,
        text)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 4, 4, 4, 4,
        ${connectionId}, 'visits', 'sum', 'today', 'x')`).rejects.toThrow(
      /dashboard_widgets_type_columns/,
    );
    // A type no migration admits (each type widens the check in its own
    // migration, ADR 0019 §2).
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'heatmap', 8, 4, 3,
        3)`).rejects.toThrow(/dashboard_widgets_type_valid/);
  });
});
