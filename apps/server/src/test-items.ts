import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance, InjectOptions } from "fastify";
import pino from "pino";
import { expect } from "vitest";
import {
  createPairingResponseSchema,
  pollPairingResponseSchema,
  workspaceResponseSchema,
} from "@netrics/contracts";
import {
  createDatabase,
  createRawSqlClient,
  type Database,
  type Sql,
} from "@netrics/database";

import { buildApp } from "./app.js";
import { createAuthService } from "./auth/index.js";
import { loadConfig } from "./env.js";
import { itemImageUrlHash } from "./images/custom-api-images.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Shared setup of the latest-items widget suites (#810): a workspace with a
// manual "photos" table (taken_at, title, caption, team and photo, the image
// URL), a published model over it, and custom_api images stored for some of
// the URLs, as an ingestion after a sync leaves them.

export const ITEMS_NOW = new Date("2026-11-10T12:00:00Z");

/** The photos, oldest first: one a day from Nov 1, each of a team. */
export const PHOTOS = [
  { id: "a", team: "red" },
  { id: "b", team: "blue" },
  { id: "c", team: "red" },
  { id: "d", team: "blue" },
  { id: "e", team: "red" },
  { id: "f", team: "blue" },
] as const;
export const photoUrl = (id: string) => `https://img.example/photos/${id}.png`;

export interface ItemsFixture {
  testDb: TestDatabase;
  app: FastifyInstance;
  db: Database;
  admin: Sql;
  owner: string;
  workspaceId: string;
  datasetId: string;
  modelId: string;
  call: (
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
    cookie?: string,
  ) => Promise<Awaited<ReturnType<FastifyInstance["inject"]>>>;
  /** Stores a custom_api image with a lookup row for `url`; its id and hash. */
  storeImage: (
    url: string,
    workspace?: string,
  ) => Promise<{ id: string; sha256: string }>;
  /** A model over the photos with the given dimensions published; its id. */
  publishModel: (name: string) => Promise<string>;
  /** Replaces the photos table's records. */
  writePhotos: (
    rows: ReadonlyArray<{ id: string; team: string; day: string }>,
  ) => Promise<void>;
  /** Pairs a screen to `dashboardId`: its access token and device id. */
  pairScreen: (
    dashboardId: string | null,
  ) => Promise<{ token: string; deviceId: string }>;
  signUp: (email: string) => Promise<string>;
  close: () => Promise<void>;
}

/** A tiny valid PNG, distinct per call. */
function png(seed: string): Buffer {
  const base = Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c63f8cfc0f01f0005000201a5d6a4" +
      "e60000000049454e44ae426082",
    "hex",
  );
  return Buffer.concat([base, Buffer.from(seed)]);
}

