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
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
  type TestDatabase,
} from "../test-db.js";
import {
  createStoreTemplateService,
  INSTALL_LOCK,
  INSTALL_LOCK_TIMEOUT_MS,
} from "./store-template-service.js";
import { createStoreTemplateUpdateService } from "./store-template-updates.js";
import {
  storeTemplate,
  type StoreTemplateDefinition,
} from "./store-template.js";

/**
 * The install lock (#604): installs run one at a time, but the lock blocks
 * nothing else, and a wait for it is bounded. A second session holds the
 * lock in the install's own mode, as a running install in another
 * workspace does.
 */
let test: TestDatabase, db: Database, owner: Sql, holder: Sql, userId: string;
const registry = createDefaultRegistry();
/** The same template under a newer version: an update with no choices. */
/** A newer version that renames the models' first measures. */
const next: StoreTemplateDefinition = {
  version: storeTemplate.version + 1,
  keys: (inputs) => storeTemplate.keys(inputs),
  build: (key, inputs, ids) => {
    const record = storeTemplate.build(key, inputs, ids);
    if (record.kind !== "model") return record;
    const definition = structuredClone(record.definition);
    const [measure] = definition.measures;
    if (measure) measure.name = `${measure.name} (next)`;
    return { ...record, definition };
  },
};

beforeAll(async () => {
  test = await createTestDatabase();
  db = createDatabase(test.appUrl, { max: 4 });
  owner = createRawSqlClient(test.adminUrl, { max: 1 });
  holder = createRawSqlClient(test.appUrl, { max: 1 });
  const [user] = await db
    .insert(schema.users)
    .values({ email: "install-lock@example.test", displayName: "Owner" })
    .returning();
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await owner?.end({ timeout: 5 });
  await holder?.end({ timeout: 5 });
});

async function workspace() {
  const id = await createWorkspace(db, {
    name: "Stores " + randomUUID().slice(0, 8),
    ownerUserId: userId,
  });
  const connections: string[] = [];
  for (const connectorId of ["app-store-connect", "google-play"]) {
    const [row] = await owner<{ id: string }[]>`
      insert into connections(workspace_id,connector_id,name,setup_pending)
      values (${id},${connectorId},${connectorId},false) returning id`;
    connections.push(row!.id);
  }
  return { id, connections };
}
const actor = (workspaceId: string) => ({
  workspaceId,
  callerId: userId,
  locale: "en" as const,
});
const install = (w: { id: string; connections: string[] }) =>
  createStoreTemplateService({ db, registry }).install(actor(w.id), {
    requestId: randomUUID(),
    name: "App portfolio",
    connections: w.connections,
    groups: [],
  });

/** Runs `during` while another session holds the install lock. */
async function whileLocked<T>(during: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
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

describe("the store-template install lock (#604)", () => {
  it("lets an update apply in another workspace run while an install holds it", async () => {
    const w = await workspace();
    const { requestId } = await (async () => {
      const requestId = randomUUID();
      await createStoreTemplateService({ db, registry }).install(actor(w.id), {
        requestId,
        name: "App portfolio",
        connections: w.connections,
        groups: [],
      });
      return { requestId };
    })();
    const updates = createStoreTemplateUpdateService({
      db,
      registry,
      template: next,
    });
    const plan = await updates.plan(actor(w.id), requestId);
    const started = Date.now();
    // Before: SHARE ROW EXCLUSIVE made the apply's write to
    // data_template_installs wait for the install to commit.
    const applied = await whileLocked(() =>
      Promise.race([
        updates
          .apply(actor(w.id), requestId, { basis: plan.basis, decisions: [] })
          .then(() => "applied"),
        new Promise((resolve) => setTimeout(() => resolve("waited"), 5_000)),
      ]),
    );
    expect(applied).toBe("applied");
    expect(Date.now() - started).toBeLessThan(5_000);
    const [row] = await owner<{ version: number }[]>`
      select template_version as version from data_template_installs
      where workspace_id = ${w.id} and request_id = ${requestId}`;
    expect(row!.version).toBe(next.version);
  }, 30_000);

  it("answers 409 version_conflict when the lock stays held, after bounded waits", async () => {
    const w = await workspace();
    const started = Date.now();
    const error = await whileLocked(() =>
      install(w).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );
    const elapsed = Date.now() - started;
    expect(error).toMatchObject({ code: "version_conflict", status: 409 });
    // Three waits of the lock timeout: the first attempt and two retries.
    expect(elapsed).toBeGreaterThanOrEqual(3 * INSTALL_LOCK_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(3 * INSTALL_LOCK_TIMEOUT_MS + 5_000);
    // Nothing was installed, and the workspace installs once the lock is free.
    await expect(install(w)).resolves.toMatchObject({
      dashboardId: expect.any(String),
    });
  }, 30_000);
});
