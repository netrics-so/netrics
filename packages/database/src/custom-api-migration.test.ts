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

// Custom API definitions (milestone 13, #803) on data in the previous shape:
// bundled connections keep working with an empty pin, the custom-api catalog
// row exists, the pin check holds, versions are immutable for the app role
// and both new tables are tenant-scoped. Found by its name, not its number.

const TAG_SUFFIX = "_custom_api_definitions";

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

const DOC = { schemaVersion: 1, name: "Shop" };
const SHA = "a".repeat(64);

let testDb: TestDatabase;
let owner: postgres.Sql;
let app: postgres.Sql;
let workspaceId: string;
let otherWorkspaceId: string;
let definitionId: string;
let versionId: string;
let otherVersionId: string;

async function insertDefinition(
  workspace: string,
): Promise<{ definition: string; version: string }> {
  const [definition] = await owner`
    insert into custom_api_definitions (workspace_id, name, current_version)
    values (${workspace}, 'Shop', 1) returning id`;
  const [version] = await owner`
    insert into custom_api_definition_versions
      (workspace_id, definition_id, version, schema_version, document,
       document_sha256, dataset_versions)
    values (${workspace}, ${definition!.id}, 1, 1, ${owner.json(DOC)},
      ${SHA}, ${owner.json({ daily_stats: 1 })})
    returning id`;
  return {
    definition: definition!.id as string,
    version: version!.id as string,
  };
}