export async function createItemsFixture(label: string): Promise<ItemsFixture> {
  const testDb = await createTestDatabase();
  const admin = createRawSqlClient(testDb.adminUrl, {
    max: 1,
    onnotice: () => undefined,
  });
  const config = loadConfig({
    DATABASE_URL: testDb.appUrl,
    LOG_LEVEL: "silent",
    BETTER_AUTH_URL: "http://localhost:3001",
    WEB_ORIGIN: "http://localhost:3000",
  });
  const db = createDatabase(testDb.appUrl);
  const app = await buildApp(config, {
    db,
    authService: createAuthService(config, db, {
      logger: pino({ level: "silent" }),
    }),
    checkDb: async () => true,
    now: () => ITEMS_NOW,
  });
  const signUp = async (email: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name: email, email, password: "password-12345" },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    return (Array.isArray(header) ? header : [header])
      .find((c) => c?.startsWith("better-auth.session_token="))!
      .split(";")[0]!;
  };
  const owner = await signUp(`${label}-owner@example.com`);
  const created = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    headers: { cookie: owner },
    payload: { name: "Items" },
  });
  const workspaceId = workspaceResponseSchema.parse(created.json()).workspace
    .id;
  const call: ItemsFixture["call"] = (method, url, payload, cookie = owner) =>
    app.inject({
      method,
      url: url.startsWith("/v1/") ? url : `/v1/workspaces/${workspaceId}${url}`,
      headers: { cookie },
      ...(payload === undefined
        ? {}
        : { payload: payload as InjectOptions["payload"] }),
    });
  const field = (id: string, type: string, extra: object = {}) => ({
    id,
    name: id,
    type,
    nullable: id !== "id",
    classification: "internal",
    ...extra,
  });
  const definition = () => ({
    key: "photos",
    name: "Photos",
    version: 1,
    mode: "snapshot",
    grain: "one photo",
    keyFields: ["id"],
    fields: [
      field("id", "string"),
      field("taken_at", "date"),
      field("title", "string"),
      field("caption", "string"),
      field("team", "string"),
      field("photo", "string", { role: "image" }),
    ],
  });
  let datasetId = "";
  let generationId: string | null = null;
  const writePhotos: ItemsFixture["writePhotos"] = async (rows) => {
    const manual = await call(
      datasetId ? "PUT" : "POST",
      datasetId ? `/data/manual/${datasetId}` : "/data/manual",
      {
        ...(generationId ? { generationId } : {}),
        definition: definition(),
        records: rows.map((row) => ({
          values: {
            id: row.id,
            taken_at: row.day,
            title: row.id,
            caption: null,
            team: row.team,
            photo: photoUrl(row.id),
          },
        })),
      },
    );
    expect(manual.statusCode, manual.body).toBe(200);
    datasetId = manual.json().datasetId as string;
    generationId = manual.json().generationId as string;
  };
  await writePhotos(
    PHOTOS.map((photo, index) => ({
      ...photo,
      day: `2026-11-0${index + 1}`,
    })),
  );
  const publishModel: ItemsFixture["publishModel"] = async (name) => {
    const model = await call("POST", "/data/models", {
      name,
      definition: {
        version: 1,
        datasets: [datasetId],
        relationships: [],
        dimensions: ["taken_at", "title", "caption", "team", "photo"].map(
          (id) => ({
            id,
            name: id,
            datasetId,
            fieldId: id,
            ...(id === "taken_at"
              ? { timeAlignment: "reporting_date" as const }
              : {}),
          }),
        ),
        measures: [
          {
            id: "photos",
            name: "Photos",
            kind: "aggregate",
            datasetId,
            aggregate: { id: "photos", name: "photos", op: "count" },
          },
        ],
      },
    });
    expect(model.statusCode, model.body).toBe(200);
    const { id, version } = model.json().model;
    const published = await call("POST", `/data/models/${id}/publish`, {
      version,
    });
    expect(published.statusCode, published.body).toBe(200);
    return id as string;
  };
  const modelId = await publishModel("Photos");
  const storeImage: ItemsFixture["storeImage"] = async (
    url,
    workspace = workspaceId,
  ) => {
    const content = png(randomUUID());
    const sha256 = createHash("sha256").update(content).digest("hex");
    const [image] = await admin`
      insert into workspace_images (workspace_id, name, content_type, bytes,
        width, height, sha256, content, origin)
      values (${workspace}, 'item', 'image/png', ${content.length}, 1, 1,
        ${sha256}, ${content}, 'custom_api')
      returning id`;
    await admin`
      insert into custom_api_item_images (workspace_id, url_sha256, image_id,
        last_seen_at)
      values (${workspace}, ${itemImageUrlHash(url)}, ${image!.id},
        ${ITEMS_NOW})`;
    return { id: image!.id as string, sha256 };
  };
  let pairings = 0;
  const pairScreen: ItemsFixture["pairScreen"] = async (dashboardId) => {
    pairings += 1;
    const started = await app.inject({
      method: "POST",
      url: "/v1/device/pairings",
      remoteAddress: `203.0.113.${pairings}`,
    });
    const pairing = createPairingResponseSchema.parse(started.json());
    const approved = await call("POST", "/devices/approve", {
      code: pairing.code,
      name: `Screen ${pairings}`,
      dashboardId,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const polled = pollPairingResponseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/v1/device/pairings/poll",
          payload: {
            pairingId: pairing.pairingId,
            pollSecret: pairing.pollSecret,
          },
        })
      ).json(),
    );
    if (polled.status !== "approved") throw new Error("not approved");
    return {
      token: polled.credentials.accessToken,
      deviceId: (approved.json() as { device: { id: string } }).device.id,
    };
  };
  return {
    testDb,
    app,
    db,
    admin,
    owner,
    workspaceId,
    get datasetId() {
      return datasetId;
    },
    modelId,
    call,
    storeImage,
    publishModel,
    writePhotos,
    pairScreen,
    signUp,
    close: async () => {
      await app.close();
      await db.$client.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    },
  };
}
