import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The goals migration (#335, ADR 0019 section 4) on data in the previous
// shape: existing workspaces, connections and widgets stay as they are;
// afterwards goals are stored under RLS, tied to a connection of their own
// workspace, and refused outside their checks. The migration is found by
// its name, not its number, so a renumbering on merge does not touch this
// test.

const TAG_SUFFIX = "_goals";

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
let app: postgres.Sql;
let workspaceId: string;
let otherWorkspaceId: string;
let connectionId: string;
let otherConnectionId: string;

const widgets = () => owner`
  select type, connection_id, metric_key, aggregation, period, options
  from dashboard_widgets order by x`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  app = postgres(testDb.appUrl, { max: 1, onnotice: () => undefined });
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
  const [slide] = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position)
    values (${dashboard!.id}, ${workspaceId}, 0) returning id`;
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period, options)
    values
      (${slide!.id}, ${dashboard!.id}, ${workspaceId}, 'metric', 0, 0, 3, 2,
       ${connectionId}, 'visits', 'sum', 'this_month', '{}'::jsonb),
      (${slide!.id}, ${dashboard!.id}, ${workspaceId}, 'table', 3, 0, 4, 4,
       ${connectionId}, 'visits', 'sum', 'this_week',
       '{"groupBy":"route","limit":5}'::jsonb)`;
}, 60_000);

afterAll(async () => {
  await app.end({ timeout: 5 }).catch(() => undefined);
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

const goal = (fields: Record<string, unknown> = {}) => ({
  workspace_id: workspaceId,
  name: "Monthly downloads",
  connection_id: connectionId,
  metric_key: "visits",
  aggregation: "sum",
  period: "this_month",
  target: 15_000,
  ...fields,
});

describe("the goals migration", () => {
  it("keeps every widget and adds the goals table under RLS", async () => {
    const before = await widgets();
    expect(before.length).toBe(2);

    await testDb.migrate();

    expect(await widgets()).toEqual(before);
    const [table] = await owner`
      select relrowsecurity, relforcerowsecurity from pg_class
      where relname = 'goals'`;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const policies = await owner`
      select policyname from pg_policies where tablename = 'goals'
      order by policyname`;
    expect(policies.map((row) => row.policyname)).toEqual([
      "goals_delete",
      "goals_insert",
      "goals_select",
      "goals_update",
    ]);
  });

  it("stores a goal and refuses one outside its checks", async () => {
    await owner`insert into goals ${owner(goal())}`;
    const [stored] = await owner`
      select dimensions, display_currency, version, target from goals`;
    expect(stored).toEqual({
      dimensions: {},
      display_currency: null,
      version: 1,
      target: 15_000,
    });
    for (const [fields, check] of [
      [{ name: "monthly DOWNLOADS" }, /goals_name_unique/],
      [{ name: "" }, /goals_name_valid/],
      [{ name: "x".repeat(61) }, /goals_name_valid/],
      [{ name: "Avg", aggregation: "avg" }, /goals_aggregation_valid/],
      [{ name: "Rolling", period: "last_30_days" }, /goals_period_valid/],
      [{ name: "Zero", target: 0 }, /goals_target_valid/],
      [{ name: "Huge", target: 2e15 }, /goals_target_valid/],
      // A connection of another workspace never fits.
      [
        { name: "Foreign", connection_id: otherConnectionId },
        /goals_connection_fk/,
      ],
    ] as const) {
      await expect(
        owner`insert into goals ${owner(goal(fields))}`,
      ).rejects.toThrow(check);
    }
    // The same name in another workspace is fine.
    await owner`insert into goals ${owner(
      goal({
        workspace_id: otherWorkspaceId,
        connection_id: otherConnectionId,
      }),
    )}`;
  });

  it("shows netrics_app the goals of its workspace only", async () => {
    const visible = (workspace: string) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${workspace}, true)`;
        return tx`select workspace_id from goals`;
      });
    expect((await visible(workspaceId)).map((r) => r.workspace_id)).toEqual([
      workspaceId,
    ]);
    expect(
      (await visible(otherWorkspaceId)).map((r) => r.workspace_id),
    ).toEqual([otherWorkspaceId]);
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx`insert into goals ${tx(
          goal({
            name: "Sneaky",
            workspace_id: otherWorkspaceId,
            connection_id: otherConnectionId,
          }),
        )}`;
      }),
    ).rejects.toThrow(/row-level security/);
  });

  it("deletes a connection's goals with it", async () => {
    await owner`delete from connections where id = ${connectionId}`;
    const left = await owner`select workspace_id from goals`;
    expect(left.map((row) => row.workspace_id)).toEqual([otherWorkspaceId]);
  });
});
