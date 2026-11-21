import { randomBytes, randomUUID } from "node:crypto";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ConnectorRegistry } from "@netrics/connector-runtime";
import { DEFAULT_DATA_POLICY } from "@netrics/domain";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
import { CUSTOM_API_MESSAGES } from "@netrics/connectors/custom-api";
import {
  FIXTURE_SECRETS,
  fixtureDefinition,
  startCustomApiFixtureServer,
  type CustomApiFixtureServer,
  type FixtureDefinitionName,
} from "@netrics/connectors/custom-api/testing";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  insertConnection,
  insertCustomApiDefinition,
  schema,
  withWorkspace,
  type Database,
  type Job,
  type Sql,
} from "@netrics/database";

import { createCredentialKeyring, encryptCredentials } from "../credentials.js";
import { canonicalSha256 } from "../custom-api/canonical-json.js";
import { createDataService } from "../data/service.js";
import {
  ContinueJobError,
  createJobHandlers,
  DeferJobError,
} from "../jobs/handlers.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "../test-db.js";

// The custom-api connector on the real sync engine and egress (ADR 0027):
// a pinned definition is resolved per connection, runs through the
// custom API egress values against the https fixture server, and its
// refusals and safety limits land in the run's error class.

vi.setConfig({ testTimeout: 60_000 });

const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
// Bundled connectors only: custom-api is resolved per connection.
const registry = new ConnectorRegistry();

let fixture: CustomApiFixtureServer;
let testDb: TestDatabase;
let appDb: Database;
let schedulerDb: Database;
let owner: Sql;
let workspaceId: string;

function definition(name: FixtureDefinitionName): CustomApiDefinition {
  return fixtureDefinition(name, fixture.origin);
}

/** Stores the definition (version 1) and returns its version row. */
async function storeDefinition(
  document: CustomApiDefinition,
  datasetVersions: Record<string, number>,
) {
  const definitionId = randomUUID();
  return withWorkspace(appDb, { workspaceId }, async (tx) => {
    const stored = await insertCustomApiDefinition(tx, workspaceId, {
      id: definitionId,
      projectId: null,
      name: document.name,
      createdBy: null,
      document: document as unknown as Record<string, unknown>,
      documentSha256: canonicalSha256(document),
      schemaVersion: 1,
      datasetVersions,
    });
    return stored.version;
  });
}

async function connect(
  document: CustomApiDefinition,
  credentials: Record<string, unknown> | null,
  datasetVersions: Record<string, number> = Object.fromEntries(
    document.streams.map((stream) => [stream.key, 1]),
  ),
): Promise<string> {
  const version = await storeDefinition(document, datasetVersions);
  const connectionId = randomUUID();
  await withWorkspace(appDb, { workspaceId }, (tx) =>
    insertConnection(tx, {
      id: connectionId,
      workspaceId,
      connectorId: "custom-api",
      name: document.name,
      config: {},
      credentialsEncrypted: credentials
        ? Buffer.from(
            encryptCredentials(
              JSON.stringify({
                host: `127.0.0.1:${fixture.port}`,
                ...credentials,
              }),
              KEYRING,
              { workspaceId, connectionId },
            ),
          )
        : null,
      projectId: null,
      pollIntervalSeconds: 3600,
      customApi: {
        definitionVersionId: version.id,
        environmentId: "production",
      },
    }),
  );
  return connectionId;
}

/** One attempt of a job; answers the error it ended with, if any. */
async function attempt(
  kind: "connection.sync" | "connection.backfill",
  connectionId: string,
  job: {
    id: string;
    attempts: number;
    continuation?: Record<string, unknown> | undefined;
    pagesPerRun?: number;
  },
): Promise<unknown> {
  const handler = createJobHandlers({
    registry,
    credentialKeyring: KEYRING,
    executeOptions: {
      egress: { tlsCa: fixture.ca!, allowPrivateHosts: ["127.0.0.1"] },
    },
    ...(job.pagesPerRun
      ? {
          dataPolicy: {
            ...DEFAULT_DATA_POLICY,
            syncPagesPerRun: job.pagesPerRun,
          },
        }
      : {}),
  })[kind]!;
  try {
    await handler({
      job: {
        id: job.id,
        kind,
        workspaceId,
        connectionId,
        attempts: job.attempts,
        payload: {
          workspace_id: workspaceId,
          connection_id: connectionId,
          ...(job.continuation ? { continuation: job.continuation } : {}),
        },
      } as unknown as Job,
      appDb,
      schedulerDb,
      logger: pino({ level: "silent" }),
    });
    return undefined;
  } catch (error) {
    return error;
  }
}

