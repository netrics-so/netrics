import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationsFolder } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// The latest-review widget's migration (#340, ADR 0019 sections 2 and 12)
// on data in the previous shape: every stored widget keeps satisfying the
// checks, and afterwards `review` is accepted with a connection (an
// optional resource filter and app icon) and no metric, and refused
// otherwise. The migration is found by its name, not its number, so a
// renumbering on merge does not touch this test.

const TAG_SUFFIX = "_review_widget";

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
let imageId: string;

const snapshot = () => owner`
  select type, x, y, w, h, connection_id, metric_key, aggregation, period,
         text, image_id, dimensions, options
  from dashboard_widgets order by y, x`;

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors (id, version, manifest)
              values ('app-store-connect', '1.0.0',
                      '{"id":"app-store-connect"}'::jsonb)`;
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'app-store-connect', 'Apps') returning id`;
  connectionId = connection!.id as string;
  const [image] = await owner`
    insert into workspace_images (workspace_id, name, content_type, bytes,
      width, height, sha256, content)
    values (${workspaceId}, 'icon', 'image/png', 3, 1, 1, ${"a".repeat(64)},
      '\\x000102'::bytea) returning id`;
  imageId = image!.id as string;
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspaceId}, 'Studio') returning id`;
  dashboardId = dashboard!.id as string;
  const [slide] = await owner`
    insert into dashboard_slides (dashboard_id, workspace_id, position)
    values (${dashboardId}, ${workspaceId}, 0) returning id`;
  slideId = slide!.id as string;

  // Every type of the previous shape.
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, connection_id, metric_key, aggregation, period, options)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'metric', 0, 0, 3, 2,
       ${connectionId}, 'downloads', 'sum', 'today', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'line', 3, 0, 4, 3,
       ${connectionId}, 'downloads', 'sum', 'last_30_days', '{}'::jsonb),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'table', 7, 0, 4, 4,
       ${connectionId}, 'downloads', 'sum', 'last_7_days',
       '{"groupBy":"territory","limit":5}'::jsonb)`;
  await owner`
    insert into dashboard_widgets (slide_id, dashboard_id, workspace_id, type,
      x, y, w, h, text, image_id)
    values
      (${slideId}, ${dashboardId}, ${workspaceId}, 'text', 0, 4, 6, 1,
       'Hello', null),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'clock', 6, 4, 2, 1,
       null, null),
      (${slideId}, ${dashboardId}, ${workspaceId}, 'image', 8, 4, 2, 2,
       null, ${imageId})`;
}, 60_000);

afterAll(async () => {
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

describe("the review widget migration", () => {
  it("refuses a review before it", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'review', 0, 5, 4, 3,
        ${connectionId})`).rejects.toThrow(
      /dashboard_widgets_type_(valid|columns)/,
    );
  });

  it("keeps every widget and accepts a review with a connection", async () => {
    const before = await snapshot();
    expect(before.length).toBe(6);

    await testDb.migrate();

    expect(await snapshot()).toEqual(before);
    await owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, dimensions, image_id, options)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'review', 0, 5, 4, 3,
        ${connectionId}, '{"resource":"123"}'::jsonb, ${imageId},
        '{"minRating":4,"requireText":true,"showAuthor":false}'::jsonb)`;
    await owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'review', 4, 5, 4, 3,
        ${connectionId})`;
    const reviews = await owner`
      select dimensions, image_id, options from dashboard_widgets
      where type = 'review' order by x`;
    expect(reviews.map((row) => row.dimensions)).toEqual([
      { resource: "123" },
      {},
    ]);
    expect(reviews[0]!.image_id).toBe(imageId);
    expect(reviews[1]!.image_id).toBeNull();
  });

  it("refuses a review without a connection, with a metric or text", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'review', 8, 6, 4,
        2)`).rejects.toThrow(/dashboard_widgets_type_columns/);
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, metric_key, aggregation, period)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'review', 8, 6, 4, 2,
        ${connectionId}, 'downloads', 'sum', 'today')`).rejects.toThrow(
      /dashboard_widgets_type_columns/,
    );
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, connection_id, text)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'review', 8, 6, 4, 2,
        ${connectionId}, 'x')`).rejects.toThrow(
      /dashboard_widgets_type_columns/,
    );
  });

  it("still refuses an image on other types and an image widget without one", async () => {
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h, image_id)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'clock', 8, 6, 2, 1,
        ${imageId})`).rejects.toThrow(/dashboard_widgets_image_valid/);
    await expect(owner`
      insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
        type, x, y, w, h)
      values (${slideId}, ${dashboardId}, ${workspaceId}, 'image', 8, 6, 2,
        1)`).rejects.toThrow(/dashboard_widgets_image_valid/);
  });

  it("deletes a review with its connection", async () => {
    await owner`delete from connections where id = ${connectionId}`;
    const [row] = await owner`
      select count(*)::int as n from dashboard_widgets where type = 'review'`;
    expect(row!.n).toBe(0);
  });
});
