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

// The per-stream record summary (#834 review) on data in the previous
// shape: a connection with an image summary stays as it was (a custom
// API connection needs a pinned definition; the tables only need a row),
// the new table starts empty, is tenant-scoped for netrics_app and goes
// with its connection. Found by its name, not its number.

const TAG_SUFFIX = "_custom_api_stream_records";

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

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  const [other] = await owner`
    insert into workspaces (name) values ('Other') returning id`;
  otherWorkspaceId = other!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb)
    on conflict (id) do nothing`;
  const [connection] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', 'Images') returning id`;
  connectionId = connection!.id as string;
  await owner`
    insert into custom_api_stream_images
      (workspace_id, connection_id, stream_key, checked_at, stored,
       unchanged, skipped, skipped_reasons)
    values (${workspaceId}, ${connectionId}, 'records', now(), 5, 1, 2,
      '{"host_not_allowed": 2}'::jsonb)`;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the custom API stream records migration", () => {
  it("keeps the image summary, starts empty and is tenant-scoped", async () => {
    await testDb.migrate();
    expect(
      await owner`
        select stream_key, stored, unchanged, skipped, skipped_reasons
        from custom_api_stream_images`,
    ).toEqual([
      {
        stream_key: "records",
        stored: 5,
        unchanged: 1,
        skipped: 2,
        skipped_reasons: { host_not_allowed: 2 },
      },
    ]);
    expect(await owner`select * from custom_api_stream_records`).toEqual([]);

    const app = postgres(testDb.appUrl, { max: 1, onnotice: () => undefined });
    try {
      await app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
        await tx`
          insert into custom_api_stream_records
            (workspace_id, connection_id, stream_key, checked_at, skipped,
             skipped_fields)
          values (${workspaceId}, ${connectionId}, 'records', now(), 3,
            '{"prompt": 3}'::jsonb)`;
      });
      const seen = await app.begin(async (tx) => {
        await tx`select set_config('app.workspace_id', ${otherWorkspaceId}, true)`;
        return tx`select * from custom_api_stream_records`;
      });
      expect(seen).toEqual([]);
    } finally {
      await app.end({ timeout: 5 });
    }
    await expect(
      owner`
        insert into custom_api_stream_records
          (workspace_id, connection_id, stream_key, checked_at, skipped)
        values (${workspaceId}, ${connectionId}, 'other', now(), -1)`,
    ).rejects.toThrow(/custom_api_stream_records_counts_valid/);
    await owner`delete from connections where id = ${connectionId}`;
    expect(await owner`select * from custom_api_stream_records`).toEqual([]);
  });
});
