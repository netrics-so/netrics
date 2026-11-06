import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Migration 0037 (#275, ADR 0017) on data in the previous shape: tile
// dashboards migrated by 0033 and studio dashboards with several slides come
// out as 16x9 dashboards with no custom layouts and unchanged placements.

const TILES_SHAPE = "0032_longer_periods";
const LAST_BEFORE = "0036_i18n_locales";

let testDb: TestDatabase;
let owner: postgres.Sql;
let workspaceId: string;
let tileDashboard: string;
let studioDashboard: string;

/** Applies the migrations up to and including `lastTag`. */
async function migrateTo(adminUrl: string, lastTag: string): Promise<void> {
  const copy = mkdtempSync(path.join(tmpdir(), "netrics-migrations-"));
  try {
    cpSync(migrationsFolder, copy, { recursive: true });
    const journalPath = path.join(copy, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
    expect(last).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, last + 1);
    writeFileSync(journalPath, JSON.stringify(journal));
    const client = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(drizzle(client), { migrationsFolder: copy });
    } finally {
      await client.end({ timeout: 5 });
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

const snapshot = () => owner`
  select d.id as dashboard, s.position as slide, s.name, w.id, w.type,
         w.x, w.y, w.w, w.h
  from dashboards d
  join dashboard_slides s on s.dashboard_id = d.id
  left join dashboard_widgets w on w.slide_id = s.id
  order by d.name, s.position, w.y, w.x`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: TILES_SHAPE });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)`;
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Demo') returning id`;
  const connectionId = connection!.id as string;

  // A tile dashboard of 18 tiles (two slides after 0033).
  const [tiles] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspaceId}, 'A tiles') returning id`;
  tileDashboard = tiles!.id as string;
  for (let position = 0; position < 18; position++) {
    await owner`
      insert into dashboard_tiles (dashboard_id, workspace_id, connection_id,
        metric_key, aggregation, period, position)
      values (${tileDashboard}, ${workspaceId}, ${connectionId}, 'visits',
        'sum', 'last_7_days', ${position})`;
  }
  await migrateTo(testDb.adminUrl, LAST_BEFORE);

  // A studio dashboard with three slides, one of them empty.
  const [studio] = await owner`
    insert into dashboards (workspace_id, name, show_header)
    values (${workspaceId}, 'B studio', false) returning id`;
  studioDashboard = studio!.id as string;
  const slides = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position, name)
    values (${studioDashboard}, ${workspaceId}, 0, 'Sales'),
           (${studioDashboard}, ${workspaceId}, 1, 'Brand'),
           (${studioDashboard}, ${workspaceId}, 2, null)
    returning id, position`;
  const slide = (position: number) =>
    slides.find((row) => row.position === position)!.id as string;
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period)
    values
      (${slide(0)}, ${studioDashboard}, ${workspaceId}, 'metric', 0, 0, 3, 2,
       ${connectionId}, 'visits', 'sum', 'today'),
      (${slide(0)}, ${studioDashboard}, ${workspaceId}, 'line', 3, 0, 9, 8,
       ${connectionId}, 'visits', 'sum', 'last_30_days')`;
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, text)
    values
      (${slide(1)}, ${studioDashboard}, ${workspaceId}, 'text', 0, 0, 12, 1,
       'Hello'),
      (${slide(1)}, ${studioDashboard}, ${workspaceId}, 'clock', 10, 7, 2, 1,
       null)`;
}, 60_000);

afterAll(async () => {
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

describe("migration 0037 on studio and migrated tile dashboards", () => {
  it("makes every dashboard 16x9 with no custom layouts, placements unchanged", async () => {
    const before = await snapshot();
    expect(before.length).toBe(18 + 4 + 1);

    await testDb.migrate();

    expect(await snapshot()).toEqual(before);
    const dashboards = await owner`
      select id, primary_format from dashboards order by name`;
    expect(dashboards.map((row) => ({ ...row }))).toEqual([
      { id: tileDashboard, primary_format: "16x9" },
      { id: studioDashboard, primary_format: "16x9" },
    ]);
    const [layouts] = await owner`
      select (select count(*)::int from dashboard_slide_layouts) as slides,
             (select count(*)::int from dashboard_widget_layouts) as widgets`;
    expect({ ...layouts }).toEqual({ slides: 0, widgets: 0 });
  });

  it("puts both new tables under forced row level security with policies", async () => {
    const tables = await owner`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid)
               as policies,
             has_table_privilege('netrics_app', c.oid, 'select, insert, update, delete')
               as granted
      from pg_class c
      where c.relname in ('dashboard_slide_layouts', 'dashboard_widget_layouts')
      order by c.relname`;
    expect(tables.map((row) => ({ ...row }))).toEqual([
      {
        relname: "dashboard_slide_layouts",
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 4,
        granted: true,
      },
      {
        relname: "dashboard_widget_layouts",
        relrowsecurity: true,
        relforcerowsecurity: true,
        policies: 4,
        granted: true,
      },
    ]);
  });

  it("checks the primary format and relaxes the widget grid to 16 × 14", async () => {
    await expect(
      owner`update dashboards set primary_format = '16x10'
            where id = ${studioDashboard}`,
    ).rejects.toThrow(/dashboards_primary_format_valid/);
    await owner`update dashboards set primary_format = '9x16'
                where id = ${studioDashboard}`;
    const [slide] = await owner`
      select id from dashboard_slides
      where dashboard_id = ${studioDashboard} and position = 2`;
    // A 9x16 primary places widgets on rows 8–13.
    await owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h)
      values (${slide!.id}, ${studioDashboard}, ${workspaceId}, 'clock',
        0, 12, 2, 2)`;
    await expect(
      owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h)
        values (${slide!.id}, ${studioDashboard}, ${workspaceId}, 'clock',
          15, 0, 2, 1)`,
    ).rejects.toThrow(/dashboard_widgets_grid_valid/);
  });
});
