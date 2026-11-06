import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import {
  deleteImage,
  findImage,
  imageUsage,
  insertImageWithinQuota,
  listImages,
  readImageContent,
  type ImageInput,
} from "./images.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// workspace_images (#217): RLS and explicit predicates, immutability for the
// application role, constraints, and the out-of-line storage of the bytes.

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;

const QUOTA = { maxCount: 100, maxBytes: 50 * 1_048_576 };

function image(overrides: Partial<ImageInput> = {}): ImageInput {
  const content = overrides.content ?? Buffer.from("not decoded here");
  return {
    name: "logo.png",
    contentType: "image/png",
    width: 24,
    height: 16,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
    createdByUserId: null,
    ...overrides,
  };
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  expect.unreachable("expected the query to fail");
}

const inA = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceA }, run);
const inB = <T>(run: Parameters<typeof withWorkspace<T>>[2]) =>
  withWorkspace(db, { workspaceId: workspaceB }, run);

async function insertInA(input: ImageInput = image()) {
  const result = await inA((tx) =>
    insertImageWithinQuota(tx, workspaceA, input, QUOTA),
  );
  if (result.status !== "ok") {
    throw new Error(result.status);
  }
  return result.image;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1 });
  appClient = postgres(testDb.appUrl, { max: 2 });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
}, 30_000);

afterAll(async () => {
  await admin.end({ timeout: 5 }).catch(() => undefined);
  await appClient.end({ timeout: 5 }).catch(() => undefined);
});

describe("workspace_images", () => {
  it("stores an image and keeps it to its workspace", async () => {
    const stored = await insertInA();
    expect(stored).toMatchObject({
      workspaceId: workspaceA,
      bytes: 16,
      origin: "upload",
    });
    expect(stored).not.toHaveProperty("content");
    expect(
      await inA((tx) => readImageContent(tx, workspaceA, stored.id)),
    ).toEqual(Buffer.from("not decoded here"));

    // Invisible from workspace B, by RLS and by the explicit predicate.
    expect(await inB((tx) => listImages(tx, workspaceB))).toEqual([]);
    expect(await inB((tx) => listImages(tx, workspaceA))).toEqual([]);
    expect(await inB((tx) => findImage(tx, workspaceA, stored.id))).toBeNull();
    expect(await inB((tx) => findImage(tx, workspaceB, stored.id))).toBeNull();
    expect(
      await inB((tx) => readImageContent(tx, workspaceA, stored.id)),
    ).toBeNull();
    expect(await inB((tx) => deleteImage(tx, workspaceA, stored.id))).toBe(
      false,
    );
    expect(await inB((tx) => imageUsage(tx, workspaceA))).toEqual({
      count: 0,
      bytes: 0,
    });
    // The explicit predicate holds inside the right tenant context too.
    expect(await inA((tx) => findImage(tx, workspaceB, stored.id))).toBeNull();
    expect(await inA((tx) => deleteImage(tx, workspaceA, stored.id))).toBe(
      true,
    );
  });

  it("refuses to insert an image into another workspace under RLS", async () => {
    await expectDbError(
      inA((tx) => insertImageWithinQuota(tx, workspaceB, image(), QUOTA)),
      /row-level security/,
    );
  });

  it("is immutable for the application role", async () => {
    const stored = await insertInA();
    await expectDbError(
      inA((tx) =>
        tx.execute(
          sql`update workspace_images set name = 'x' where id = ${stored.id}`,
        ),
      ),
      /permission denied/,
    );
  });

  it("enforces type, size, dimension, hash and origin constraints", async () => {
    for (const [overrides, constraint] of [
      [{ contentType: "image/svg+xml" }, "workspace_images_content_type_valid"],
      [{ width: 4097 }, "workspace_images_dimensions_valid"],
      [{ width: 0 }, "workspace_images_dimensions_valid"],
      [{ sha256: "abc" }, "workspace_images_sha256_valid"],
      [{ origin: "resource_icon" as const }, "workspace_images_origin_valid"],
      [{ content: Buffer.alloc(1_048_577) }, "workspace_images_bytes_valid"],
    ] as const) {
      await expectDbError(
        insertInA(image(overrides as Partial<ImageInput>)),
        new RegExp(constraint),
      );
    }
    // A resource icon names its connection and resource.
    const icon = await insertInA(
      image({
        origin: "resource_icon",
        connectionId: crypto.randomUUID(),
        resourceId: "app-1",
      }),
    );
    expect(icon.origin).toBe("resource_icon");
  });

  it("counts usage and refuses inserts beyond the quota", async () => {
    const [workspace] =
      await admin`insert into workspaces (name) values ('Q') returning id`;
    const id = workspace!.id as string;
    const quota = { maxCount: 2, maxBytes: 40 };
    const insert = (content: string) =>
      withWorkspace(db, { workspaceId: id }, (tx) =>
        insertImageWithinQuota(
          tx,
          id,
          image({ content: Buffer.from(content) }),
          quota,
        ),
      );
    expect((await insert("a".repeat(30))).status).toBe("ok");
    // 30 + 11 bytes > 40
    expect(await insert("b".repeat(11))).toEqual({
      status: "quota_exceeded",
      usage: { count: 1, bytes: 30 },
    });
    expect((await insert("c".repeat(10))).status).toBe("ok");
    expect((await insert("d")).status).toBe("quota_exceeded");
  });

  it("refuses to delete a referenced image at once, not at commit", async () => {
    const stored = await insertInA();
    await admin`insert into dashboards (workspace_id, name, logo_image_id)
                values (${workspaceA}, 'Logo', ${stored.id})`;
    await expectDbError(
      inA((tx) => deleteImage(tx, workspaceA, stored.id)),
      /dashboards_logo_image_fk/,
    );
    // The delete never ran to the end: the image is still there.
    expect(
      await inA((tx) => findImage(tx, workspaceA, stored.id)),
    ).not.toBeNull();
    await admin`delete from dashboards where logo_image_id = ${stored.id}`;
    expect(await inA((tx) => deleteImage(tx, workspaceA, stored.id))).toBe(
      true,
    );
  });

  it("stores the bytes out of line without compression, under forced RLS", async () => {
    const [column] = await admin`
      select a.attstorage, c.relrowsecurity, c.relforcerowsecurity
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      where c.relname = 'workspace_images' and a.attname = 'content'`;
    expect({ ...column }).toEqual({
      attstorage: "e",
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });
});
