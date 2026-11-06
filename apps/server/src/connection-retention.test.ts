import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  connectionResponseSchema,
  connectionRetentionResponseSchema,
  connectorListResponseSchema,
  sourceDatasetSchema,
  workspaceListResponseSchema,
  type SourceDatasetDefinition,
} from "@netrics/contracts";
import { ConnectorRegistry } from "@netrics/connector-runtime";
import { createDemoConnector, demoManifest } from "@netrics/connectors";
import {
  createDatabase,
  createRawSqlClient,
  ingestDatasetPage,
  withWorkspace,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { syncCatalog } from "./sync/catalog.js";
import { addMemberViaInvitation } from "./test-helpers.js";
import { createTestDatabase } from "./test-db.js";

// Per-connection dataset retention through the API (#492).

const DAY = 86_400_000;
const CONNECTOR = "retention-demo";

const earnings: SourceDatasetDefinition = sourceDatasetSchema.parse({
  key: "earnings",
  name: "Earnings rows",
  version: 1,
  keyFields: ["id"],
  grain: "one row",
  mode: "upsert",
  retentionDays: null,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "internal",
    },
    {
      id: "buyer",
      name: "Buyer",
      type: "string",
      nullable: false,
      classification: "personal",
      retentionDays: null,
    },
  ],
});
const ratings: SourceDatasetDefinition = sourceDatasetSchema.parse({
  key: "ratings",
  name: "Ratings",
  version: 1,
  keyFields: ["id"],
  grain: "one snapshot",
  mode: "upsert",
  retentionDays: 400,
  fields: [
    {
      id: "id",
      name: "ID",
      type: "string",
      nullable: false,
      classification: "public",
    },
  ],
});

function registry(): ConnectorRegistry {
  const demo = createDemoConnector();
  const result = new ConnectorRegistry();
  result.register({
    ...demo,
    manifest: {
      ...demoManifest,
      id: CONNECTOR,
      name: "Retention demo",
      translations: {},
      datasets: [earnings, ratings],
    },
  });
  return result;
}

type Response = Awaited<ReturnType<FastifyInstance["inject"]>>;

let app: FastifyInstance;
let db: Database;
let admin: Sql;
let owner: string;
let viewer: string;
let stranger: string;
let workspaceId: string;
let otherWorkspaceId: string;

async function signUp(email: string, name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    payload: { name, email, password: "password-12345" },
  });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies
    .find((c) => c?.startsWith("better-auth.session_token="))!
    .split(";")[0]!;
}

function call(
  method: "GET" | "POST" | "PUT",
  url: string,
  cookie: string,
  payload?: unknown,
): Promise<Response> {
  return app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : {}),
  });
}

async function createConnection(retention?: Record<string, number | null>) {
  const response = await call(
    "POST",
    `/v1/workspaces/${workspaceId}/connections`,
    owner,
    {
      connectorId: CONNECTOR,
      name: "Store",
      config: {},
      ...(retention ? { retention } : {}),
    },
  );
  expect(response.statusCode, response.body).toBe(200);
  return connectionResponseSchema.parse(response.json()).connection.id;
}

function retentionUrl(connectionId: string, workspace = workspaceId) {
  return `/v1/workspaces/${workspace}/connections/${connectionId}/retention`;
}

async function retention(connectionId: string) {
  const response = await call("GET", retentionUrl(connectionId), owner);
  expect(response.statusCode, response.body).toBe(200);
  return connectionRetentionResponseSchema.parse(response.json()).retention;
}

async function ingest(connectionId: string, ids: string[], now: Date) {
  await withWorkspace(db, { workspaceId }, (tx) =>
    ingestDatasetPage(tx, {
      workspaceId,
      connectionId,
      definition: earnings,
      page: {
        datasetKey: earnings.key,
        schemaVersion: 1,
        refreshKey: `r-${now.getTime()}`,
        pageKey: "p1",
        previousPageKey: null,
        complete: true,
        records: ids.map((id) => ({ values: { id, buyer: "b" } })),
      },
      now,
    }),
  );
}