/** One job, continued (same job id and window) until it ends. */
async function run(
  kind: "connection.sync" | "connection.backfill",
  connectionId: string,
  options: { pagesPerRun?: number } = {},
): Promise<unknown> {
  const jobId = randomUUID();
  let continuation: Record<string, unknown> | undefined;
  for (let n = 0; n < 10; n++) {
    const error = await attempt(kind, connectionId, {
      id: jobId,
      attempts: n,
      continuation,
      ...options,
    });
    if (!(error instanceof ContinueJobError)) return error;
    continuation = error.continuation;
  }
  throw new Error("job did not end");
}

async function lastRun(connectionId: string) {
  const [row] = await owner<
    {
      status: string;
      error_class: string | null;
      error_message: string | null;
    }[]
  >`
    select status, error_class, error_message from sync_runs
    where connection_id = ${connectionId} and status <> 'continued'
    order by started_at desc, finished_at desc limit 1`;
  return row!;
}

async function authState(connectionId: string): Promise<string> {
  const [row] = await owner<{ auth_state: string }[]>`
    select auth_state from connection_state where connection_id = ${connectionId}`;
  return row!.auth_state;
}

async function stored(connectionId: string) {
  return owner<{ id: string; schema_version: number }[]>`
    select r.values->>'id' as id, g.schema_version
    from data_records r
    join data_generations g on g.id = r.generation_id
    join data_datasets d on d.id = g.dataset_id
    where d.connection_id = ${connectionId}
    order by (r.values->>'id')::integer`;
}

