import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo, LookupFunction } from "node:net";

import { ConnectorRegistry } from "@netrics/connector-runtime";
import type { Connector, ConnectorRuntime } from "@netrics/connector-sdk";
import { createGooglePlayConnector } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  createWorkspace,
  enqueueJob,
  schema,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";
import { DEFAULT_DATA_POLICY } from "@netrics/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ALPHA,
  BETA,
  fakePlay,
  fixtureBytes,
  TEST_BUCKET,
  TEST_NOW,
} from "../../../../packages/connectors/src/google-play/test-helpers.js";
import {
  STORAGE_SCOPE,
  REPORTING_SCOPE,
} from "../../../../packages/connectors/src/google-play/api.js";
import { createCredentialKeyring } from "../credentials.js";
import { createDataService, type DataActor } from "../data/service.js";
import { createJobHandlers } from "../jobs/handlers.js";
import { OAuthProviders } from "../oauth/config.js";
import {
  capturingLogger,
  seedOAuthConnection,
  startTestOAuthProvider,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
  TEST_PROVIDER_EGRESS,
  type TestOAuthProvider,
} from "../oauth/test-provider.js";
import { createOAuthTokenService } from "../oauth/tokens.js";
import { Secret } from "../secret.js";
import { createTestDatabase } from "../test-db.js";
import { createWorker, type WorkerHandle } from "../worker.js";
import { syncCatalog } from "./catalog.js";

vi.setConfig({ testTimeout: 30_000 });
const KEYRING = createCredentialKeyring(randomBytes(32).toString("base64"));
const scopes = [STORAGE_SCOPE, REPORTING_SCOPE];
let provider: TestOAuthProvider,
  api: Server,
  fake: ReturnType<typeof fakePlay>,
  worker: WorkerHandle;
let appDb: Database, schedulerDb: Database, schedulerRaw: Sql;
let actor: DataActor,
  foreign: DataActor,
  connectionId: string,
  installsId: string,
  earningsId: string,
  earningModelId: string;
let clockMs = TEST_NOW;
let service: ReturnType<typeof createDataService>;
const logs: string[] = [],
  credentialFields: string[][] = [];
const ACCOUNT_SUB = "google-play-engine-account";

