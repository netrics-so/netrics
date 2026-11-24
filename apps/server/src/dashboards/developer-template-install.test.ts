import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  schema,
  type Database,
  type Sql,
} from "@netrics/database";

import { createDefaultRegistry } from "../connectors.js";
import { syncCatalog } from "../sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_DROP_TIMEOUT_MS,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { createDeveloperTemplateService } from "./developer-template-service.js";
import { INSTALL_LOCK } from "./store-template-service.js";

/**
 * A Developer Portfolio install's statements and its place behind the
 * global install lock (#604, #660, #668), as the App Portfolio's: every
 * statement is waiting time for the next install in any workspace.
 */
let test: TestDatabase, db: Database, owner: Sql, holder: Sql, userId: string;
const statements: string[] = [];
const registry = createDefaultRegistry();
const CONNECTORS = [
  "railway",
  "vercel",
  "hetzner-cloud",
  "http-check",
  "posthog",
  "google-search-console",
  "app-store-connect",
  "google-play",
];

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl, {
    max: 1,
    onQuery: (query) => statements.push(query),
  });
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  holder = createRawSqlClient(test.appUrl, { max: 1 });
  const admin = createDatabase(test.adminUrl, { max: 1 });
  await syncCatalog(admin, registry);
  await admin.$client.end({ timeout: 5 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "developer-install@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await holder?.end({ timeout: 5 });
  await test?.drop();
}, TEST_DATABASE_DROP_TIMEOUT_MS);

/** A workspace with one set-up connection of every connector, in a project. */
async function workspace() {
  const id = await createWorkspace(db, {
    name: "Developer " + randomUUID().slice(0, 8),
    ownerUserId: userId,
  });
  const [project] = await owner<{ id: string }[]>`
    insert into projects (workspace_id, name) values (${id}, 'Shop')
    returning id`;
  const connections: string[] = [];
  for (const connectorId of CONNECTORS) {
    const [row] = await owner<{ id: string }[]>`
      insert into connections (workspace_id, connector_id, name, setup_pending, project_id)
      values (${id}, ${connectorId}, ${connectorId}, false, ${project!.id})
      returning id`;
    connections.push(row!.id);
    await owner`insert into connection_resources
        (connection_id, workspace_id, resource_id, name, kind)
      values (${row!.id}, ${id}, ${"r-" + connectorId}, ${connectorId}, 'project')`;
  }
  return { id, connections };
}
const actor = (workspaceId: string) => ({
  workspaceId,
  callerId: userId,
  locale: "en" as const,
});
const install = (
  w: { id: string; connections: string[] },
  options: { installLockTimeoutMs?: number } = {},
) =>
  createDeveloperTemplateService({ db, registry, ...options }).install(
    actor(w.id),
    {
      requestId: randomUUID(),
      name: "Developer Portfolio",
      connections: w.connections,
      links: [],
    },
  );
const reads = (sent: string[], table: string) =>
  sent.filter(
    (statement) =>
      statement.startsWith("select") && statement.includes(`from "${table}"`),
  ).length;

/** Runs `during` while another session holds the install lock. */
async function whileLocked<T>(
  during: () => Promise<T>,
  holdMs?: number,
): Promise<T> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  if (holdMs !== undefined) setTimeout(() => release(), holdMs);
  let locked!: () => void;
  const holding = new Promise<void>((resolve) => (locked = resolve));
  const held = holder.begin(async (tx) => {
    await tx.unsafe(
      `lock table data_template_installs in ${INSTALL_LOCK.mode} mode`,
    );
    locked();
    await released;
  });
  await holding;
  try {
    return await during();
  } finally {
    release();
    await held;
  }
}

describe("Developer Portfolio install statements", () => {
  it("sends at most 20 statements per template record and loads each table once", async () => {
    for (const name of ["First", "Second"]) {
      void name;
      const target = await workspace();
      statements.length = 0;
      const result = await install(target);
      const sent = [...statements];
      const [records] = await owner<{ n: number; preparations: number }[]>`
        select count(*)::int as n,
               count(*) filter (where kind = 'preparation')::int as preparations
        from data_template_records
        where workspace_id = ${target.id}
          and request_id = (select request_id from data_template_installs
            where workspace_id = ${target.id} and result->>'dashboardId' = ${result.dashboardId})`;
      expect(records!.n).toBeGreaterThan(20);
      expect(sent.length).toBeLessThanOrEqual(20 * records!.n);
      // The links and projects tables' rows: read once, by the first
      // preparation that reads them.
      expect(reads(sent, "data_records")).toBe(2);
      // Each published version read once, by its publication's second pass,
      // and once more by each of the overview's two state widgets (the
      // summary and the list, owner decision A) when the dashboard is saved.
      expect(reads(sent, "data_preparation_versions")).toBeLessThanOrEqual(
        records!.preparations + 2,
      );
    }
  }, 120_000);
});

describe("the install lock (#604, #660)", () => {
  it("waits its turn behind a running install", async () => {
    const w = await workspace();
    const holdMs = 3_000;
    const started = Date.now();
    const result = await whileLocked(() => install(w), holdMs);
    expect(Date.now() - started).toBeGreaterThanOrEqual(holdMs);
    expect(result).toMatchObject({ dashboardId: expect.any(String) });
  }, 60_000);

  it("answers 409 version_conflict when the lock stays held, after one bounded wait", async () => {
    const w = await workspace();
    const timeoutMs = 1_500;
    const started = Date.now();
    const error = await whileLocked(() =>
      install(w, { installLockTimeoutMs: timeoutMs }).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );
    const elapsed = Date.now() - started;
    expect(error).toMatchObject({ code: "version_conflict", status: 409 });
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
    expect(elapsed).toBeLessThan(2 * timeoutMs);
    await expect(install(w)).resolves.toMatchObject({
      dashboardId: expect.any(String),
    });
  }, 30_000);
});
