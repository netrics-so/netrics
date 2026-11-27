import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Migration 0099 (#928): a cursor stored before it is marked as a page
// checkpoint of an unfinished run only when the connection's latest run
// left exactly that checkpoint behind.

let test: TestDatabase, owner: postgres.Sql, workspaceId: string;

type Run = {
  status: "succeeded" | "failed" | "continued";
  cursorAfter: string | null;
  startedAt: string;
};

async function seed(
  name: string,
  cursor: string | null,
  runs: Run[],
): Promise<string> {
  const [connection] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'migration-mid-run',${name}) returning id`;
  const connectionId = connection!.id as string;
  await owner`insert into connection_state(connection_id,workspace_id,cursor) values (${connectionId},${workspaceId},${cursor})`;
  for (const run of runs)
    await owner`insert into sync_runs(workspace_id,connection_id,mode,requested_from,requested_to,cursor_after,attempt,status,started_at,finished_at,observations_written) values (${workspaceId},${connectionId},'incremental','2026-11-01','2026-11-02',${run.cursorAfter},1,${run.status},${run.startedAt},${run.startedAt},0)`;
  return connectionId;
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  test = await createTestDatabase({
    upTo: "0098_http_check_url_fragments_guard",
  });
  owner = postgres(test.adminUrl, { max: 1 });
  const [workspace] =
    await owner`insert into workspaces(name) values ('Existing') returning id`;
  workspaceId = workspace!.id as string;
  await owner`insert into connectors(id,version,manifest) values ('migration-mid-run','1.0.0','{}')`;
  ids.failed = await seed("failed", "page-2", [
    { status: "succeeded", cursorAfter: "round-1", startedAt: "2026-11-01" },
    { status: "failed", cursorAfter: "page-2", startedAt: "2026-11-02" },
  ]);
  ids.continued = await seed("continued", "page-3", [
    { status: "continued", cursorAfter: "page-3", startedAt: "2026-11-02" },
  ]);
  ids.succeededSince = await seed("succeeded since", "round-2", [
    { status: "failed", cursorAfter: "page-2", startedAt: "2026-11-01" },
    { status: "succeeded", cursorAfter: "round-2", startedAt: "2026-11-02" },
  ]);
  ids.failedWithoutPages = await seed("failed without pages", "round-1", [
    { status: "succeeded", cursorAfter: "round-1", startedAt: "2026-11-01" },
    { status: "failed", cursorAfter: null, startedAt: "2026-11-02" },
  ]);
  ids.noCursor = await seed("no cursor", null, [
    { status: "failed", cursorAfter: null, startedAt: "2026-11-02" },
  ]);
  ids.noRuns = await seed("no runs", "round-1", []);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });
afterAll(async () => {
  await owner?.end({ timeout: 5 });
});

it("marks only cursors that the latest run left as its checkpoint", async () => {
  const before =
    await owner`select connection_id, cursor from connection_state order by connection_id`;
  await test.migrate();
  const after =
    await owner`select connection_id, cursor, cursor_mid_run from connection_state order by connection_id`;
  // The cursors themselves stay as they were.
  expect(
    after.map(({ connection_id, cursor }) => ({ connection_id, cursor })),
  ).toEqual(
    before.map(({ connection_id, cursor }) => ({ connection_id, cursor })),
  );
  const midRun = Object.fromEntries(
    after.map((row) => [row.connection_id as string, row.cursor_mid_run]),
  );
  expect(
    Object.fromEntries(
      Object.entries(ids).map(([name, id]) => [name, midRun[id]]),
    ),
  ).toEqual({
    failed: true,
    continued: true,
    succeededSince: false,
    failedWithoutPages: false,
    noCursor: false,
    noRuns: false,
  });
  // New rows start without the marker.
  const [connection] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'migration-mid-run','new') returning id`;
  const [state] =
    await owner`insert into connection_state(connection_id,workspace_id,cursor) values (${connection!.id as string},${workspaceId},'round-1') returning cursor_mid_run`;
  expect(state!.cursor_mid_run).toBe(false);
});
