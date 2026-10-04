import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The goal widget's migration (#339, ADR 0019 sections 2 and 5) on data in
// the previous shape: every stored widget stays as it was; afterwards a
// `gauge` names a goal of its own workspace (or none), no other type names
// one, and deleting the goal clears only `goal_id`, so the widget stays.
// The migration is found by its name, not its number, so a renumbering on
// merge does not touch this test.

const TAG_SUFFIX = "_gauge_widget";

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
let connectionId: string;
let otherConnectionId: string;
let dashboardId: string;
let slideId: string;
let goalId: string;
let otherGoalId: string;

const snapshot = () => owner`
  select type, x, y, w, h, connection_id, metric_key, aggregation, period,
         text, options
  from dashboard_widgets order by y, x`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  const [workspace, other] = await owner`
    insert into workspaces (name) values ('W'), ('Other') returning id`;
  workspaceId = workspace!.id as string;
  otherWorkspaceId = other!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Demo') returning id`;
  connectionId = connection!.id as string;
  const [foreign] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${otherWorkspaceId}, 'demo', 'Demo') returning id`;
  otherConnectionId = foreign!.id as string;
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspaceId}, 'Studio') returning id`;
  dashboardId = dashboard!.id as string;
  const [slide] = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position)
    values (${dashboardId}, ${workspaceId}, 0) returning id`;
  slideId = slide!.id as string;
  const [goal] = await owner`
    insert into goals (workspace_id, name, connection_id, metric_key,
      aggregation, period, target)
    values (${workspaceId}, 'Monthly downloads', ${connectionId}, 'visits',
      'sum', 'this_month', 15000) returning id`;
  goalId = goal!.id as string;
  const [otherGoal] = await owner`
    insert into goals (workspace_id, name, connection_id, metric_key,
      aggregation, period, target)
    values (${otherWorkspaceId}, 'Theirs', ${otherConnectionId}, 'visits',
      'sum', 'this_month', 10) returning id`;
  otherGoalId = otherGoal!.id as string;

  // The widget types of the previous shape (an image needs an image row;
  // its check is unchanged).
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period, options)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 0, 0, 3, 2,
       ${connectionId}, 'visits', 'sum', 'today', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'line', 3, 0, 4, 3,
       ${connectionId}, 'visits', 'sum', 'last_30_days', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 7, 0, 4, 4,
       ${connectionId}, 'visits', 'sum', 'this_week',
       '{"groupBy":"route","limit":5}'::jsonb)`;
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

const gauge = (fields: { goal: string | null; x?: number }) => owner`
  insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
    x, y, w, h, goal_id, options)
  values (${slideId}, ${dashboardId}, ${workspaceId}, 'gauge',
    ${fields.x ?? 0}, 5, 3, 3, ${fields.goal},
    '{"showTimeLeft":true}'::jsonb)
  returning id`;

describe("the goal widget migration", () => {
  it("refuses a gauge before it", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'gauge', 0, 5, 3,
        3)`).rejects.toThrow(/dashboard_widgets_type_valid/);
  });

  it("keeps every widget and accepts a gauge naming a goal", async () => {
    const before = await snapshot();
    expect(before.length).toBe(5);

    await testDb.migrate();

    expect(await snapshot()).toEqual(before);
    const named = await owner`
      select id from dashboard_widgets where goal_id is not null`;
    expect(named.length).toBe(0);
    await gauge({ goal: goalId });
    // A gauge whose goal is gone (null) is valid too: the dashboard saves.
    await gauge({ goal: null, x: 3 });
  });

  it("refuses a goal on other types, a foreign goal and a binding", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, goal_id)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'clock', 6, 5, 2, 1,
        ${goalId})`).rejects.toThrow(/dashboard_widgets_goal_valid/);
    await expect(gauge({ goal: otherGoalId, x: 6 })).rejects.toThrow(
      /dashboard_widgets_goal_fk/,
    );
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, goal_id, connection_id, metric_key, aggregation,
        period)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'gauge', 6, 5, 3, 3,
        ${goalId}, ${connectionId}, 'visits', 'sum', 'today')`).rejects.toThrow(
      /dashboard_widgets_type_columns/,
    );
  });

  it("clears only goal_id when the goal is deleted", async () => {
    await owner`delete from goals where id = ${goalId}`;
    const gauges = await owner`
      select workspace_id, goal_id, options from dashboard_widgets
      where type = 'gauge' order by x`;
    expect(gauges).toEqual([
      {
        workspace_id: workspaceId,
        goal_id: null,
        options: { showTimeLeft: true },
      },
      {
        workspace_id: workspaceId,
        goal_id: null,
        options: { showTimeLeft: true },
      },
    ]);
  });
});
