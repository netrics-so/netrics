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

// The workspace images migration (#217) on data in the previous shape:
// studio dashboards with slides and widgets of every earlier type stay as
// they are, the new image columns start empty, and the image references
// hold within a workspace.

const LAST_BEFORE = "0034_studio_themes";

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

describe("workspace images migration on studio dashboards", () => {
  it("keeps dashboards, slides and widgets and adds empty image columns", async () => {
    const owner = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    try {
      await owner`insert into connectors (id, version, manifest) values
        ('c', '1.0.0', ${owner.json({ id: "c" })})`;
      const [workspace] =
        await owner`insert into workspaces (name) values ('W') returning id`;
      const workspaceId = workspace!.id as string;
      const [other] =
        await owner`insert into workspaces (name) values ('O') returning id`;
      const otherId = other!.id as string;
      const [connection] = await owner`
        insert into connections (workspace_id, connector_id, name)
        values (${workspaceId}, 'c', 'Apps') returning id`;
      const [dashboard] = await owner`
        insert into dashboards (workspace_id, name, auto_advance,
          theme_builtin, accent_color)
        values (${workspaceId}, 'Wurfel', false, 'paper', '#ff8800')
        returning id`;
      const dashboardId = dashboard!.id as string;
      const [slide] = await owner`
        insert into dashboard_slides
          (dashboard_id, workspace_id, position, name, duration_seconds)
        values (${dashboardId}, ${workspaceId}, 0, 'Sales', 30) returning id`;
      const slideId = slide!.id as string;
      await owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h, connection_id, metric_key, aggregation, period)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'metric',
          0, 0, 4, 3, ${connection!.id as string}, 'c.downloads', 'sum',
          'last_7_days')`;
      await owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h, text)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'text',
          4, 0, 2, 1, '## Hello')`;
      await owner`
        insert into dashboard_widgets (slide_id, dashboard_id, workspace_id,
          type, x, y, w, h)
        values (${slideId}, ${dashboardId}, ${workspaceId}, 'clock',
          6, 0, 2, 1)`;
      const before = await owner`
        select id, type, x, y, w, h, connection_id, metric_key, text, options
        from dashboard_widgets order by x`;

      await runMigrations(adminUrl);

      const after = await owner`
        select id, type, x, y, w, h, connection_id, metric_key, text, options,
               image_id
        from dashboard_widgets order by x`;
      expect(after.map(({ image_id: _, ...row }) => row)).toEqual([...before]);
      expect(after.map((row) => row.image_id)).toEqual([null, null, null]);
      const [slideAfter] = await owner`
        select name, duration_seconds, background_image_id, background_dim
        from dashboard_slides where id = ${slideId}`;
      expect({ ...slideAfter }).toEqual({
        name: "Sales",
        duration_seconds: 30,
        background_image_id: null,
        background_dim: 0,
      });
      const [dashboardAfter] = await owner`
        select name, auto_advance, theme_builtin, accent_color, logo_image_id
        from dashboards where id = ${dashboardId}`;
      expect({ ...dashboardAfter }).toEqual({
        name: "Wurfel",
        auto_advance: false,
        theme_builtin: "paper",
        accent_color: "#ff8800",
        logo_image_id: null,
      });

      const image = async (workspace: string) => {
        const content = Buffer.from("png");
        const [row] = await owner`
          insert into workspace_images (workspace_id, name, content_type,
            bytes, width, height, sha256, content)
          values (${workspace}, 'logo', 'image/png', ${content.length}, 1, 1,
            ${"a".repeat(64)}, ${content})
          returning id`;
        return row!.id as string;
      };
      const logo = await image(workspaceId);
      const foreign = await image(otherId);

      // References stay inside the workspace.
      await expect(
        owner`update dashboards set logo_image_id = ${foreign}
              where id = ${dashboardId}`,
      ).rejects.toThrow(/dashboards_logo_image_fk/);
      await owner`update dashboards set logo_image_id = ${logo}
                  where id = ${dashboardId}`;
      await owner`update dashboard_slides set background_image_id = ${logo},
                    background_dim = 40 where id = ${slideId}`;
      await expect(
        owner`update dashboard_slides set background_dim = 81
              where id = ${slideId}`,
      ).rejects.toThrow(/dashboard_slides_background_dim_valid/);
      // An image widget names an image; other widgets do not.
      await expect(
        owner`insert into dashboard_widgets (slide_id, dashboard_id,
                workspace_id, type, x, y, w, h)
              values (${slideId}, ${dashboardId}, ${workspaceId}, 'image',
                0, 4, 1, 1)`,
      ).rejects.toThrow(/dashboard_widgets_image_valid/);
      await expect(
        owner`insert into dashboard_widgets (slide_id, dashboard_id,
                workspace_id, type, x, y, w, h, image_id)
              values (${slideId}, ${dashboardId}, ${workspaceId}, 'clock',
                0, 4, 2, 1, ${logo})`,
      ).rejects.toThrow(/dashboard_widgets_image_valid/);
      await owner`insert into dashboard_widgets (slide_id, dashboard_id,
                    workspace_id, type, x, y, w, h, image_id)
                  values (${slideId}, ${dashboardId}, ${workspaceId}, 'image',
                    0, 4, 1, 1, ${logo})`;

      // A referenced image cannot be deleted ...
      await expect(
        owner`delete from workspace_images where id = ${logo}`,
      ).rejects.toThrow(/violates foreign key constraint/);
      // ... but its workspace can, with everything in it.
      await owner`delete from workspaces where id = ${workspaceId}`;
      const [left] = await owner`
        select (select count(*)::int from workspace_images) as images,
               (select count(*)::int from dashboards) as dashboards`;
      expect({ ...left }).toEqual({ images: 1, dashboards: 0 });
    } finally {
      await owner.end({ timeout: 5 });
    }
  });
});
