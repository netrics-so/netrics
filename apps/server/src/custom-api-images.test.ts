import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";

import pino from "pino";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { connectionDetailResponseSchema } from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { CustomApiDefinition } from "@netrics/connector-sdk/custom-api";
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
  findConnection,
  insertConnection,
  insertCustomApiDefinition,
  insertImageWithinQuota,
  schema,
  withWorkspace,
  type Database,
  type ImageQuota,
  type Job,
  type Sql,
} from "@netrics/database";

import { createCredentialKeyring, encryptCredentials } from "./credentials.js";
import { createConnectionService } from "./connections/service.js";
import { canonicalSha256 } from "./custom-api/canonical-json.js";
import { callOptionsFor, connectorFor } from "./custom-api/connectors.js";
import {
  ingestCustomApiImages,
  itemImageUrlHash,
} from "./images/custom-api-images.js";
import { ContinueJobError, createJobHandlers } from "./jobs/handlers.js";
import { createOAuthProviders } from "./oauth/config.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Custom API item images (#809) on the real sync engine and egress: after a
// succeeded sync, the newest 3 photos' images are copied into the workspace
// (origin custom_api), deduplicated by URL hash and by content, within their
// own quota, with credentials only on the API host, and every image that is
// not stored counted on its stream without failing the run.

vi.setConfig({ testTimeout: 60_000 });

const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
const registry = new ConnectorRegistry();

let fixture: CustomApiFixtureServer;
let testDb: TestDatabase;
let appDb: Database;
let schedulerDb: Database;
let owner: Sql;
let userId: string;
let workspaceId: string;

function definition(name: FixtureDefinitionName): CustomApiDefinition {
  return fixtureDefinition(name, fixture.origin);
}

async function connect(
  document: CustomApiDefinition,
  credentials: Record<string, unknown> | null = null,
): Promise<string> {
  const version = await withWorkspace(appDb, { workspaceId }, async (tx) => {
    const stored = await insertCustomApiDefinition(tx, workspaceId, {
      id: randomUUID(),
      projectId: null,
      name: document.name,
      createdBy: null,
      document: document as unknown as Record<string, unknown>,
      documentSha256: canonicalSha256(document),
      schemaVersion: 1,
      datasetVersions: Object.fromEntries(
        document.streams.map((stream) => [stream.key, 1]),
      ),
    });
    return stored.version;
  });
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

interface RunOptions {
  quota?: ImageQuota;
  logger?: pino.Logger;
}

/** One sync job, continued until it ends. */
async function runSync(
  connectionId: string,
  options: RunOptions = {},
): Promise<void> {
  const handler = createJobHandlers({
    registry,
    credentialKeyring: KEYRING,
    executeOptions: {
      egress: {
        tlsCa: fixture.ca!,
        allowPrivateHosts: ["127.0.0.1", "localhost"],
      },
    },
    ...(options.quota ? { customApiImageQuota: options.quota } : {}),
  })["connection.sync"]!;
  const jobId = randomUUID();
  let continuation: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await handler({
        job: {
          id: jobId,
          kind: "connection.sync",
          workspaceId,
          connectionId,
          attempts: attempt,
          payload: {
            workspace_id: workspaceId,
            connection_id: connectionId,
            ...(continuation ? { continuation } : {}),
          },
        } as unknown as Job,
        appDb,
        schedulerDb,
        logger: options.logger ?? pino({ level: "silent" }),
      });
      return;
    } catch (error) {
      if (!(error instanceof ContinueJobError)) throw error;
      continuation = error.continuation;
    }
  }
  throw new Error("job did not end");
}

async function lastRunStatus(connectionId: string): Promise<string> {
  const [row] = await owner<{ status: string }[]>`
    select status from sync_runs
    where connection_id = ${connectionId} and status <> 'continued'
    order by started_at desc, finished_at desc limit 1`;
  return row!.status;
}

async function streamStatus(connectionId: string, streamKey = "photos") {
  const [row] = await owner<
    {
      stored: number;
      unchanged: number;
      skipped: number;
      skipped_reasons: Record<string, number>;
    }[]
  >`
    select stored, unchanged, skipped, skipped_reasons
    from custom_api_stream_images
    where connection_id = ${connectionId} and stream_key = ${streamKey}`;
  return row
    ? {
        stored: row.stored,
        unchanged: row.unchanged,
        skipped: row.skipped,
        skippedReasons: row.skipped_reasons,
      }
    : null;
}

