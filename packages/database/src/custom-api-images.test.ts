import { createHash, randomUUID } from "node:crypto";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import {
  findCustomApiImageBySha256,
  findItemImages,
  latestDatasetValues,
  listStreamImages,
  pruneCustomApiItemImages,
  recordStreamImages,
  touchItemImages,
  upsertItemImage,
} from "./custom-api-images.js";
import {
  findDeviceImage,
  findImageIds,
  imageUsage,
  insertImageWithinQuota,
  listImages,
  type ImageInput,
} from "./images.js";
import * as schema from "./schema.js";
import {
  createTestDatabase,
  type TestDatabase,
  TEST_DATABASE_SETUP_TIMEOUT_MS,
} from "./test-db.js";

// Custom API item images (#809): their own quota apart from the library,
// the lookup by URL hash, the per-stream outcome, the newest values of a
// stored dataset, and garbage collection. As netrics_app inside
// withWorkspace, except pruning (scheduler role) and seeding (owner).

const NOW = new Date("2026-11-20T12:00:00.000Z");
const DAY = 86_400_000;
const QUOTA = { maxCount: 100, maxBytes: 50 * 1_048_576 };

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let schedulerClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let schedulerDb: PostgresJsDatabase<typeof schema & typeof authSchema>;
let ws: string;
let other: string;
let connectionId: string;
let otherConnectionId: string;

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = role;
  return url.toString();
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function input(
  origin: ImageInput["origin"],
  content: Buffer = Buffer.from(randomUUID()),
): ImageInput {
  return {
    name: "item",
    contentType: "image/png",
    width: 24,
    height: 16,
    sha256: hash(content.toString("latin1")),
    content,
    origin,
    createdByUserId: null,
  };
}

const inWs = <T>(
  workspaceId: string,
  run: Parameters<typeof withWorkspace<T>>[2],
) => withWorkspace(db, { workspaceId }, run);

async function insertIn(
  workspaceId: string,
  image: ImageInput,
  quota = QUOTA,
): Promise<string> {
  const result = await inWs(workspaceId, (tx) =>
    insertImageWithinQuota(tx, workspaceId, image, quota),
  );
  if (result.status !== "ok") {
    throw new Error(result.status);
  }
  return result.image.id;
}

async function insertCustomApi(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(await insertIn(ws, input("custom_api")));
  }
  return ids;
}

async function countRows(workspaceId: string, urlSha256: string) {
  const rows = await admin`
    select 1 from custom_api_item_images
    where workspace_id = ${workspaceId} and url_sha256 = ${urlSha256}`;
  return rows.length;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl, { max: 4 });
  schedulerClient = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
    max: 1,
  });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  schedulerDb = drizzle(schedulerClient, {
    schema: { ...schema, ...authSchema },
  });
  await admin`insert into connectors (id, version, manifest)
              values ('demo', '1.0.0', '{"id":"demo"}'::jsonb)
              on conflict (id) do nothing`;
  const [a, b] =
    await admin`insert into workspaces (name) values ('A'), ('B') returning id`;
  ws = a!.id as string;
  other = b!.id as string;
  const [connection] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${ws}, 'demo', 'Demo') returning id`;
  connectionId = connection!.id as string;
  const [foreign] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${other}, 'demo', 'Demo') returning id`;
  otherConnectionId = foreign!.id as string;
}, TEST_DATABASE_SETUP_TIMEOUT_MS);

