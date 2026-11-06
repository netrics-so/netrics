import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationsFolder, createDatabase, withWorkspace } from "./index.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";
import { sql } from "drizzle-orm";
let test: TestDatabase,
  owner: postgres.Sql,
  workspaceId: string,
  dashboardId: string,
  slideId: string,
  foreignModelId: string;
beforeAll(async () => {
  const journal = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith("_dashboard_measures"),
  );
  test = await createTestDatabase({ upTo: journal.entries[at - 1]!.tag });
  owner = postgres(test.adminUrl, { max: 1 });
  const [workspace] =
    await owner`insert into workspaces (name) values ('Existing') returning id`;
  workspaceId = workspace!.id as string;
  const [foreign] =
    await owner`insert into workspaces (name) values ('Other tenant') returning id`;
  const [model] =
    await owner`insert into data_models (workspace_id, name, definition) values (${foreign!.id}, 'Foreign', '{}'::jsonb) returning id`;
  foreignModelId = model!.id as string;
  const [dashboard] =
    await owner`insert into dashboards (workspace_id, name) values (${workspaceId}, 'Existing dashboard') returning id`;
  dashboardId = dashboard!.id as string;
  const [slide] =
    await owner`insert into dashboard_slides (dashboard_id, workspace_id, position) values (${dashboardId}, ${workspaceId}, 0) returning id`;
  slideId = slide!.id as string;
  await owner`insert into dashboard_widgets (dashboard_id, slide_id, workspace_id, type, x, y, w, h, text) values (${dashboardId}, ${slideId}, ${workspaceId}, 'text', 0, 0, 4, 2, 'Keep me')`;
}, 60000);
afterAll(async () => {
  await owner?.end({ timeout: 5 });
});
describe("measure widget migration on populated data", () => {
  it("preserves old widgets and defaults, then enforces tenant-aware model references", async () => {
    const [before] =
      await owner`select type,text,options,dimensions from dashboard_widgets where dashboard_id=${dashboardId}`;
    await test.migrate();
    const [after] =
      await owner`select type,text,options,dimensions from dashboard_widgets where dashboard_id=${dashboardId}`;
    expect(after).toEqual(before);
    const [settings] =
      await owner`select data_filters from dashboards where id=${dashboardId}`;
    expect(settings!.data_filters).toEqual([]);
    const db = createDatabase(test.appUrl);
    try {
      await expect(
        withWorkspace(db, { workspaceId }, (tx) =>
          tx.execute(
            sql`insert into dashboard_widgets (dashboard_id, slide_id, workspace_id, type, x, y, w, h, model_id, model_binding) values (${dashboardId}, ${slideId}, ${workspaceId}, 'measure', 4, 0, 4, 3, ${foreignModelId}, ${JSON.stringify({ modelId: foreignModelId, measureIds: ["income"], groupBy: [], exclusions: [] })}::jsonb)`,
          ),
        ),
      ).rejects.toThrow();
      const ownModel = await withWorkspace(db, { workspaceId }, async (tx) => {
        const result = await tx.execute(
          sql`insert into data_models (workspace_id, name, definition) values (${workspaceId}, 'Own', '{}'::jsonb) returning id`,
        );
        return result[0]!.id as string;
      });
      await withWorkspace(db, { workspaceId }, (tx) =>
        tx.execute(
          sql`insert into dashboard_widgets (dashboard_id, slide_id, workspace_id, type, x, y, w, h, model_id, model_binding) values (${dashboardId}, ${slideId}, ${workspaceId}, 'measure', 4, 0, 4, 3, ${ownModel}, ${JSON.stringify({ modelId: ownModel, measureIds: ["income"], groupBy: [], exclusions: [] })}::jsonb)`,
        ),
      );
      const [stored] =
        await owner`select model_id from dashboard_widgets where type='measure'`;
      expect(stored!.model_id).toBe(ownModel);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
  });
});