async function runJob(kind: "connection.sync" | "connection.backfill") {
  const id = await withWorkspace(
    appDb,
    { workspaceId: actor.workspaceId },
    (tx) =>
      enqueueJob(tx, {
        kind,
        workspaceId: actor.workspaceId,
        connectionId,
        maxAttempts: 1,
      }),
  );
  const until = Date.now() + 25_000;
  for (;;) {
    const [row] =
      await schedulerRaw`select status, attempts, last_error from jobs where id=${id}`;
    if (row && ["succeeded", "failed", "dead"].includes(row.status as string))
      return row;
    if (Date.now() > until)
      throw new Error("Google Play fixture job timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
beforeAll(async () => {
  provider = await startTestOAuthProvider();
  fake = fakePlay({
    acceptToken: async (token) =>
      (
        await provider.handle(
          "GET",
          "/api/resource",
          new URLSearchParams(),
          `Bearer ${token}`,
        )
      ).status === 200,
  });
  api = createServer((request, response) => {
    const hostname = (request.headers.host ?? "").split(":")[0]!;
    fake
      .fetch(`https://${hostname}${request.url ?? "/"}`, {
        method: "GET",
        headers:
          typeof request.headers.authorization === "string"
            ? { authorization: request.headers.authorization }
            : {},
      })
      .then((answer) => {
        response.writeHead(answer.status, answer.headers);
        response.end(answer.bytes());
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const port = (api.address() as AddressInfo).port;
  const original = createGooglePlayConnector({ now: () => clockMs });
  const rewrite = (runtime: ConnectorRuntime): ConnectorRuntime => ({
    ...runtime,
    fetch: (raw, init) => {
      const url = new URL(raw);
      url.protocol = "http:";
      url.port = String(port);
      return runtime.fetch(url.toString(), init);
    },
  });
  const record = (context: Parameters<Connector["sync"]>[0]) =>
    credentialFields.push(Object.keys(context.credentials).sort());
  const connector: Connector = {
    manifest: original.manifest,
    check: (context, runtime) => {
      record(context);
      return original.check(context, rewrite(runtime));
    },
    discover: (context, runtime) =>
      original.discover(context, rewrite(runtime)),
    sync: (context, request, runtime) => {
      record(context);
      return original.sync(context, request, rewrite(runtime));
    },
    resourceIcons: (context, request, runtime) =>
      original.resourceIcons!(context, request, rewrite(runtime)),
  };
  const registry = new ConnectorRegistry();
  registry.register(connector);
  const db = await createTestDatabase();
  appDb = createDatabase(db.appUrl);
  const schedulerUrl = new URL(db.adminUrl);
  schedulerUrl.username = "netrics_scheduler";
  schedulerUrl.password = "netrics_scheduler";
  schedulerDb = createDatabase(schedulerUrl.toString());
  schedulerRaw = createRawSqlClient(schedulerUrl.toString(), { max: 2 });
  const owner = createDatabase(db.adminUrl, { max: 1 });
  await syncCatalog(owner, registry);
  await owner.$client.end({ timeout: 5 });
  const users = await appDb
    .insert(schema.users)
    .values([
      { email: "play-owner@example.test", displayName: "Play owner" },
      { email: "play-other@example.test", displayName: "Other" },
    ])
    .returning({ id: schema.users.id });
  actor = {
    workspaceId: await createWorkspace(appDb, {
      name: "Google Play",
      ownerUserId: users[0]!.id,
    }),
    callerId: users[0]!.id,
  };
  foreign = {
    workspaceId: await createWorkspace(appDb, {
      name: "Other",
      ownerUserId: users[1]!.id,
    }),
    callerId: users[1]!.id,
  };
  const refresh = provider.grant({ sub: ACCOUNT_SUB, scopes });
  connectionId = await seedOAuthConnection(appDb, KEYRING, {
    workspaceId: actor.workspaceId,
    connectorId: "google-play",
    provider: "google",
    refreshToken: refresh,
    sub: ACCOUNT_SUB,
    grantedScopes: scopes,
  });
  await withWorkspace(appDb, { workspaceId: actor.workspaceId }, (tx) =>
    tx
      .update(schema.connections)
      .set({
        config: {
          reportBucket: TEST_BUCKET,
          ratingStorefront: "DE",
          ratingLanguage: "de",
          resourceSelection: [ALPHA, BETA],
        },
        setupPending: false,
      })
      .where(eq(schema.connections.id, connectionId)),
  );
  const google = { ...provider.definition, id: "google", name: "Google" };
  const providers = new OAuthProviders(
    [
      {
        definition: google,
        clientId: TEST_CLIENT_ID,
        clientSecret: new Secret(TEST_CLIENT_SECRET),
        redirectUri: "http://localhost:3000/oauth/google/callback",
      },
    ],
    new Map([["google", google]]),
  );
  const logger = capturingLogger(logs);
  const lookup: LookupFunction = (_hostname, _options, callback) =>
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  worker = createWorker({
    appDb,
    schedulerDb,
    handlers: createJobHandlers({
      registry,
      credentialKeyring: KEYRING,
      dataPolicy: { ...DEFAULT_DATA_POLICY, syncPagesPerRun: 2 },
      now: () => new Date(clockMs),
      oauthTokens: createOAuthTokenService({
        db: appDb,
        credentialKeyring: KEYRING,
        providers,
        logger,
        egress: TEST_PROVIDER_EGRESS,
      }),
      executeOptions: { egress: { ...TEST_PROVIDER_EGRESS, lookup } },
    }),
    pollMs: 25,
    heartbeatMs: 50,
    logger,
  });
  await worker.start();
  service = createDataService(appDb, () => new Date(clockMs));
}, 60_000);
afterAll(async () => {
  await worker?.stop();
  await schedulerRaw?.end({ timeout: 5 });
  await schedulerDb?.$client.end({ timeout: 5 });
  await appDb?.$client.end({ timeout: 5 });
  await provider?.close();
  if (api) {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  }
});

describe("Google Play through OAuth, worker, datasets and models", () => {
  it("imports several apps across cooperative worker turns with only short-lived connector credentials", async () => {
    expect(await runJob("connection.backfill")).toMatchObject({
      status: "succeeded",
      attempts: 0,
    });
    const { sources } = await service.listSources(actor);
    expect(sources.filter((source) => source.kind === "source")).toHaveLength(
      4,
    );
    expect(sources.some((source) => source.kind === "resources")).toBe(true);
    installsId = sources.find(
      (source) => source.name === "Google Play install report rows",
    )!.id;
    earningsId = sources.find(
      (source) => source.name === "Google Play earnings report rows",
    )!.id;
    expect(sources.find((source) => source.id === installsId)).toMatchObject({
      rowCount: 4,
      aggregated: false,
      expiresAt: null,
    });
    expect(sources.find((source) => source.id === earningsId)).toMatchObject({
      rowCount: 8,
      expiresAt: null,
    });
    expect(
      credentialFields.every(
        (keys) => JSON.stringify(keys) === '["accessToken"]',
      ),
    ).toBe(true);
    const installation = await service.saveModel(actor, {
      name: "Play installs",
      definition: {
        version: 1,
        datasets: [installsId],
        relationships: [],
        dimensions: [
          { id: "app", name: "App", datasetId: installsId, fieldId: "app_id" },
        ],
        measures: [
          {
            id: "downloads",
            name: "Daily user installs",
            kind: "aggregate",
            datasetId: installsId,
            aggregate: {
              id: "downloads",
              name: "Installs",
              op: "sum",
              fieldId: "daily_user_installs",
            },
          },
        ],
      },
    });
    await service.publishModel(actor, installation.model.id, 1);
    const queried = await service.query(actor, installation.model.id, {
      measureIds: ["downloads"],
      groupBy: ["app"],
    });
    expect(queried.rows).toEqual([
      expect.objectContaining({
        dimensions: { app: ALPHA },
        measures: {
          downloads: expect.objectContaining({
            value: "10",
            status: "partial",
          }),
        },
      }),
      expect.objectContaining({
        dimensions: { app: BETA },
        measures: {
          downloads: expect.objectContaining({ value: "4", status: "ok" }),
        },
      }),
    ]);
    const earning = await service.saveModel(actor, {
      name: "Play proceeds",
      definition: {
        version: 1,
        datasets: [earningsId],
        relationships: [],
        dimensions: [
          { id: "app", name: "App", datasetId: earningsId, fieldId: "app_id" },
          {
            id: "currency",
            name: "Currency",
            datasetId: earningsId,
            fieldId: "currency",
          },
        ],
        measures: [
          {
            id: "proceeds",
            name: "Net reported earnings",
            kind: "aggregate",
            datasetId: earningsId,
            aggregate: {
              id: "proceeds",
              name: "Proceeds",
              op: "sum",
              fieldId: "merchant_amount",
            },
          },
        ],
      },
    });
    earningModelId = earning.model.id;
    await service.publishModel(actor, earningModelId, 1);
    const revenue = await service.query(actor, earningModelId, {
      measureIds: ["proceeds"],
      groupBy: ["app", "currency"],
    });
    expect(
      revenue.rows.map((row) => [
        row.dimensions.app,
        row.dimensions.currency,
        row.measures.proceeds?.value,
      ]),
    ).toEqual([
      [ALPHA, "USD", "5.75"],
      [BETA, "EUR", "70"],
    ]);
    await expect(
      service.query(actor, earningModelId, {
        measureIds: ["proceeds"],
        groupBy: [],
      }),
    ).rejects.toThrow();
    expect((await service.listSources(foreign)).sources).toHaveLength(0);
    await expect(service.preview(foreign, earningsId)).rejects.toThrow(
      "data_source_not_found",
    );
    await expect(
      service.query(foreign, earningModelId, {
        measureIds: ["proceeds"],
        groupBy: [],
      }),
    ).rejects.toThrow("data_model_not_found");
  });
  it("refreshes a refused access token once and removes withdrawn adjustment rows without double-counting", async () => {
    const before = await service.query(actor, earningModelId, {
      measureIds: ["proceeds"],
      groupBy: ["app", "currency"],
    });
    fake.objects.delete("earnings/earnings_202610_adjustment.zip");
    const csv = Buffer.from(fixtureBytes("installs-alpha.csv"))
      .toString("utf16le")
      .replace(",10,12,", ",12,14,");
    fake.put(
      `stats/installs/installs_${ALPHA}_202610_country.csv`,
      new Uint8Array(Buffer.from(csv, "utf16le")),
      "2",
    );
    clockMs += 60_000;
    const refreshes = provider.refreshRequests;
    provider.rejectNextApiCalls = 1;
    expect(await runJob("connection.sync")).toMatchObject({
      status: "succeeded",
      attempts: 0,
    });
    expect(provider.refreshRequests - refreshes).toBe(1);
    const after = await service.query(actor, earningModelId, {
      measureIds: ["proceeds"],
      groupBy: ["app", "currency"],
    });
    expect(after.rows[0]?.measures.proceeds).toMatchObject({
      value: "5.5",
      currency: "USD",
    });
    expect(after.provenance).not.toEqual(before.provenance);
    const preview = await service.preview(actor, installsId);
    expect(preview.rows.filter((row) => row.app_id === ALPHA)).toHaveLength(3);
    expect(preview.rows.some((row) => row.daily_user_installs === "12")).toBe(
      true,
    );
    expect(
      (await service.listSources(actor)).sources.find(
        (source) => source.id === earningsId,
      )?.rowCount,
    ).toBe(7);
  });
  it("pauses revoked authorization without deleting retained history or logging credentials", async () => {
    provider.revokeAccount(ACCOUNT_SUB);
    clockMs += 60_000;
    expect(await runJob("connection.sync")).toMatchObject({ status: "failed" });
    const state = await withWorkspace(
      appDb,
      { workspaceId: actor.workspaceId },
      (tx) =>
        tx
          .select()
          .from(schema.connectionState)
          .where(eq(schema.connectionState.connectionId, connectionId)),
    );
    expect(state[0]?.authState).toBe("needs_reauthorization");
    expect(
      (
        await service.query(actor, earningModelId, {
          measureIds: ["proceeds"],
          groupBy: ["app", "currency"],
        })
      ).rows[0]?.measures.proceeds?.value,
    ).toBe("5.5");
    for (const secret of [TEST_CLIENT_SECRET, ...provider.accessTokens])
      expect(logs.join("\n")).not.toContain(secret);
  });
});