function asApp<T>(
  workspace: string,
  run: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return app.begin(async (tx) => {
    await tx`select set_config('app.workspace_id', ${workspace}, true)`;
    return run(tx);
  }) as Promise<T>;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace, other] = await owner`
    insert into workspaces (name) values ('W'), ('Other') returning id`;
  workspaceId = workspace!.id as string;
  otherWorkspaceId = other!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb)
    on conflict (id) do nothing`;
  for (const name of ["Site", "Shop"]) {
    const [connection] = await owner`
      insert into connections (workspace_id, connector_id, name)
      values (${workspaceId}, 'demo', ${name}) returning id`;
    await owner`
      insert into connection_state (connection_id, workspace_id)
      values (${connection!.id}, ${workspaceId})`;
  }
  await testDb.migrate();
  app = postgres(testDb.appUrl, { max: 1, onnotice: () => undefined });
  ({ definition: definitionId, version: versionId } =
    await insertDefinition(workspaceId));
  ({ version: otherVersionId } = await insertDefinition(otherWorkspaceId));
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await app?.end({ timeout: 5 }).catch(() => undefined);
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the custom API definitions migration", () => {
  it("keeps bundled connections and leaves their pin empty", async () => {
    const rows = await owner`
      select connector_id, custom_api_definition_version_id,
        custom_api_environment_id
      from connections order by name`;
    expect(rows).toEqual([
      expect.objectContaining({
        connector_id: "demo",
        custom_api_definition_version_id: null,
        custom_api_environment_id: null,
      }),
      expect.objectContaining({
        connector_id: "demo",
        custom_api_definition_version_id: null,
        custom_api_environment_id: null,
      }),
    ]);
  });

  it("adds the custom-api catalog row", async () => {
    const [row] = await owner`
      select version, manifest from connectors where id = 'custom-api'`;
    expect(row).toEqual({
      version: "1.0.0",
      manifest: { id: "custom-api", name: "Custom API" },
    });
  });

  it("refuses a custom-api connection without a pin and a bundled one with a pin", async () => {
    await expect(
      owner`
        insert into connections (workspace_id, connector_id, name)
        values (${workspaceId}, 'custom-api', 'Unpinned')`,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "connections_custom_api_pin",
    });
    await expect(
      owner`
        insert into connections (workspace_id, connector_id, name,
          custom_api_definition_version_id, custom_api_environment_id)
        values (${workspaceId}, 'demo', 'Pinned', ${versionId}, 'production')`,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "connections_custom_api_pin",
    });
    await expect(
      owner`
        insert into connections (workspace_id, connector_id, name,
          custom_api_definition_version_id)
        values (${workspaceId}, 'custom-api', 'No environment', ${versionId})`,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "connections_custom_api_pin",
    });
    const [pinned] = await owner`
      insert into connections (workspace_id, connector_id, name,
        custom_api_definition_version_id, custom_api_environment_id)
      values (${workspaceId}, 'custom-api', 'Shop API', ${versionId}, 'production')
      returning id`;
    expect(pinned!.id).toEqual(expect.any(String));
  });

  it("refuses a pin to a version of another workspace", async () => {
    await expect(
      owner`
        insert into connections (workspace_id, connector_id, name,
          custom_api_definition_version_id, custom_api_environment_id)
        values (${workspaceId}, 'custom-api', 'Foreign', ${otherVersionId}, 'production')`,
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses invalid version numbers, documents and hashes", async () => {
    await expect(
      owner`
        insert into custom_api_definition_versions
          (workspace_id, definition_id, version, schema_version, document,
           document_sha256, dataset_versions)
        values (${workspaceId}, ${definitionId}, 0, 1, ${owner.json(DOC)},
          ${SHA}, '{}'::jsonb)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner`
        insert into custom_api_definition_versions
          (workspace_id, definition_id, version, schema_version, document,
           document_sha256, dataset_versions)
        values (${workspaceId}, ${definitionId}, 9, 1, '[1]'::jsonb,
          ${SHA}, '{}'::jsonb)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner`
        insert into custom_api_definition_versions
          (workspace_id, definition_id, version, schema_version, document,
           document_sha256, dataset_versions)
        values (${workspaceId}, ${definitionId}, 9, 1, ${owner.json(DOC)},
          'ABC', '{}'::jsonb)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      owner`
        insert into custom_api_definitions (workspace_id, name, current_version)
        values (${workspaceId}, 'Zero', 0)`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the app role insert and read but never update or delete a version", async () => {
    const inserted = await asApp(
      workspaceId,
      (tx) => tx`
        insert into custom_api_definition_versions
          (workspace_id, definition_id, version, schema_version, document,
           document_sha256, dataset_versions)
        values (${workspaceId}, ${definitionId}, 2, 1, ${tx.json(DOC)},
          ${SHA}, ${tx.json({ daily_stats: 1 })})
        returning version`,
    );
    expect(inserted.map((row) => row.version)).toEqual([2]);
    const read = await asApp(
      workspaceId,
      (tx) => tx`
        select version from custom_api_definition_versions
        where definition_id = ${definitionId} order by version`,
    );
    expect(read.map((row) => row.version)).toEqual([1, 2]);
    await expect(
      asApp(
        workspaceId,
        (tx) => tx`
          update custom_api_definition_versions set schema_version = 2
          where definition_id = ${definitionId}`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asApp(
        workspaceId,
        (tx) => tx`
          delete from custom_api_definition_versions
          where definition_id = ${definitionId}`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // Definitions are archived, never deleted.
    await expect(
      asApp(
        workspaceId,
        (tx) => tx`
          delete from custom_api_definitions where id = ${definitionId}`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const updated = await asApp(
      workspaceId,
      (tx) => tx`
        update custom_api_definitions set current_version = 2
        where id = ${definitionId} returning current_version`,
    );
    expect(updated.map((row) => row.current_version)).toEqual([2]);
  });

  it("hides definitions and versions of other workspaces under RLS", async () => {
    const seen = await asApp(otherWorkspaceId, async (tx) => ({
      definitions: await tx`select workspace_id from custom_api_definitions`,
      versions:
        await tx`select workspace_id from custom_api_definition_versions`,
    }));
    expect(seen.definitions.map((row) => row.workspace_id)).toEqual([
      otherWorkspaceId,
    ]);
    expect(seen.versions.map((row) => row.workspace_id)).toEqual([
      otherWorkspaceId,
    ]);
    await expect(
      asApp(
        otherWorkspaceId,
        (tx) => tx`
          insert into custom_api_definitions (workspace_id, name, current_version)
          values (${workspaceId}, 'Sneaky', 1)`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    const none = await app`select id from custom_api_definitions`;
    expect(none).toEqual([]);
  });
});