async function expiry(connectionId: string, id: string) {
  const [row] = await admin`
    select r.expires_at from data_records r
    join data_generations g on g.id = r.generation_id
    join data_datasets d on d.id = g.dataset_id
    where d.connection_id = ${connectionId} and r.values->>'id' = ${id}
    order by g.sequence desc limit 1`;
  return row!.expires_at as Date | null;
}

beforeAll(async () => {
  const testDb = await createTestDatabase();
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  db = createDatabase(testDb.appUrl);
  const catalogOwner = createDatabase(testDb.adminUrl, { max: 1 });
  await syncCatalog(catalogOwner, registry());
  await catalogOwner.$client.end({ timeout: 5 });
  const authService = createAuthService(config, db, {
    logger: pino({ level: "silent" }),
  });
  app = await buildApp(config, {
    db,
    authService,
    registry: registry(),
    checkDb: async () => true,
  });
  admin = createRawSqlClient(testDb.adminUrl, { max: 1 });
  owner = await signUp("retention-owner@example.com", "Ada Owner");
  viewer = await signUp("retention-viewer@example.com", "Vic Viewer");
  stranger = await signUp("retention-stranger@example.com", "Sam Stranger");
  expect(
    (
      await call("POST", "/v1/bootstrap", owner, {
        workspaceName: "Retention",
      })
    ).statusCode,
  ).toBe(200);
  workspaceId = workspaceListResponseSchema.parse(
    (await call("GET", "/v1/workspaces", owner)).json(),
  ).workspaces[0]!.id;
  expect(
    (
      await addMemberViaInvitation(
        app,
        db,
        owner,
        workspaceId,
        "retention-viewer@example.com",
        "viewer",
      )
    ).statusCode,
  ).toBe(200);
  const other = await call("POST", "/v1/workspaces", stranger, {
    name: "Elsewhere",
  });
  expect(other.statusCode, other.body).toBe(200);
  otherWorkspaceId = workspaceListResponseSchema
    .parse((await call("GET", "/v1/workspaces", stranger)).json())
    .workspaces.find((w) => w.name === "Elsewhere")!.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.$client.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
});

