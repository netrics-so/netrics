import { readFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { migrationsFolder } from "./index.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Slide scope and slide logo (#707) on data in the previous shape: every
// existing slide keeps its fields, gets no scope and no logo of its own,
// and a slide logo must be an image of the slide's workspace. Found by its
// name, not its number, so a renumbering on merge does not touch this test.

const TAG_SUFFIX = "_slide_scope_logo";

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
let slideId: string;
let imageId: string;
let otherImageId: string;

async function image(workspace: string): Promise<string> {
  const [row] = await owner`
    insert into workspace_images
      (workspace_id, name, content_type, bytes, width, height, sha256, content, origin)
    values (${workspace}, 'logo.png', 'image/png', 1, 1, 1,
      ${"a".repeat(64)}, ${Buffer.from([0])}, 'upload')
    returning id`;
  return row!.id as string;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [other] = await owner`
    insert into workspaces (name) values ('Other') returning id`;
  otherWorkspaceId = other!.id as string;
  const [dashboard] = await owner`
    insert into dashboards (workspace_id, name)
    values (${workspaceId}, 'Portfolio') returning id`;
  imageId = await image(workspaceId);
  otherImageId = await image(otherWorkspaceId);
  const [slide] = await owner`
    insert into dashboard_slides
      (dashboard_id, workspace_id, position, name, background_image_id, background_dim)
    values (${dashboard!.id as string}, ${workspaceId}, 0, 'Sales', ${imageId}, 40)
    returning id`;
  slideId = slide!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the slide scope and logo migration", () => {
  it("keeps existing slides, without a scope or a logo of their own", async () => {
    await testDb.migrate();
    const [row] = await owner`
      select name, background_image_id, background_dim, logo_image_id, scope
      from dashboard_slides where id = ${slideId}`;
    expect(row).toEqual({
      name: "Sales",
      background_image_id: imageId,
      background_dim: 40,
      logo_image_id: null,
      scope: {},
    });
  });

  it("takes a logo of the slide's workspace only", async () => {
    await owner`
      update dashboard_slides set logo_image_id = ${imageId},
        scope = ${owner.json({ app: { kind: "values", values: ["a"] } })}
      where id = ${slideId}`;
    await expect(
      owner`update dashboard_slides set logo_image_id = ${otherImageId}
        where id = ${slideId}`,
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      owner`update dashboard_slides set scope = '[]'::jsonb
        where id = ${slideId}`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