async function customApiImageCount(): Promise<number> {
  const [row] = await owner<{ count: number }[]>`
    select count(*)::int as count from workspace_images
    where workspace_id = ${workspaceId} and origin = 'custom_api'`;
  return row!.count;
}

async function lookupRowCount(): Promise<number> {
  const [row] = await owner<{ count: number }[]>`
    select count(*)::int as count from custom_api_item_images
    where workspace_id = ${workspaceId}`;
  return row!.count;
}

const imageRequests = () =>
  fixture.requests.filter((request) => request.path.startsWith("/images/"));

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
    .values({ email: "images@example.com", displayName: "Owner" })
    .returning({ id: schema.users.id });
  userId = user!.id;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  // Each test in a workspace of its own: counts are per workspace.
  workspaceId = await createWorkspace(appDb, {
    name: `Images ${randomUUID().slice(0, 8)}`,
    ownerUserId: userId,
  });
  fixture.setImages(null);
  fixture.signUrls(null);
  fixture.reset();
});

afterAll(async () => {
  await appDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await schedulerDb?.$client.end({ timeout: 5 }).catch(() => undefined);
  await owner?.end({ timeout: 5 }).catch(() => undefined);
  await testDb?.drop();
  await fixture?.close();
});

describe("custom API item images after a sync", () => {
  it("stores the images of the newest 3 records after a sync", async () => {
    const connectionId = await connect(definition("photos"));
    await runSync(connectionId);
    expect(await lastRunStatus(connectionId)).toBe("succeeded");
    expect(await streamStatus(connectionId)).toEqual({
      stored: 3,
      unchanged: 0,
      skipped: 0,
      skippedReasons: {},
    });
    expect(await customApiImageCount()).toBe(3);
    // The newest three by taken_at: photos 5, 4 and 3.
    expect(
      imageRequests()
        .map((request) => request.path)
        .sort(),
    ).toEqual(["/images/n/3.png", "/images/n/4.png", "/images/n/5.png"]);
    const url = `${fixture.origin}/images/n/5.png`;
    const [lookup] = await owner<{ count: number }[]>`
      select count(*)::int as count from custom_api_item_images
      where workspace_id = ${workspaceId}
        and url_sha256 = ${itemImageUrlHash(url)}`;
    expect(lookup!.count).toBe(1);
  });

  it("does not download unchanged URLs again", async () => {
    const connectionId = await connect(definition("photos"));
    await runSync(connectionId);
    fixture.reset();
    await runSync(connectionId);
    expect(imageRequests()).toHaveLength(0);
    expect(await streamStatus(connectionId)).toMatchObject({
      stored: 0,
      unchanged: 3,
      skipped: 0,
    });
  });

  it("reuses the stored image when a new URL returns the same bytes", async () => {
    const connectionId = await connect(definition("photos"));
    await runSync(connectionId);
    fixture.signUrls("v2");
    await runSync(connectionId); // same files, new ?sig= query
    expect(await streamStatus(connectionId)).toMatchObject({ stored: 3 });
    expect(await customApiImageCount()).toBe(3);
    expect(await lookupRowCount()).toBe(6);
  });

  it("strips EXIF from a JPEG with GPS before storing it", async () => {
    const original = readFileSync(
      new URL("./images/fixtures/gps.jpg", import.meta.url),
    );
    expect(original.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(true);
    const connectionId = await connect(definition("photos"));
    fixture.setImages(["gps.jpg"]);
    await runSync(connectionId);
    expect(await streamStatus(connectionId)).toMatchObject({ stored: 3 });
    const [row] = await owner<{ content: Buffer; content_type: string }[]>`
      select i.content, i.content_type from workspace_images i
      join custom_api_item_images l
        on l.workspace_id = i.workspace_id and l.image_id = i.id
      where l.workspace_id = ${workspaceId}
        and l.url_sha256 = ${itemImageUrlHash(`${fixture.origin}/images/gps.jpg`)}`;
    expect(row!.content_type).toBe("image/jpeg");
    expect(row!.content.includes(Buffer.from("Exif\0\0", "latin1"))).toBe(
      false,
    );
  });

  it("never fails the sync for broken images and counts each reason", async () => {
    const connectionId = await connect(definition("photos"));
    fixture.setImages(["big.png", "html", "redirect-other-host"]);
    await runSync(connectionId);
    expect(await lastRunStatus(connectionId)).toBe("succeeded");
    expect(await streamStatus(connectionId)).toEqual({
      stored: 0,
      unchanged: 0,
      skipped: 3,
      skippedReasons: { too_large: 1, unsupported_type: 1, fetch_failed: 1 },
    });
    expect(await customApiImageCount()).toBe(0);
    expect(
      fixture.requests.filter((request) =>
        request.host.startsWith("localhost"),
      ),
    ).toHaveLength(0);
  });

  it("sends credentials to the API host and never follows a redirect to another image host", async () => {
    // localhost is an allowed image host, so only the same-host redirect
    // rule stops the hop (Review Focus 3).
    const document: CustomApiDefinition = {
      ...definition("photos_bearer"),
      images: { hosts: ["127.0.0.1", "localhost"], newestItems: 3 },
    };
    const connectionId = await connect(document, {
      token: FIXTURE_SECRETS.token,
    });
    fixture.setImages(["redirect-other-host"]);
    await runSync(connectionId);
    expect(await lastRunStatus(connectionId)).toBe("succeeded");
    expect(await streamStatus(connectionId)).toMatchObject({
      stored: 2,
      skipped: 1,
      skippedReasons: { fetch_failed: 1 },
    });
    expect(
      fixture.requests.filter((request) =>
        request.host.startsWith("localhost"),
      ),
    ).toHaveLength(0);
    const images = imageRequests();
    expect(images).toHaveLength(3);
    for (const request of images)
      expect(request.headers.authorization).toBe(
        `Bearer ${FIXTURE_SECRETS.token}`,
      );
  });

  it("skips beyond the custom_api quota and leaves uploads untouched", async () => {
    const connectionId = await connect(definition("photos"));
    await runSync(connectionId, {
      quota: { maxCount: 2, maxBytes: 10_000_000 },
    });
    expect(await streamStatus(connectionId)).toMatchObject({
      stored: 2,
      skipped: 1,
      skippedReasons: { quota_exceeded: 1 },
    });
    const content = Buffer.from("upload bytes");
    const upload = await withWorkspace(appDb, { workspaceId }, (tx) =>
      insertImageWithinQuota(
        tx,
        workspaceId,
        {
          name: "logo.png",
          contentType: "image/png",
          width: 1,
          height: 1,
          sha256: createHash("sha256").update(content).digest("hex"),
          content,
          createdByUserId: null,
        },
        { maxCount: 1, maxBytes: 1_000 },
      ),
    );
    expect(upload.status).toBe("ok");
  });

  it("two connections of one definition store a shared URL once", async () => {
    const first = await connect(definition("photos"));
    const second = await connect(definition("photos"));
    await runSync(first);
    fixture.reset();
    await runSync(second);
    expect(imageRequests()).toHaveLength(0);
    expect(await streamStatus(second)).toMatchObject({
      stored: 0,
      unchanged: 3,
    });
    expect(await customApiImageCount()).toBe(3);
    expect(await lookupRowCount()).toBe(3);
  });

  it("logs counts only: no URL, host or image byte reaches a log line", async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: "debug" },
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString("utf8"));
          done();
        },
      }),
    );
    const connectionId = await connect(definition("photos"));
    fixture.setImages(["big.png", "html"]);
    await runSync(connectionId, { logger });
    const text = lines.join("");
    expect(text).toContain("item images checked");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("/images/");
    expect(text).not.toContain(fixture.origin);
  });
});