describe("connection retention", () => {
  it("lists each dataset's connector default and preset in the catalogue", async () => {
    const catalogue = connectorListResponseSchema.parse(
      (await call("GET", "/v1/connectors", owner)).json(),
    );
    expect(
      catalogue.connectors.find((c) => c.id === CONNECTOR)!.datasets,
    ).toEqual([
      {
        key: "earnings",
        name: "Earnings rows",
        personal: true,
        connectorDefaultDays: null,
        presetDays: 90,
      },
      {
        key: "ratings",
        name: "Ratings",
        personal: false,
        connectorDefaultDays: 400,
        presetDays: 400,
      },
    ]);
  });

  it("presets a new connection: personal data 90 days, other data the connector default", async () => {
    const connectionId = await createConnection();
    expect(await retention(connectionId)).toEqual({
      datasets: [
        expect.objectContaining({
          key: "earnings",
          days: 90,
          source: "preset",
          effectiveDays: 90,
          cappedByWorkspace: false,
        }),
        expect.objectContaining({
          key: "ratings",
          days: 400,
          source: "preset",
          effectiveDays: 400,
        }),
      ],
      workspaceMaxDays: null,
      basis: "preset",
      chosenAt: null,
      chosenBy: null,
    });
    const now = new Date();
    await ingest(connectionId, ["a"], now);
    expect(await expiry(connectionId, "a")).toEqual(
      new Date(now.getTime() + 90 * DAY),
    );
  });

  it("records the retention chosen in setup with who and when", async () => {
    const connectionId = await createConnection({ earnings: null });
    const chosen = await retention(connectionId);
    expect(chosen.basis).toBe("chosen");
    expect(chosen.chosenBy?.name).toBe("Ada Owner");
    expect(chosen.chosenAt).not.toBeNull();
    expect(chosen.datasets[0]).toMatchObject({
      days: null,
      source: "chosen",
    });
    expect(chosen.datasets[1]).toMatchObject({ days: 400, source: "preset" });
    const [audit] = await admin`
      select metadata from audit_events
      where action = 'connection.created' and target = ${connectionId}`;
    expect(audit!.metadata).toMatchObject({ retention: { earnings: null } });

    const unknown = await call(
      "POST",
      `/v1/workspaces/${workspaceId}/connections`,
      owner,
      {
        connectorId: CONNECTOR,
        name: "Unknown",
        config: {},
        retention: { reviews: 30 },
      },
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toEqual({ error: "retention_dataset_unknown" });
  });

  it("shortens stored deadlines when settings choose a shorter period", async () => {
    const connectionId = await createConnection();
    const collected = new Date(Date.now() - 1000);
    await ingest(connectionId, ["a"], collected);
    // Viewers can read the retention but not change it.
    expect(
      (await call("GET", retentionUrl(connectionId), viewer)).statusCode,
    ).toBe(200);
    expect(
      (
        await call("PUT", retentionUrl(connectionId), viewer, {
          datasets: { earnings: 7 },
        })
      ).statusCode,
    ).toBe(403);

    const saved = await call("PUT", retentionUrl(connectionId), owner, {
      datasets: { earnings: 7, ratings: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const body = connectionRetentionResponseSchema.parse(saved.json());
    expect(body.retention).toMatchObject({
      basis: "chosen",
      chosenBy: { name: "Ada Owner" },
      datasets: [
        { key: "earnings", days: 7, source: "chosen" },
        { key: "ratings", days: null, source: "chosen" },
      ],
    });
    expect(await expiry(connectionId, "a")).toEqual(
      new Date(collected.getTime() + 7 * DAY),
    );
    const [audit] = await admin`
      select metadata from audit_events
      where action = 'connection.retention_updated' and target = ${connectionId}`;
    expect(audit!.metadata).toEqual({
      datasets: { earnings: 7, ratings: null },
    });
    expect(
      (
        await call("PUT", retentionUrl(connectionId), owner, {
          datasets: { reviews: 7 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call("PUT", retentionUrl(connectionId), owner, {
          datasets: { earnings: 0 },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("lets the workspace maximum cap every choice", async () => {
    const connectionId = await createConnection({
      earnings: null,
      ratings: 400,
    });
    await admin`select admin_set_data_policy(${workspaceId}::uuid, '{"maxRetentionDays":30}'::jsonb)`;
    try {
      const capped = await retention(connectionId);
      expect(capped.workspaceMaxDays).toBe(30);
      expect(capped.datasets).toEqual([
        expect.objectContaining({
          days: null,
          effectiveDays: 30,
          cappedByWorkspace: true,
        }),
        expect.objectContaining({
          days: 400,
          effectiveDays: 30,
          cappedByWorkspace: true,
        }),
      ]);
      const now = new Date();
      await ingest(connectionId, ["a"], now);
      expect(await expiry(connectionId, "a")).toEqual(
        new Date(now.getTime() + 30 * DAY),
      );
    } finally {
      await admin`select admin_set_data_policy(${workspaceId}::uuid, '{}'::jsonb)`;
    }
  });

  it("keeps another workspace out", async () => {
    const connectionId = await createConnection();
    const collected = new Date();
    await ingest(connectionId, ["a"], collected);
    // Not a member of this workspace.
    expect(
      (await call("GET", retentionUrl(connectionId), stranger)).statusCode,
    ).toBe(404);
    expect(
      (
        await call("PUT", retentionUrl(connectionId), stranger, {
          datasets: { earnings: 1 },
        })
      ).statusCode,
    ).toBe(404);
    // Owner of another workspace naming this connection there.
    for (const method of ["GET", "PUT"] as const) {
      const response = await call(
        method,
        retentionUrl(connectionId, otherWorkspaceId),
        stranger,
        method === "PUT" ? { datasets: { earnings: 1 } } : undefined,
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "connection_not_found" });
    }
    expect(await expiry(connectionId, "a")).toEqual(
      new Date(collected.getTime() + 90 * DAY),
    );
  });
});
