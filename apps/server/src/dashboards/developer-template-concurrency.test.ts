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
 * Concurrent Developer Portfolio installs in different workspaces, beside
 * App Portfolio installs (#604): a serialization failure is never retried
 * here, so a conflict between installs fails the test instead of being
 * retried away. Both templates queue behind the one install lock.
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
import { syncCatalog } from "../sync/catalog.js";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import { createDeveloperTemplateService } from "./developer-template-service.js";
import { createStoreTemplateService } from "./store-template-service.js";

const WORKSPACES = 4;
let test: TestDatabase, db: Database, owner: Sql, userId: string;
const registry = createDefaultRegistry();
const workspaces: { id: string; developer: string[]; stores: string[] }[] = [];

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl, { max: WORKSPACES * 2 });
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  const admin = createDatabase(test.adminUrl, { max: 1 });
  await syncCatalog(admin, registry);
  await admin.$client.end({ timeout: 5 });
  const [user] = await db
    .insert(schema.users)
    .values({
      email: "developer-concurrency@example.test",
      displayName: "Owner",
    })
    .returning();
  userId = user!.id;
  for (let i = 0; i < WORKSPACES; i++) {
    const id = await createWorkspace(db, {
      name: "Developer " + i,
      ownerUserId: userId,
    });
    const add = async (connectorId: string) => {
      const [row] = await owner<{ id: string }[]>`
        insert into connections(workspace_id,connector_id,name,setup_pending)
        values (${id},${connectorId},${connectorId},false) returning id`;
      return row!.id;
    };
    const stores = [await add("app-store-connect"), await add("google-play")];
    const developer = [
      await add("railway"),
      await add("vercel"),
      await add("posthog"),
      ...stores,
    ];
    workspaces.push({ id, developer, stores });
  }
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
});

const actor = (workspaceId: string) => ({
  workspaceId,
  callerId: userId,
  locale: "en" as const,
});

describe("concurrent Developer Portfolio installs (#604)", () => {
  it("install in four workspaces at once, beside App Portfolio installs, each in one attempt", async () => {
    for (let round = 0; round < 2; round++) {
      const results = await Promise.allSettled(
        workspaces.flatMap((workspace) => [
          createDeveloperTemplateService({ db, registry }).install(
            actor(workspace.id),
            {
              requestId: randomUUID(),
              name: "Developer Portfolio",
              connections: workspace.developer,
              links: [],
            },
          ),
          createStoreTemplateService({ db, registry }).install(
            actor(workspace.id),
            {
              requestId: randomUUID(),
              name: "App portfolio",
              connections: workspace.stores,
              groups: [],
            },
          ),
        ]),
      );
      expect(
        results.map((result) =>
          result.status === "fulfilled" ? "installed" : String(result.reason),
        ),
      ).toEqual(Array(WORKSPACES * 2).fill("installed"));
    }
    const [row] = await owner<{ n: number }[]>`
      select count(*)::int as n from data_template_installs
      where template_id = 'developer_portfolio'`;
    expect(row!.n).toBe(WORKSPACES * 2);
  }, 240_000);
});
