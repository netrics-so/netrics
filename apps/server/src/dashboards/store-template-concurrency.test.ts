import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  schema,
  type Database,
  type SerializationRetryOptions,
  type Sql,
} from "@netrics/database";

/**
 * Concurrent store-template installs in different workspaces (#604). A
 * serialization failure is never retried here, so a conflict between
 * installs fails the test instead of being retried away. Before #604, of 4
 * concurrent installs exactly one committed (the others: 40001, answered
 * 409 version_conflict once the retries ran out under load). Before #660,
 * the third and fourth answered 409 whenever one install took longer than
 * the 2 s lock wait (55P03, as on every run against a local Docker
 * Postgres).
 */
vi.mock("@netrics/database", async (original) => {
  const actual = await original<typeof import("@netrics/database")>();
  return {
    ...actual,
    retryOnSerializationFailure: <T>(
      attempt: (index: number) => Promise<T>,
      options: SerializationRetryOptions = {},
    ) =>
      actual.retryOnSerializationFailure(attempt, {
        ...options,
        retryable: (error, index) =>
          !actual.isSerializationFailure(error) &&
          (options.retryable?.(error, index) ?? false),
      }),
  };
});

import { createDefaultRegistry } from "../connectors.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { createStoreTemplateService } from "./store-template-service.js";

const WORKSPACES = 4;
let test: TestDatabase, db: Database, owner: Sql, userId: string;
const registry = createDefaultRegistry();
const workspaces: { id: string; connections: string[] }[] = [];

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl, { max: WORKSPACES * 2 });
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "store-concurrency@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
  for (let i = 0; i < WORKSPACES; i++) {
    const id = await createWorkspace(db, {
      name: "Stores " + i,
      ownerUserId: userId,
    });
    // The e2e journeys' two-connection install, stored as set up.
    const connections: string[] = [];
    for (const connectorId of ["app-store-connect", "google-play"]) {
      const [row] = await owner<{ id: string }[]>`
        insert into connections(workspace_id,connector_id,name,setup_pending)
        values (${id},${connectorId},${connectorId},false) returning id`;
      connections.push(row!.id);
    }
    workspaces.push({ id, connections });
  }
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});

const install = (workspace: { id: string; connections: string[] }) =>
  createStoreTemplateService({ db, registry }).install(
    { workspaceId: workspace.id, callerId: userId, locale: "en" },
    {
      requestId: randomUUID(),
      name: "App portfolio",
      connections: workspace.connections,
      groups: [],
    },
  );

describe("concurrent store-template installs (#604)", () => {
  it("install in four workspaces at once, each in one attempt", async () => {
    for (let round = 0; round < 3; round++) {
      const results = await Promise.allSettled(workspaces.map(install));
      expect(
        results.map((result) =>
          result.status === "fulfilled" ? "installed" : String(result.reason),
        ),
      ).toEqual(Array(WORKSPACES).fill("installed"));
    }
    const [row] = await owner<{ n: number }[]>`
        select count(distinct workspace_id)::int as n from data_template_installs`;
    expect(row!.n).toBe(WORKSPACES);
  }, 240_000); // 12 installs one at a time: ~0.7 s each on CI, 3-7.5 s locally.
});
