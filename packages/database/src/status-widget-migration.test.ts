import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The status board's migration (#338, ADR 0019 sections 2 and 7) on data in
// the previous shape: every stored widget type keeps satisfying the type
// checks, and afterwards `status` is accepted without binding columns and
// refused with any. The migration is found by its name, not its number, so
// a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_status_widget";

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

  // Data widgets of the previous shape, a text and a clock (an image needs
  // an image row; its check is unchanged).
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period, options)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 0, 0, 3, 2,
       ${connectionId}, 'visits', 'sum', 'today', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'bar', 3, 0, 4, 3,
       ${connectionId}, 'visits', 'sum', 'last_7_days',
       '{"groupBy":"route","limit":5}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 7, 0, 4, 4,
       ${connectionId}, 'visits', 'sum', 'last_30_days',
       '{"groupBy":"route","limit":5,"showChange":true,"showOthers":false}'::jsonb)`;
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, text)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'text', 0, 4, 6, 1,
       'Hello'),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'clock', 6, 4, 2, 1,
       null)`;
}, 60_000);

afterAll(async () => {
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

describe("the status widget migration", () => {
  it("refuses a status board before it", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'status', 0, 5, 3,
        3)`).rejects.toThrow(/dashboard_widgets_type_valid/);
  });

  it("keeps every widget and accepts a status board without a binding", async () => {
    const before = await snapshot();
    expect(before.length).toBe(5);

    await testDb.migrate();

    expect(await snapshot()).toEqual(before);
    const ids = [connectionId];
    await owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, options)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'status', 0, 5, 3, 3,
        ${owner.json({ connectionIds: ids, showAge: true })})`;
    const [board] = await owner`
      select type, options, connection_id from dashboard_widgets
      where type = 'status'`;
    expect(board!.options).toEqual({ connectionIds: ids, showAge: true });
    expect(board!.connection_id).toBeNull();
  });

  it("refuses a status board with a metric binding or text", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'status', 3, 5, 3, 3,
        ${connectionId}, 'visits', 'sum', 'today')`).rejects.toThrow(
      /dashboard_widgets_type_columns/,
    );
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, text)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'status', 3, 5, 3, 3,
        'x')`).rejects.toThrow(/dashboard_widgets_type_columns/);
  });
});
