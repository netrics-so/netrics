import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The compare widget's migration (#336, ADR 0019 sections 2 and 10) on data
// in the previous shape: every stored widget keeps satisfying the checks
// with the new columns empty; afterwards `compare` needs a numerator and a
// denominator binding, no other type may have a denominator, and deleting
// either connection deletes the widget. The migration is found by its
// name, not its number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_compare_widget";

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
let otherWorkspaceId: string;
let downloadsId: string;
let visitorsId: string;
let foreignId: string;
let dashboardId: string;
let slideId: string;

const snapshot = () => owner`
  select type, x, y, w, h, connection_id, metric_key, aggregation, period,
         text, options
  from dashboard_widgets order by y, x`;

async function connection(workspace: string, name: string): Promise<string> {
  const [row] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspace}, 'demo', ${name}) returning id`;
  return row!.id as string;
}

/** Inserts a compare widget at row `y` and returns its id. */
async function insertCompare(y: number, denominator: string): Promise<string> {
  const [row] = await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period,
      denominator_connection_id, denominator_metric_key,
      denominator_aggregation, denominator_dimensions, options)
    values (${slideId}, ${dashboardId}, ${workspaceId}, 'compare', 0, ${y}, 4,
      1, ${downloadsId}, 'downloads', 'sum', 'last_7_days', ${denominator},
      'visitors', 'sum', '{"resource":"prj_1"}'::jsonb,
      '{"format":"percent","ratioLabel":"conversion","showChange":true}'::jsonb)
    returning id`;
  return row!.id as string;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [other] = await owner`
    insert into workspaces (name) values ('Other') returning id`;
  otherWorkspaceId = other!.id as string;
  downloadsId = await connection(workspaceId, "App Store");
  visitorsId = await connection(workspaceId, "Vercel");
  foreignId = await connection(otherWorkspaceId, "Foreign");
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspaceId}, 'Studio') returning id`;
  dashboardId = dashboard!.id as string;
  const [slide] = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position)
    values (${dashboardId}, ${workspaceId}, 0) returning id`;
  slideId = slide!.id as string;

  // Every type of the previous shape but image (its check is unchanged).
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period, options)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 0, 0, 3, 2,
       ${downloadsId}, 'visits', 'sum', 'today', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'line', 3, 0, 4, 3,
       ${downloadsId}, 'visits', 'sum', 'last_30_days', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'bar', 7, 0, 4, 3,
       ${downloadsId}, 'visits', 'sum', 'this_week',
       '{"groupBy":"route","limit":5}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 0, 4, 4, 4,
       ${downloadsId}, 'visits', 'sum', 'last_7_days',
       '{"groupBy":"route","limit":5,"showChange":true,"showOthers":false}'::jsonb)`;
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

describe("the compare widget migration", () => {
  it("refuses a compare widget before it", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'compare', 8, 4, 4,
        3, ${downloadsId}, 'downloads', 'sum', 'last_7_days')`).rejects.toThrow(
      /dashboard_widgets_type_(valid|columns)/,
    );
  });

  it("keeps every widget, with empty denominator columns", async () => {
    const before = await snapshot();
    expect(before.length).toBe(6);

    await testDb.migrate();

    expect(await snapshot()).toEqual(before);
    const rows = await owner`
      select denominator_connection_id, denominator_metric_key,
             denominator_aggregation, denominator_dimensions
      from dashboard_widgets`;
    for (const row of rows) {
      expect(row).toEqual({
        denominator_connection_id: null,
        denominator_metric_key: null,
        denominator_aggregation: null,
        denominator_dimensions: {},
      });
    }
  });

  it("accepts a compare widget with both bindings", async () => {
    const id = await insertCompare(8 - 1, visitorsId);
    const [row] = await owner`
      select type, denominator_metric_key, denominator_dimensions, options
      from dashboard_widgets where id = ${id}`;
    expect(row).toEqual({
      type: "compare",
      denominator_metric_key: "visitors",
      denominator_dimensions: { resource: "prj_1" },
      options: {
        format: "percent",
        ratioLabel: "conversion",
        showChange: true,
      },
    });
    await owner`delete from dashboard_widgets where id = ${id}`;
  });

  it("refuses a compare widget without a denominator, and a denominator elsewhere", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'compare', 8, 4, 4,
        3, ${downloadsId}, 'downloads', 'sum', 'today')`).rejects.toThrow(
      /dashboard_widgets_denominator_columns/,
    );
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, denominator_connection_id, denominator_metric_key,
        denominator_aggregation)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'compare', 8, 4, 4,
        3, ${visitorsId}, 'visitors', 'sum')`).rejects.toThrow(
      /dashboard_widgets_type_columns/,
    );
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period,
        denominator_connection_id, denominator_metric_key,
        denominator_aggregation)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 8, 4, 3,
        2, ${downloadsId}, 'downloads', 'sum', 'today', ${visitorsId},
        'visitors', 'sum')`).rejects.toThrow(
      /dashboard_widgets_denominator_columns/,
    );
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period,
        denominator_connection_id, denominator_metric_key,
        denominator_aggregation)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'compare', 8, 4, 4,
        3, ${downloadsId}, 'downloads', 'sum', 'today', ${visitorsId},
        'visitors', 'median')`).rejects.toThrow(
      /dashboard_widgets_denominator_columns/,
    );
  });

  it("refuses a denominator of another workspace", async () => {
    await expect(insertCompare(5, foreignId)).rejects.toThrow(
      /dashboard_widgets_denominator_connection_fk/,
    );
  });

  it("deletes the widget with either connection", async () => {
    const byDenominator = await insertCompare(5, visitorsId);
    await owner`delete from connections where id = ${visitorsId}`;
    expect(
      await owner`select id from dashboard_widgets where id = ${byDenominator}`,
    ).toHaveLength(0);

    const other = await connection(workspaceId, "Vercel 2");
    const byNumerator = await insertCompare(6, other);
    await owner`delete from connections where id = ${downloadsId}`;
    expect(
      await owner`select id from dashboard_widgets where id = ${byNumerator}`,
    ).toHaveLength(0);
  });
});
