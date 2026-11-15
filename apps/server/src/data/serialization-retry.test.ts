import { inspect } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRawSqlClient,
  DatasetStoreError,
  isSerializationFailure,
  isTransactionHandle,
  SERIALIZATION_RETRY_DEFAULTS,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { sourceDatasetSchema } from "@netrics/contracts";
import {
  createTestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";
import { createDataService, type DataActor } from "./service.js";

/**
 * Serializable data transactions under conflicts (#598). A trigger on the
 * dataset store's page table raises serialization_failure (40001) for the
 * first `fail_first` page inserts of this suite's workspace, as a rival
 * transaction would. The failure comes from inside the dataset store, which
 * redacts database errors to dataset_storage_failed. Attempts are counted
 * with a sequence, which a rolled-back attempt does not reset.
 */
const definition = sourceDatasetSchema.parse({
  key: "conflicts",
  name: "Conflicts",
  version: 1,
  mode: "snapshot",
  grain: "One row",
  keyFields: ["id"],
  retentionDays: null,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "internal",
    },
  ],
});
let db: Database, admin: Sql, actor: DataActor;

beforeAll(async () => {
  const test = await createTestDatabase();
  db = createDatabase(test.appUrl);
  admin = createRawSqlClient(test.adminUrl, { max: 1 });
  const [user] =
    await admin`insert into users(email,display_name) values ('conflicts@example.com','Owner') returning id`;
  const [workspace] =
    await admin`insert into workspaces(name) values ('Conflicts') returning id`;
  actor = {
    workspaceId: workspace!.id as string,
    callerId: user!.id as string,
  };
  await admin`insert into memberships(workspace_id,user_id,role) values (${actor.workspaceId},${actor.callerId},'owner')`;
  await admin.unsafe(`
    create sequence conflict_test_attempts;
    create table conflict_test_state (fail_first int not null);
    insert into conflict_test_state values (0);
    create function conflict_test_fail() returns trigger
    language plpgsql security definer as $$
    begin
      if nextval('conflict_test_attempts') <= (select fail_first from conflict_test_state) then
        raise exception 'could not serialize access (test)' using errcode = '40001';
      end if;
      return new;
    end $$;
    create trigger conflict_test_fail before insert on data_pages
    for each row when (new.workspace_id = '${actor.workspaceId}')
    execute function conflict_test_fail();`);
}, TEST_DATABASE_SETUP_TIMEOUT_MS);
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
  await admin?.end({ timeout: 5 });
});

/** The next `count` page inserts fail; restarts the attempt count. */
async function failFirst(count: number) {
  await admin`update conflict_test_state set fail_first = ${count}`;
  await admin`alter sequence conflict_test_attempts restart`;
}
async function attempts(): Promise<number> {
  const [row] =
    await admin`select case when is_called then last_value else 0 end::int as n from conflict_test_attempts`;
  return row!.n as number;
}
let key = 0;
const save = (handle: Pick<Database, "transaction"> = db) =>
  createDataService(handle).saveManual(actor, {
    definition: { ...definition, key: "conflicts_" + key++ },
    records: [{ values: { id: "a" } }],
  });

describe("serializable data transactions under conflicts (#598)", () => {
  beforeEach(async () => {
    await failFirst(0);
  });

  it("retries a conflict the dataset store redacted, more often than three times", async () => {
    // Before #598: three attempts, and the store's dataset_storage_failed
    // hid the conflict from the retry, so the first one already failed.
    await failFirst(4);
    const saved = await save();
    expect(saved.datasetId).toEqual(expect.any(String));
    expect(await attempts()).toBe(5);
    const [row] =
      await admin`select count(*)::int as n from data_datasets where id = ${saved.datasetId}`;
    expect(row!.n).toBe(1);
  });

  it(
    "answers an exhausted conflict as version_conflict after a bounded number of attempts",
    async () => {
      await failFirst(1_000);
      await expect(save()).rejects.toMatchObject({
        code: "version_conflict",
        status: 409,
      });
      const tried = await attempts();
      expect(tried).toBeGreaterThan(3);
      expect(tried).toBeLessThanOrEqual(SERIALIZATION_RETRY_DEFAULTS.attempts);
      // Backoff waits up to the retry budget, past vitest's 5 s default.
    },
    SERIALIZATION_RETRY_DEFAULTS.budgetMs + 20_000,
  );

  it("runs once inside a caller's transaction and leaves the conflict to the caller's retry", async () => {
    // Store templates and compare measures compose the data service into
    // their own serializable transaction, which a conflict dooms.
    await failFirst(1);
    const error: unknown = await withWorkspace(
      db,
      { workspaceId: actor.workspaceId, userId: actor.callerId },
      (tx) => {
        expect(isTransactionHandle(tx)).toBe(true);
        return save(tx);
      },
      { isolationLevel: "serializable" },
    ).catch((caught: unknown) => caught);
    expect(isTransactionHandle(db)).toBe(false);
    expect(isSerializationFailure(error)).toBe(true);
    expect(await attempts()).toBe(1);
    // The store's redaction keeps only the SQLSTATE: the driver's message
    // (here the trigger's "could not serialize access (test)") is gone.
    const err = error as DatasetStoreError & { cause: Error };
    expect(err).toBeInstanceOf(DatasetStoreError);
    expect(err.code).toBe("dataset_storage_failed");
    expect(String(err.cause.message)).toBe("SQLSTATE 40001");
    const serialized = [
      inspect(err, { depth: 10 }),
      JSON.stringify(err, Object.getOwnPropertyNames(err)),
      JSON.stringify(err.cause, Object.getOwnPropertyNames(err.cause)),
    ].join("\n");
    expect(serialized).not.toContain("could not serialize");
  });
});
