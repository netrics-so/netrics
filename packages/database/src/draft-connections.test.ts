import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import {
  findConnection,
  listConnectionIds,
  listConnections,
} from "./connections.js";
import { withWorkspace } from "./context.js";
import {
  DRAFT_CONNECTION_TTL_HOURS,
  pruneDraftConnections,
} from "./draft-connections.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Draft connections of the custom API builder (#806): pruned 24 hours after
// they were last touched, never a promoted one, only by the scheduler role;
// only custom-api drafts, without a pin; invisible to the connection reads.
// Fixed clock, far from the wall clock.
const NOW = new Date("2031-03-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = role;
  return url.toString();
}

let testDb: TestDatabase;
let owner: postgres.Sql;
let schedulerClient: postgres.Sql;
let appClient: postgres.Sql;
let schedulerDb: PostgresJsDatabase<typeof schema & typeof authSchema>;
let appDb: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceId: string;
let versionId: string;

async function insertConnection(input: {
  connectorId: string;
  status: "active" | "draft";
  updatedAt: Date;
  pinned?: boolean;
}): Promise<string> {
  const [row] = await owner`
    insert into connections (workspace_id, connector_id, name, status,
      updated_at, custom_api_definition_version_id, custom_api_environment_id)
    values (${workspaceId}, ${input.connectorId}, 'C', ${input.status},
      ${input.updatedAt.toISOString()}::timestamptz,
      ${input.pinned ? versionId : null},
      ${input.pinned ? "production" : null})
    returning id`;
  const id = row!.id as string;
  await owner`
    insert into connection_state (connection_id, workspace_id)
    values (${id}, ${workspaceId})`;
  return id;
}

const insertDraft = (connectorId = "custom-api", updatedAt = NOW) =>
  insertConnection({ connectorId, status: "draft", updatedAt });

async function ids(): Promise<string[]> {
  const rows = await owner`select id from connections order by id`;
  return rows.map((row) => row.id as string);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  schedulerClient = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
    max: 1,
  });
  appClient = postgres(testDb.appUrl, { max: 1 });
  schedulerDb = drizzle(schedulerClient, {
    schema: { ...schema, ...authSchema },
  });
  appDb = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  const [workspace] =
    await owner`insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb) on conflict (id) do nothing`;
  const [definition] = await owner`
    insert into custom_api_definitions (workspace_id, name, current_version)
    values (${workspaceId}, 'Shop', 1) returning id`;
  const [version] = await owner`
    insert into custom_api_definition_versions
      (workspace_id, definition_id, version, schema_version, document,
       document_sha256, dataset_versions)
    values (${workspaceId}, ${definition!.id}, 1, 1,
      ${owner.json({ schemaVersion: 1 })}, ${"a".repeat(64)},
      ${owner.json({})})
    returning id`;
  versionId = version!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await schedulerClient?.end({ timeout: 5 }).catch(() => undefined);
  await appClient?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

beforeEach(async () => {
  await owner`delete from connections`;
});

describe("pruneDraftConnections", () => {
  it("keeps drafts for 24 hours", () => {
    expect(DRAFT_CONNECTION_TTL_HOURS).toBe(24);
  });

  it("deletes drafts untouched for 24 hours and keeps younger drafts and active connections", async () => {
    const a = await insertDraft(
      "custom-api",
      new Date(NOW.getTime() - 25 * HOUR),
    );
    const b = await insertDraft(
      "custom-api",
      new Date(NOW.getTime() - 23 * HOUR),
    );
    const c = await insertConnection({
      connectorId: "custom-api",
      status: "active",
      updatedAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
      pinned: true,
    });
    const d = await insertConnection({
      connectorId: "demo",
      status: "active",
      updatedAt: new Date(NOW.getTime() - 30 * 24 * HOUR),
    });
    expect(await pruneDraftConnections(schedulerDb, NOW)).toBe(1);
    expect(await ids()).toEqual([b, c, d].sort());
    const state = await owner`
      select 1 from connection_state where connection_id = ${a}`;
    expect(state).toHaveLength(0);
  });

  it("never deletes a connection promoted after it was read as a draft", async () => {
    const a = await insertDraft(
      "custom-api",
      new Date(NOW.getTime() - 25 * HOUR),
    );
    await owner`
      update connections set status = 'active',
        custom_api_definition_version_id = ${versionId},
        custom_api_environment_id = 'production'
      where id = ${a}`;
    expect(await pruneDraftConnections(schedulerDb, NOW)).toBe(0);
    expect(await ids()).toEqual([a]);
  });

  it("deletes one batch per call", async () => {
    for (let i = 0; i < 3; i++)
      await insertDraft("custom-api", new Date(NOW.getTime() - 48 * HOUR));
    expect(await pruneDraftConnections(schedulerDb, NOW, 24, 2)).toBe(2);
    expect(await pruneDraftConnections(schedulerDb, NOW, 24, 2)).toBe(1);
    expect(await ids()).toEqual([]);
  });

  it("runs only as the scheduler role", async () => {
    await expect(
      appClient`select prune_draft_connections(now(), interval '1 hour', 10)`,
    ).rejects.toThrow(/permission denied/);
  });
});

describe("draft connection checks", () => {
  it("refuses a draft of a bundled connector", async () => {
    await expect(insertDraft("demo")).rejects.toThrow(
      /connections_draft_custom_api/,
    );
  });

  it("accepts a custom-api draft without a pin and refuses an active custom-api connection without one", async () => {
    const draftId = await insertDraft();
    await expect(
      owner`update connections set status = 'active' where id = ${draftId}`,
    ).rejects.toThrow(/connections_custom_api_pin/);
  });

  it("refuses a draft with a pin and an unknown status", async () => {
    await expect(
      insertConnection({
        connectorId: "custom-api",
        status: "draft",
        updatedAt: NOW,
        pinned: true,
      }),
    ).rejects.toThrow(/connections_custom_api_pin/);
    const demoId = await insertConnection({
      connectorId: "demo",
      status: "active",
      updatedAt: NOW,
    });
    await expect(
      owner`update connections set status = 'paused' where id = ${demoId}`,
    ).rejects.toThrow(/connections_status_valid/);
  });
});

describe("connection reads", () => {
  it("hide drafts unless asked for them", async () => {
    const draftId = await insertDraft();
    const activeId = await insertConnection({
      connectorId: "demo",
      status: "active",
      updatedAt: NOW,
    });
    await withWorkspace(appDb, { workspaceId }, async (tx) => {
      expect(await findConnection(tx, workspaceId, draftId)).toBeNull();
      expect(
        (
          await findConnection(tx, workspaceId, draftId, {
            includeDrafts: true,
          })
        )?.row.status,
      ).toBe("draft");
      expect(
        (await listConnections(tx, workspaceId)).map((c) => c.row.id),
      ).toEqual([activeId]);
      expect(await listConnectionIds(tx, workspaceId)).toEqual([activeId]);
    });
  });
});
