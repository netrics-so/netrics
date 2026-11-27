import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Migration 0099 (#928): a cursor stored before it is marked as a page
// checkpoint of an unfinished run unless the connection's latest succeeded
// run stored it as its final cursor.

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
  // Page 2 checkpointed, then the run failed.
  ids.failed = await seed("failed", "page-2", [
    { status: "succeeded", cursorAfter: "round-1", startedAt: "2026-11-01" },
    { status: "failed", cursorAfter: "page-2", startedAt: "2026-11-02" },
  ]);
  // Attempt A checkpointed page 2 and failed; retry B failed before a page.
  ids.retryChain = await seed("retry chain", "page-2", [
    { status: "succeeded", cursorAfter: "round-1", startedAt: "2026-11-01" },
    { status: "failed", cursorAfter: "page-2", startedAt: "2026-11-02" },
    { status: "failed", cursorAfter: null, startedAt: "2026-11-03" },
  ]);
  // The first run ever committed a page and its worker died: no run row.
  ids.deadWorker = await seed("dead worker", "page-2", []);
  // A later run's worker died after a page: the last success is older.
  ids.deadWorkerAfterSuccess = await seed(
    "dead worker after a success",
    "page-2",
    [{ status: "succeeded", cursorAfter: "round-1", startedAt: "2026-11-01" }],
  );
  ids.continued = await seed("continued", "page-3", [
    { status: "continued", cursorAfter: "page-3", startedAt: "2026-11-02" },
  ]);
  // Completed incremental connections: a succeeded run, skipped ones
  // included, stores the same final cursor in both places.
  ids.completed = await seed("completed", "round-2", [
    { status: "succeeded", cursorAfter: "round-1", startedAt: "2026-11-01" },
    { status: "succeeded", cursorAfter: "round-2", startedAt: "2026-11-02" },
  ]);
  ids.succeededSince = await seed("succeeded since", "round-2", [
    { status: "failed", cursorAfter: "page-2", startedAt: "2026-11-01" },
    { status: "succeeded", cursorAfter: "round-2", startedAt: "2026-11-02" },
  ]);
  ids.failedWithoutPages = await seed("failed without pages", "round-1", [
    { status: "succeeded", cursorAfter: "round-1", startedAt: "2026-11-01" },
    { status: "failed", cursorAfter: null, startedAt: "2026-11-02" },
  ]);
  // A run that ended with no cursor leaves nothing to resume.
  ids.noCursor = await seed("no cursor", null, [
    { status: "succeeded", cursorAfter: null, startedAt: "2026-11-01" },
    { status: "failed", cursorAfter: null, startedAt: "2026-11-02" },
  ]);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

// The test applies the remaining migrations.
vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });
afterAll(async () => {
  await owner?.end({ timeout: 5 });
});

it("marks every cursor that is not the latest success's final cursor", async () => {
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
    retryChain: true,
    deadWorker: true,
    deadWorkerAfterSuccess: true,
    continued: true,
    completed: false,
    succeededSince: false,
    failedWithoutPages: false,
    noCursor: false,
  });
  // New rows start without the marker.
  const [connection] =
    await owner`insert into connections(workspace_id,connector_id,name) values (${workspaceId},'migration-mid-run','new') returning id`;
  const [state] =
    await owner`insert into connection_state(connection_id,workspace_id,cursor) values (${connection!.id as string},${workspaceId},'round-1') returning cursor_mid_run`;
  expect(state!.cursor_mid_run).toBe(false);
});