beforeEach(async () => {
  await admin`delete from custom_api_item_images`;
  await admin`delete from custom_api_stream_images`;
  await admin`delete from workspace_images`;
});

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
  await schedulerClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("custom_api quota scope", () => {
  it("counts custom_api images apart from the library quota", async () => {
    await insertCustomApi(3);
    await insertIn(ws, input("upload"));
    expect(await inWs(ws, (tx) => imageUsage(tx, ws))).toEqual({
      count: 1,
      bytes: 36,
    });
    const usage = await inWs(ws, (tx) => imageUsage(tx, ws, "custom_api"));
    expect(usage).toEqual({ count: 3, bytes: 108 });
  });

  it("refuses a custom_api insert beyond its own quota while uploads still fit", async () => {
    const quota = { maxCount: 2, maxBytes: 10_000_000 };
    await insertCustomApi(2);
    const refused = await inWs(ws, (tx) =>
      insertImageWithinQuota(tx, ws, input("custom_api"), quota),
    );
    expect(refused.status).toBe("quota_exceeded");
    const upload = await inWs(ws, (tx) =>
      insertImageWithinQuota(tx, ws, input("upload"), quota),
    );
    expect(upload.status).toBe("ok");
  });

  it("lists no custom_api image in the workspace library", async () => {
    await insertCustomApi(1);
    await insertIn(ws, input("upload"));
    const origins = (await inWs(ws, (tx) => listImages(tx, ws))).map(
      (image) => image.origin,
    );
    expect(origins).toEqual(["upload"]);
  });

  it("lets no dashboard name a custom_api image", async () => {
    const [itemImage] = await insertCustomApi(1);
    const upload = await insertIn(ws, input("upload"));
    const found = await inWs(ws, (tx) =>
      findImageIds(tx, ws, [itemImage!, upload]),
    );
    expect([...found]).toEqual([upload]);
  });

  it("never serves a custom_api image through findDeviceImage", async () => {
    const [itemImage] = await insertCustomApi(1);
    const [dashboard] = await admin`
      insert into dashboards (workspace_id, name, logo_image_id)
      values (${ws}, 'Studio', ${itemImage!}) returning id`;
    const [device] = await admin`
      insert into devices (workspace_id, name, platform, dashboard_id)
      values (${ws}, 'TV', 'tvos', ${dashboard!.id as string}) returning id`;
    expect(
      await inWs(ws, (tx) =>
        findDeviceImage(tx, ws, device!.id as string, itemImage!),
      ),
    ).toBeNull();
    await admin`delete from devices where id = ${device!.id as string}`;
    await admin`delete from dashboards where id = ${dashboard!.id as string}`;
  });
});

describe("item image lookup", () => {
  it("finds stored images by URL hash and touches them", async () => {
    const [imageId] = await insertCustomApi(1);
    const url = hash("https://api.example.com/a.png");
    await inWs(ws, (tx) =>
      upsertItemImage(tx, ws, { urlSha256: url, imageId: imageId!, now: NOW }),
    );
    const found = await inWs(ws, (tx) =>
      findItemImages(tx, ws, [url, hash("unknown")]),
    );
    expect([...found.keys()]).toEqual([url]);
    expect(found.get(url)).toMatchObject({
      imageId,
      width: 24,
      height: 16,
      contentType: "image/png",
    });
    const later = new Date(NOW.getTime() + DAY);
    await inWs(ws, (tx) => touchItemImages(tx, ws, [url], later));
    const [row] = await admin`
      select last_seen_at from custom_api_item_images where url_sha256 = ${url}`;
    expect((row!.last_seen_at as Date).toISOString()).toBe(later.toISOString());
    // Another workspace sees nothing, by RLS and by the explicit predicate.
    expect(
      (await inWs(other, (tx) => findItemImages(tx, ws, [url]))).size,
    ).toBe(0);
    expect(
      (await inWs(other, (tx) => findItemImages(tx, other, [url]))).size,
    ).toBe(0);
  });

  it("upsertItemImage keeps one row under concurrent upserts", async () => {
    const [imageA, imageB] = await insertCustomApi(2);
    const url = hash("https://api.example.com/same.png");
    await Promise.all([
      inWs(ws, (tx) =>
        upsertItemImage(tx, ws, { urlSha256: url, imageId: imageA!, now: NOW }),
      ),
      inWs(ws, (tx) =>
        upsertItemImage(tx, ws, { urlSha256: url, imageId: imageB!, now: NOW }),
      ),
    ]);
    expect(await countRows(ws, url)).toBe(1);
  });

  it("refuses a lookup row for another workspace", async () => {
    const [imageId] = await insertCustomApi(1);
    await expect(
      inWs(other, (tx) =>
        upsertItemImage(tx, ws, {
          urlSha256: hash("x"),
          imageId: imageId!,
          now: NOW,
        }),
      ),
    ).rejects.toThrow();
    expect(await countRows(ws, hash("x"))).toBe(0);
  });

  it("finds a stored custom_api image by its content hash only", async () => {
    const content = Buffer.from("same bytes");
    const imageId = await insertIn(ws, input("custom_api", content));
    const upload = input("upload", Buffer.from("upload bytes"));
    await insertIn(ws, upload);
    const sha = hash("same bytes");
    expect(
      (await inWs(ws, (tx) => findCustomApiImageBySha256(tx, ws, sha)))?.id,
    ).toBe(imageId);
    expect(
      await inWs(ws, (tx) => findCustomApiImageBySha256(tx, ws, upload.sha256)),
    ).toBeNull();
    expect(
      await inWs(other, (tx) => findCustomApiImageBySha256(tx, other, sha)),
    ).toBeNull();
  });
});

