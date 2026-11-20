import { createHash, randomUUID } from "node:crypto";
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

// The custom API item images migration (#809) on data in the previous
// shape: uploads and resource icons stay exactly as they were; afterwards a
// custom_api image may be up to 2 MiB (uploads stay 1 MiB), carries no
// connection or resource provenance, and its lookup rows go with it. The
// migration is found by its name, not its number, so a renumbering on merge
// does not touch this test.

const TAG_SUFFIX = "_custom_api_item_images";

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

const snapshot = () => owner`
  select id, origin, bytes, sha256, connection_id, resource_id
  from workspace_images order by id`;

function insertImage(fields: {
  origin: "upload" | "resource_icon" | "custom_api";
  bytes?: number;
  connectionId?: string | null;
  resourceId?: string | null;
}) {
  const content = Buffer.alloc(fields.bytes ?? 16, randomUUID());
  const sha256 = createHash("sha256").update(content).digest("hex");
  return owner`
    insert into workspace_images (workspace_id, name, content_type, bytes,
      width, height, sha256, content, origin, connection_id, resource_id)
    values (${workspaceId}, 'image', 'image/png', ${content.length}, 24, 16,
      ${sha256}, ${content}, ${fields.origin}, ${fields.connectionId ?? null},
      ${fields.resourceId ?? null})
    returning id`;
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  await owner`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)
              on conflict (id) do nothing`;
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Demo') returning id`;
  connectionId = connection!.id as string;
  // The previous shape: two uploads (one at the 1 MiB cap) and an icon.
  await insertImage({ origin: "upload" });
  await insertImage({ origin: "upload", bytes: 1_048_576 });
  await insertImage({
    origin: "resource_icon",
    connectionId,
    resourceId: "app-1",
  });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner.end({ timeout: 5 }).catch(() => undefined);
});

describe("the custom API item images migration", () => {
  it("refuses a custom_api image before it", async () => {
    await expectDbError(
      insertImage({ origin: "custom_api" }),
      /workspace_images_origin_valid/,
    );
  });

  it("keeps uploads and resource icons exactly as they were", async () => {
    const before = await snapshot();
    expect(before).toHaveLength(3);
    await testDb.migrate();
    expect(await snapshot()).toEqual(before);
  });

  it("allows a 2 MiB custom_api image and refuses a 2 MiB upload", async () => {
    await expect(
      insertImage({ origin: "custom_api", bytes: 2_097_152 }),
    ).resolves.toHaveLength(1);
    await expectDbError(
      insertImage({ origin: "upload", bytes: 2_097_152 }),
      /workspace_images_bytes_valid/,
    );
    await expectDbError(
      insertImage({ origin: "custom_api", bytes: 2_097_153 }),
      /workspace_images_bytes_valid/,
    );
  });

  it("refuses a custom_api image with connection or resource provenance", async () => {
    await expectDbError(
      insertImage({ origin: "custom_api", connectionId }),
      /workspace_images_origin_valid/,
    );
    await expectDbError(
      insertImage({ origin: "custom_api", resourceId: "app-1" }),
      /workspace_images_origin_valid/,
    );
  });

  it("deletes lookup rows with their image", async () => {
    const [image] = await insertImage({ origin: "custom_api" });
    const imageId = image!.id as string;
    await owner`
      insert into custom_api_item_images (workspace_id, url_sha256, image_id,
        last_seen_at)
      values (${workspaceId}, ${"a".repeat(64)}, ${imageId}, now())`;
    await owner`delete from workspace_images where id = ${imageId}`;
    const rows = await owner`
      select 1 from custom_api_item_images where image_id = ${imageId}`;
    expect(rows).toHaveLength(0);
  });

  it("indexes lookups by last_seen_at alone, for the instance-wide prune", async () => {
    const [row] = await owner`
      select indexdef from pg_indexes
      where indexname = 'custom_api_item_images_seen_idx'`;
    expect(row!.indexdef as string).toMatch(/\(last_seen_at\)$/);
  });

  it("enables and forces row level security on both new tables", async () => {
    const rows = await owner`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relname in ('custom_api_item_images', 'custom_api_stream_images')
      order by relname`;
    expect(rows).toEqual([
      {
        relname: "custom_api_item_images",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
      {
        relname: "custom_api_stream_images",
        relrowsecurity: true,
        relforcerowsecurity: true,
      },
    ]);
  });
});