beforeAll(async () => {
  fixture = await startCustomApiFixtureServer({ tls: true });
  testDb = await createTestDatabase();
  appDb = createDatabase(testDb.appUrl);
  const schedulerUrl = new URL(testDb.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  schedulerDb = createDatabase(schedulerUrl.toString());
  owner = createRawSqlClient(testDb.adminUrl, { max: 1 });
  const [user] = await appDb
    .insert(schema.users)
    .values({ email: "custom-api@example.com", displayName: "Owner" })
    .returning({ id: schema.users.id });
  workspaceId = await createWorkspace(appDb, {
    name: "Custom API",
    ownerUserId: user!.id,
  });
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await appDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await schedulerDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
  await fixture?.close();
});

describe("custom-api on the sync engine", () => {
  it("backfills a page-number stream into its dataset with the pinned dataset version", async () => {
    const connectionId = await connect(definition("pages"), null, { items: 3 });
    expect(await run("connection.backfill", connectionId)).toBeUndefined();
    expect(await lastRun(connectionId)).toMatchObject({ status: "succeeded" });
    const rows = await stored(connectionId);
    expect(rows.map((row) => Number(row.id))).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(new Set(rows.map((row) => row.schema_version))).toEqual(
      new Set([3]),
    );
    expect(await authState(connectionId)).toBe("ok");
    // Datasets are named by stream: the listing prefixes the connection's
    // name, so two connections can be told apart (#834).
    const [user] = await owner<{ id: string }[]>`
      select id from users where email = 'custom-api@example.com'`;
    const { sources } = await createDataService(appDb).listSources({
      workspaceId,
      callerId: user!.id,
    });
    expect(
      sources.find((source) => source.connectionId === connectionId)?.name,
    ).toBe(
      `${definition("pages").name} · ${definition("pages").streams[0]!.name}`,
    );
    // The connection page lists its own datasets only (#834 review).
    const other = await connect(definition("pages"), null, { items: 3 });
    expect(await run("connection.backfill", other)).toBeUndefined();
    const own = await createDataService(appDb).listSources(
      { workspaceId, callerId: user!.id },
      {},
      { connectionId },
    );
    expect(own.sources.map((source) => source.connectionId)).toEqual([
      connectionId,
    ]);
    expect(own.sources[0]!.name).toBe(
      sources.find((source) => source.connectionId === connectionId)?.name,
    );
  });

  it("keeps the last sync's skipped records per stream, by field path (#834 review)", async () => {
    const connectionId = await connect(definition("bad_values"), null);
    expect(await run("connection.backfill", connectionId)).toBeUndefined();
    expect(await lastRun(connectionId)).toMatchObject({ status: "succeeded" });
    const summary = async () =>
      owner<{ stream_key: string; skipped: number; skipped_fields: unknown }[]>`
        select stream_key, skipped, skipped_fields
        from custom_api_stream_records where connection_id = ${connectionId}`;
    expect(await summary()).toEqual([
      { stream_key: "values", skipped: 1, skipped_fields: { id: 1 } },
    ]);
    // The next sync replaces it, not adds to it.
    expect(await run("connection.sync", connectionId)).toBeUndefined();
    expect(await summary()).toEqual([
      { stream_key: "values", skipped: 1, skipped_fields: { id: 1 } },
    ]);
  });

  describe("skipped records over several pages (#834 re-review)", () => {
    const summary = async (connectionId: string) =>
      owner<{ skipped: number; skipped_fields: unknown }[]>`
        select skipped, skipped_fields from custom_api_stream_records
        where connection_id = ${connectionId}`;
    const all = [{ skipped: 3, skipped_fields: { id: 3 } }];

    it("adds up a run continued page by page", async () => {
      const connectionId = await connect(definition("bad_pages"), null);
      expect(
        await run("connection.backfill", connectionId, { pagesPerRun: 1 }),
      ).toBeUndefined();
      expect(await summary(connectionId)).toEqual(all);
      // The last job read only the empty page: its time is still the
      // summary's, so the card's "… ago" is the run's (#834 re-review 2).
      const [times] = await owner<{ checked: Date; started: Date }[]>`
        select
          (select checked_at from custom_api_stream_records
            where connection_id = ${connectionId}) as checked,
          (select max(started_at) from sync_runs
            where connection_id = ${connectionId}) as started`;
      expect(times!.checked).toEqual(times!.started);
      // A new sync starts over.
      expect(await run("connection.sync", connectionId)).toBeUndefined();
      expect(await summary(connectionId)).toEqual(all);
    });

    it("keeps the pages before a rate limit and adds the resumed rest", async () => {
      const connectionId = await connect(definition("bad_pages"), null);
      fixture.failPageOnce(2, 429);
      const jobId = randomUUID();
      const limited = await attempt("connection.backfill", connectionId, {
        id: jobId,
        attempts: 0,
      });
      expect(limited).toBeInstanceOf(DeferJobError);
      expect(await summary(connectionId)).toEqual([
        { skipped: 1, skipped_fields: { id: 1 } },
      ]);
      // The provider's reset has passed.
      await owner`
        update connection_state set rate_limited_until = null
        where connection_id = ${connectionId}`;
      expect(
        await attempt("connection.backfill", connectionId, {
          id: jobId,
          attempts: 1,
          continuation: (limited as DeferJobError).continuation,
        }),
      ).toBeUndefined();
      expect(await summary(connectionId)).toEqual(all);
    });

    it("counts a retried attempt once: it reads the stream again from the start", async () => {
      const connectionId = await connect(definition("bad_pages"), null);
      fixture.failPageOnce(2, 503);
      const jobId = randomUUID();
      expect(
        await attempt("connection.backfill", connectionId, {
          id: jobId,
          attempts: 0,
        }),
      ).toBeInstanceOf(Error);
      expect(
        await attempt("connection.backfill", connectionId, {
          id: jobId,
          attempts: 1,
        }),
      ).toBeUndefined();
      expect(await summary(connectionId)).toEqual(all);
    });
  });

  it("marks the connection auth_failed with the 401 message", async () => {
    const connectionId = await connect(definition("api_key_header"), {
      apiKey: "wrong-key-1234",
    });
    await run("connection.sync", connectionId);
    expect(await lastRun(connectionId)).toMatchObject({
      status: "failed",
      error_class: "auth",
      error_message: CUSTOM_API_MESSAGES.unauthorized,
    });
    expect(await authState(connectionId)).toBe("auth_failed");
  });

  it("ends a run at the page limit with error class budget and keeps committed rows", async () => {
    fixture.reset();
    const connectionId = await connect(definition("endless"), null);
    await run("connection.backfill", connectionId);
    expect(await lastRun(connectionId)).toMatchObject({
      status: "failed",
      error_class: "budget",
      error_message: CUSTOM_API_MESSAGES.pageLimit,
    });
    // 200 pages over three job attempts (100 pages per attempt by the
    // data policy), each attempt after its credential check.
    expect(
      fixture.requests.filter((request) => request.query.cursor !== undefined),
    ).toHaveLength(199);
    expect(fixture.requests).toHaveLength(203);
    expect(await authState(connectionId)).toBe("ok");
  });

  it("keeps snapshot rows when a run stops at a limit and continues next run", async () => {
    const pages = definition("pages");
    const snapshot: CustomApiDefinition = {
      ...pages,
      streams: [{ ...pages.streams[0]!, mode: "snapshot" }],
    };
    const connectionId = await connect(snapshot, null);
    expect(await run("connection.sync", connectionId)).toBeUndefined();
    expect(await stored(connectionId)).toHaveLength(25);

    // The same stream, now endless: pinned to another version.
    const endless = await storeDefinition(definition("endless"), { items: 1 });
    await owner`
      update connections set custom_api_definition_version_id = ${endless.id}
      where id = ${connectionId}`;
    // Pins of another definition are refused by the composite key only
    // per definition, so the test moves the pin by hand.
    fixture.reset();
    await run("connection.sync", connectionId);
    expect(await lastRun(connectionId)).toMatchObject({
      error_class: "budget",
    });
    // No deletion is inferred from the partial refresh.
    expect(await stored(connectionId)).toHaveLength(25);
    // The next run starts the stream again (no cursor on its first page).
    fixture.reset();
    await owner`
      update connection_state set last_success_at = now() - interval '2 hours'
      where connection_id = ${connectionId}`;
    await run("connection.sync", connectionId);
    const pageRequests = fixture.requests.filter(
      (request) => request.path === "/edge/endless",
    );
    expect(pageRequests[1]!.query.cursor).toBeUndefined();
    expect(await stored(connectionId)).toHaveLength(25);
  });

  it("refuses to follow a redirect to another host and sends no credentials there", async () => {
    fixture.reset();
    const base = definition("redirect_off_host");
    const bearer: CustomApiDefinition = {
      ...base,
      auth: { type: "bearer", headerName: "Authorization", prefix: "Bearer" },
    };
    const connectionId = await connect(bearer, {
      token: FIXTURE_SECRETS.token,
    });
    await run("connection.sync", connectionId);
    expect((await lastRun(connectionId)).status).toBe("failed");
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(
      fixture.requests.every((request) =>
        request.host.startsWith("127.0.0.1:"),
      ),
    ).toBe(true);
  });

  it("never stores a secret in sync_runs.error_message", async () => {
    const connectionId = await connect(definition("api_key_query_400"), {
      apiKey: FIXTURE_SECRETS.apiKey,
    });
    await run("connection.sync", connectionId);
    const failed = await lastRun(connectionId);
    expect(failed.status).toBe("failed");
    expect(failed.error_message).toContain("HTTP 400");
    expect(failed.error_message).toContain("api_key=[redacted]");
    const all = await owner<{ error_message: string | null }[]>`
      select error_message from sync_runs where workspace_id = ${workspaceId}`;
    for (const { error_message } of all) {
      expect(error_message ?? "").not.toContain(FIXTURE_SECRETS.apiKey);
      expect(error_message ?? "").not.toContain(FIXTURE_SECRETS.token);
    }
  });
});