describe("stream image outcomes", () => {
  it("records and replaces the last outcome per stream", async () => {
    const record = (stored: number, reasons: Record<string, number>) =>
      inWs(ws, (tx) =>
        recordStreamImages(tx, {
          workspaceId: ws,
          connectionId,
          streamKey: "photos",
          checkedAt: NOW,
          stored,
          unchanged: 1,
          skipped: Object.values(reasons).reduce((a, b) => a + b, 0),
          skippedReasons: reasons,
        }),
      );
    await record(3, {});
    await record(1, { too_large: 2 });
    expect(
      await inWs(ws, (tx) => listStreamImages(tx, ws, connectionId)),
    ).toEqual([
      {
        streamKey: "photos",
        checkedAt: NOW,
        stored: 1,
        unchanged: 1,
        skipped: 2,
        skippedReasons: { too_large: 2 },
      },
    ]);
    expect(
      await inWs(other, (tx) => listStreamImages(tx, ws, connectionId)),
    ).toEqual([]);
    await expect(
      inWs(other, (tx) =>
        recordStreamImages(tx, {
          workspaceId: ws,
          connectionId,
          streamKey: "photos",
          checkedAt: NOW,
          stored: 0,
          unchanged: 0,
          skipped: 0,
          skippedReasons: {},
        }),
      ),
    ).rejects.toThrow();
    expect(otherConnectionId).toBeDefined();
  });
});