describe("item images: failures of one image, and the time budget", () => {
  /** The image step alone, as the engine runs it, with a test clock. */
  async function ingest(
    connectionId: string,
    options: { clock: () => number; budgetMs: number },
  ) {
    const connection = await withWorkspace(appDb, { workspaceId }, (tx) =>
      findConnection(tx, workspaceId, connectionId),
    );
    const resolved = connectorFor(registry, connection!)!;
    const context = { connectionId, config: {}, credentials: {} };
    const callOptions = callOptionsFor(
      resolved,
      {
        egress: {
          tlsCa: fixture.ca!,
          allowPrivateHosts: ["127.0.0.1", "localhost"],
        },
      },
      { credentials: {}, privateHosts: [] },
    );
    return ingestCustomApiImages({
      db: appDb,
      workspaceId,
      connectionId,
      resolved,
      run: (call) => call(context, callOptions),
      quota: { maxCount: 500, maxBytes: 200 * 1_048_576 },
      now: new Date(),
      log: () => undefined,
      ...options,
    });
  }

  it("counts a database error on one image against that image only", async () => {
    const connectionId = await connect(definition("photos"));
    const failing = itemImageUrlHash(`${fixture.origin}/images/n/4.png`);
    await owner.unsafe(`
      create or replace function fail_one_item_image() returns trigger
      language plpgsql as $$
      begin
        if new.url_sha256 = '${failing}' then
          raise exception 'storage failed';
        end if;
        return new;
      end $$`);
    await owner.unsafe(`
      create trigger fail_one_item_image before insert
      on custom_api_item_images for each row
      execute function fail_one_item_image()`);
    try {
      await runSync(connectionId);
    } finally {
      await owner.unsafe(
        "drop trigger fail_one_item_image on custom_api_item_images",
      );
    }
    expect(await lastRunStatus(connectionId)).toBe("succeeded");
    expect(await streamStatus(connectionId)).toEqual({
      stored: 2,
      unchanged: 0,
      skipped: 1,
      skippedReasons: { fetch_failed: 1 },
    });
  });

  it("counts every missing image as fetch_failed once the budget is spent, without a request", async () => {
    const connectionId = await connect(definition("photos"));
    // The sync stores nothing: its quota is zero.
    await runSync(connectionId, { quota: { maxCount: 0, maxBytes: 0 } });
    fixture.reset();
    let now = 1_000;
    const outcomes = await ingest(connectionId, {
      budgetMs: 5_000,
      // The first reading sets the deadline; every later one is past it.
      clock: () => {
        const at = now;
        now += 10_000;
        return at;
      },
    });
    expect(outcomes).toEqual([
      {
        streamKey: "photos",
        stored: 0,
        unchanged: 0,
        skipped: 3,
        skippedReasons: { fetch_failed: 3 },
      },
    ]);
    expect(imageRequests()).toHaveLength(0);
    expect(await streamStatus(connectionId)).toMatchObject({
      skipped: 3,
      skippedReasons: { fetch_failed: 3 },
    });
  });

  it("bounds the downloads by what is left of the budget", async () => {
    const connectionId = await connect(definition("photos"));
    // The newest photo never answers (the sync's own step waits out its
    // 15 s request timeout once); the next two are ordinary images.
    fixture.setImages(["slow"]);
    await runSync(connectionId, { quota: { maxCount: 0, maxBytes: 0 } });
    fixture.reset();
    // 200 ms left when the downloads start: the slow image is cut off by
    // the budget, not by its 15 s request timeout.
    let readings = 0;
    const started = Date.now();
    const outcomes = await ingest(connectionId, {
      budgetMs: 200,
      clock: () => (readings++ === 0 ? started : Date.now()),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outcomes[0]).toMatchObject({
      stored: 2,
      skipped: 1,
      skippedReasons: { fetch_failed: 1 },
    });
  });
});

describe("item images in the connection detail", () => {
  const detail = async (connectionId: string) => {
    const service = createConnectionService({
      db: appDb,
      registry,
      credentialKeyring: KEYRING,
      oauthProviders: createOAuthProviders({
        webOrigin: "https://netrics.example",
        oauthClients: { google: null },
      }),
    });
    const result = await service.get(
      { workspaceId, callerId: userId },
      connectionId,
    );
    if (!result.ok) throw new Error(result.error);
    return connectionDetailResponseSchema.parse(result.value);
  };

  it("lists stored and skipped counts per image stream in the connection detail", async () => {
    const connectionId = await connect(definition("photos"));
    fixture.setImages(["big.png", "html", "redirect-other-host"]);
    await runSync(connectionId);
    const { itemImages } = await detail(connectionId);
    expect(itemImages).toEqual([
      {
        streamKey: "photos",
        streamName: "Photos",
        checkedAt: expect.any(String),
        stored: 0,
        unchanged: 0,
        skipped: 3,
        skippedReasons: { too_large: 1, unsupported_type: 1, fetch_failed: 1 },
      },
    ]);
  });

  it("lists an image stream with no step yet as nothing", async () => {
    const connectionId = await connect(definition("photos"));
    expect((await detail(connectionId)).itemImages).toEqual([]);
  });

  it("omits itemImages for bundled connectors and streams without images", async () => {
    const custom = await connect(definition("pages"));
    expect(await detail(custom)).not.toHaveProperty("itemImages");
    const [bundled] = await withWorkspace(appDb, { workspaceId }, (tx) =>
      tx
        .insert(schema.connections)
        .values({ workspaceId, connectorId: "demo", name: "Demo" })
        .returning({ id: schema.connections.id }),
    );
    expect(await detail(bundled!.id)).not.toHaveProperty("itemImages");
  });
});
