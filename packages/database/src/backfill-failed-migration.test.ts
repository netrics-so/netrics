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

// A backfill that ended without reading its window (#787) on data in the
// previous shape: connections whose latest backfill attempt failed, or
// whose latest backfill job died, are marked; those with a known history
// start, a backfill that only waited for a rate limit, or no backfill at
// all are not. Found by its name, not its number.

const TAG_SUFFIX = "_backfill_failed_at";

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
const c: Record<string, string> = {};

async function connection(
  name: string,
  historyFrom: string | null = null,
): Promise<string> {
  const [row] = await owner`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'demo', ${name}) returning id`;
  const id = row!.id as string;
  await owner`
    insert into connection_state (connection_id, workspace_id, history_from)
    values (${id}, ${workspaceId}, ${historyFrom})`;
  return id;
}

async function run(
  connectionId: string,
  mode: "backfill" | "incremental",
  status: "succeeded" | "failed" | "continued",
  startedAt: string,
  errorClass: "transient" | "auth" | "rate_limited" | null = null,
) {
  const finishedAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  await owner`
    insert into sync_runs
      (workspace_id, connection_id, mode, requested_from, requested_to,
       attempt, status, started_at, finished_at, error_class)
    values (${workspaceId}, ${connectionId}, ${mode},
      '2025-11-01T00:00:00Z', ${startedAt}, 1, ${status}, ${startedAt},
      ${finishedAt}, ${errorClass})`;
}

async function backfillJob(
  connectionId: string,
  status: "pending" | "succeeded" | "failed" | "dead",
  createdAt: string,
  lastError: string | null = null,
) {
  await owner`
    insert into jobs
      (kind, workspace_id, connection_id, status, created_at, last_error)
    values ('connection.backfill', ${workspaceId}, ${connectionId}, ${status},
      ${createdAt}, ${lastError})`;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ upTo: lastBefore() });
  owner = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  const [workspace] = await owner`
    insert into workspaces (name) values ('W') returning id`;
  workspaceId = workspace!.id as string;
  await owner`
    insert into connectors (id, version, manifest)
    values ('demo', '0.1.0', '{}'::jsonb)
    on conflict (id) do nothing`;

  // The first backfill read a few months, then died with its retries used
  // up; incremental syncs have succeeded since. Its job is pruned already.
  c.died = await connection("Died");
  await run(c.died, "backfill", "continued", "2026-08-01T00:00:00Z");
  await run(c.died, "backfill", "failed", "2026-08-01T01:00:00Z", "transient");
  await run(c.died, "backfill", "failed", "2026-08-01T02:00:00Z", "transient");
  await run(c.died, "incremental", "succeeded", "2026-11-12T00:00:00Z");

  // A complete history: the latest backfill succeeded.
  c.read = await connection("Read", "2025-11-01T00:00:00Z");
  await run(c.read, "backfill", "failed", "2026-10-01T00:00:00Z", "auth");
  await run(c.read, "backfill", "succeeded", "2026-10-02T00:00:00Z");
  await run(c.read, "incremental", "succeeded", "2026-11-12T00:00:00Z");

  // A reload that failed after an earlier complete backfill.
  c.reloadFailed = await connection("Reload failed");
  await run(c.reloadFailed, "backfill", "succeeded", "2026-10-01T00:00:00Z");
  await run(
    c.reloadFailed,
    "backfill",
    "failed",
    "2026-11-01T00:00:00Z",
    "auth",
  );

  // Waiting for a provider's rate limit is no failure (#781) …
  c.rateLimited = await connection("Rate limited", "2025-11-01T00:00:00Z");
  await run(c.rateLimited, "backfill", "succeeded", "2026-10-01T00:00:00Z");
  await run(
    c.rateLimited,
    "backfill",
    "failed",
    "2026-11-01T00:00:00Z",
    "rate_limited",
  );
  // … and does not hide the failure before it.
  c.failedThenLimited = await connection("Failed, then rate limited");
  await run(
    c.failedThenLimited,
    "backfill",
    "failed",
    "2026-11-01T00:00:00Z",
    "transient",
  );
  await run(
    c.failedThenLimited,
    "backfill",
    "failed",
    "2026-11-01T01:00:00Z",
    "rate_limited",
  );

  // Never backfilled, or its runs are pruned: unknown, not failed.
  c.none = await connection("None");
  await run(c.none, "incremental", "succeeded", "2026-11-12T00:00:00Z");

  // The job died without a failed run (a worker that stopped mid-run).
  c.lostWorker = await connection("Lost worker");
  await backfillJob(
    c.lostWorker,
    "dead",
    "2026-11-10T00:00:00Z",
    "stale lock requeued",
  );
  // A waiting backfill superseded by a newer one did not fail.
  c.superseded = await connection("Superseded");
  await backfillJob(
    c.superseded,
    "failed",
    "2026-11-10T00:00:00Z",
    "superseded by a newer backfill",
  );
  // A dead job older than a succeeded backfill whose job is pruned: the
  // history start is known.
  c.deadThenRead = await connection("Dead, then read", "2025-11-01T00:00:00Z");
  await backfillJob(c.deadThenRead, "dead", "2026-11-01T00:00:00Z", "boom");
  // A dead job followed by a newer backfill that still waits.
  c.deadThenQueued = await connection("Dead, then queued");
  await backfillJob(c.deadThenQueued, "dead", "2026-11-01T00:00:00Z", "boom");
  await backfillJob(c.deadThenQueued, "pending", "2026-11-02T00:00:00Z");
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

vi.setConfig({ testTimeout: TEST_DATABASE_SETUP_TIMEOUT_MS });

afterAll(async () => {
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
});

describe("the backfill-failed migration", () => {
  it("marks the connections whose last backfill ended without reading its window", async () => {
    await testDb.migrate();
    const rows = await owner`
      select connection_id, backfill_failed_at, history_from
      from connection_state`;
    const of = (id: string) =>
      rows.find((row) => row.connection_id === id)!
        .backfill_failed_at as Date | null;
    // The latest failed attempt's end.
    expect(of(c.died!)?.toISOString()).toBe("2026-08-01T02:01:00.000Z");
    expect(of(c.reloadFailed!)?.toISOString()).toBe("2026-11-01T00:01:00.000Z");
    expect(of(c.failedThenLimited!)?.toISOString()).toBe(
      "2026-11-01T00:01:00.000Z",
    );
    expect(of(c.lostWorker!)?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(of(c.read!)).toBeNull();
    expect(of(c.rateLimited!)).toBeNull();
    expect(of(c.none!)).toBeNull();
    expect(of(c.superseded!)).toBeNull();
    expect(of(c.deadThenRead!)).toBeNull();
    expect(of(c.deadThenQueued!)).toBeNull();
    // Nothing else moved.
    expect(
      rows
        .filter((row) => row.history_from !== null)
        .map((r) => r.connection_id)
        .sort(),
    ).toEqual([c.read!, c.rateLimited!, c.deadThenRead!].sort());
  });
});