describe("latestDatasetValues", () => {
  async function seedDataset(
    rows: Array<{ day: string | null; url: unknown }>,
  ) {
    const key = `photos_${randomUUID().slice(0, 8)}`;
    const [dataset] = await admin`
      insert into data_datasets (workspace_id, connection_id, key, name)
      values (${ws}, ${connectionId}, ${key}, 'Photos') returning id`;
    const datasetId = dataset!.id as string;
    await admin`
      insert into data_schema_versions (dataset_id, workspace_id, version,
        definition)
      values (${datasetId}, ${ws}, 1, '{}'::jsonb)`;
    // An older generation whose values must not count.
    const [old] = await admin`
      insert into data_generations (dataset_id, workspace_id, schema_version,
        refresh_key, source_started_at, sequence, row_count)
      values (${datasetId}, ${ws}, 1, 'r1', now(), 1, 1) returning id`;
    await admin`
      insert into data_records (generation_id, workspace_id, record_key,
        collected_at, values)
      values (${old!.id as string}, ${ws}, 'old', now(),
        ${admin.json({ day: "2026-12-31", photo: "u-old" })})`;
    const [generation] = await admin`
      insert into data_generations (dataset_id, workspace_id, schema_version,
        refresh_key, source_started_at, sequence, row_count)
      values (${datasetId}, ${ws}, 1, 'r2', now(), 2, ${rows.length})
      returning id`;
    for (const [index, row] of rows.entries()) {
      await admin`
        insert into data_records (generation_id, workspace_id, record_key,
          collected_at, values)
        values (${generation!.id as string}, ${ws}, ${`k${index}`}, now(),
          ${admin.json({ day: row.day, photo: row.url } as never)})`;
    }
    return key;
  }

  const query = (datasetKey: string, limit: number, workspaceId = ws) =>
    inWs(workspaceId, (tx) =>
      latestDatasetValues(tx, {
        workspaceId,
        connectionId,
        datasetKey,
        valueField: "photo",
        orderField: "day",
        limit,
        now: NOW,
      }),
    );

  it("returns the newest distinct URLs by the order field", async () => {
    const key = await seedDataset([
      { day: "2026-11-01", url: "u1" },
      { day: "2026-11-02", url: "u2" },
      { day: "2026-11-03", url: "u3" },
      { day: "2026-11-04", url: "u4" },
      { day: "2026-11-05", url: "u5" },
      { day: "2026-11-06", url: null },
      { day: "2026-11-02", url: "u5" },
      { day: "2026-11-07", url: 42 },
      { day: "2026-11-08", url: `https://x/${"a".repeat(2100)}` },
    ]);
    expect(await query(key, 3)).toEqual(["u5", "u4", "u3"]);
    expect(await query(key, 50)).toEqual(["u5", "u4", "u3", "u2", "u1"]);
  });

  it("answers nothing for another workspace or an unknown dataset", async () => {
    const key = await seedDataset([{ day: "2026-11-01", url: "u1" }]);
    expect(await query(key, 3, other)).toEqual([]);
    expect(await query("missing", 3)).toEqual([]);
  });
});

describe("pruneCustomApiItemImages", () => {
  it("deletes lookups older than the grace period, then unreferenced images", async () => {
    const [stale, fresh] = await insertCustomApi(2);
    const upload = await insertIn(ws, input("upload"));
    await admin`update workspace_images set created_at = ${new Date(
      NOW.getTime() - 10 * DAY,
    )}`;
    await inWs(ws, (tx) =>
      upsertItemImage(tx, ws, {
        urlSha256: hash("stale"),
        imageId: stale!,
        now: new Date(NOW.getTime() - 8 * DAY),
      }),
    );
    await inWs(ws, (tx) =>
      upsertItemImage(tx, ws, {
        urlSha256: hash("fresh"),
        imageId: fresh!,
        now: new Date(NOW.getTime() - 6 * DAY),
      }),
    );
    expect(await pruneCustomApiItemImages(schedulerDb, NOW)).toBe(2);
    const ids = (await admin`select id from workspace_images`).map(
      (row) => row.id as string,
    );
    expect(ids.sort()).toEqual([fresh!, upload].sort());
    expect(await pruneCustomApiItemImages(schedulerDb, NOW)).toBe(0);
  });

  it("keeps an orphan younger than one hour and one a dashboard names", async () => {
    const [young, named, orphan] = await insertCustomApi(3);
    await admin`update workspace_images set created_at = ${new Date(
      NOW.getTime() - 2 * 3_600_000,
    )} where id in ${admin([named!, orphan!])}`;
    await admin`update workspace_images set created_at = ${new Date(
      NOW.getTime() - 30 * 60_000,
    )} where id = ${young!}`;
    const [dashboard] = await admin`
      insert into dashboards (workspace_id, name, logo_image_id)
      values (${ws}, 'Studio', ${named!}) returning id`;
    expect(await pruneCustomApiItemImages(schedulerDb, NOW)).toBe(1);
    const ids = (await admin`select id from workspace_images`).map(
      (row) => row.id as string,
    );
    expect(ids.sort()).toEqual([young!, named!].sort());
    await admin`delete from dashboards where id = ${dashboard!.id as string}`;
  });

  it("is not callable by the application role", async () => {
    const error = await pruneCustomApiItemImages(db, NOW).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(String((error as Error | null)?.cause)).toMatch(/permission denied/);
  });
});
