import { readFileSync } from "node:fs";
import path from "node:path";

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  APP_REVIEW_RETENTION,
  AppReviewStoreError,
  capAppReviewText,
  deleteConnectionAppReviews,
  findLatestAppReview,
  hideAppReview,
  ingestAppReviews,
  pruneAppReviews,
  type AppReviewInput,
} from "./app-reviews.js";
import * as authSchema from "./auth-schema.js";
import { withWorkspace } from "./context.js";
import { migrationsFolder } from "./index.js";
import * as schema from "./schema.js";
import { createTestDatabase, type TestDatabase } from "./test-db.js";

// Review text (ADR 0019 §11, #334) as netrics_app under RLS, and its
// retention as netrics_scheduler. A fixed clock far from the wall clock.

const NOW = new Date("2031-03-15T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const APP = "1000000001";
const OTHER_APP = "1000000002";

function roleUrl(base: string, role: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = role;
  return url.toString();
}

let testDb: TestDatabase;
let admin: postgres.Sql;
let appClient: postgres.Sql;
let schedulerClient: postgres.Sql;
let db: PostgresJsDatabase<typeof schema & typeof authSchema>;
let schedulerDb: PostgresJsDatabase<typeof schema & typeof authSchema>;
let workspaceA: string;
let workspaceB: string;
let connectionA: string;
let connectionB: string;

function review(
  id: string,
  ageMs: number,
  extra: Partial<AppReviewInput> = {},
): AppReviewInput {
  return {
    id,
    resource: APP,
    rating: 4,
    title: `Title ${id}`,
    body: `Body ${id}`,
    author: `author-${id}`,
    territory: "DE",
    createdAt: new Date(NOW.getTime() - ageMs).toISOString(),
    ...extra,
  };
}

const inWorkspace = <T>(
  workspaceId: string,
  run: Parameters<typeof withWorkspace<T>>[2],
) => withWorkspace(db, { workspaceId }, run);

async function storedIds(connectionId = connectionA): Promise<string[]> {
  const rows = await admin`
    select provider_review_id from app_reviews
    where connection_id = ${connectionId}
    order by created_at desc, provider_review_id`;
  return rows.map((row) => row.provider_review_id as string);
}

async function connection(workspaceId: string): Promise<string> {
  const [row] = await admin`
    insert into connections (workspace_id, connector_id, name)
    values (${workspaceId}, 'app-store-connect', 'ASC') returning id`;
  return row!.id as string;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = postgres(testDb.adminUrl, { max: 1, onnotice: () => undefined });
  appClient = postgres(testDb.appUrl, { max: 2 });
  schedulerClient = postgres(roleUrl(testDb.adminUrl, "netrics_scheduler"), {
    max: 1,
  });
  db = drizzle(appClient, { schema: { ...schema, ...authSchema } });
  schedulerDb = drizzle(schedulerClient, {
    schema: { ...schema, ...authSchema },
  });
  await admin`insert into connectors (id, version, manifest)
              values ('app-store-connect', '1.0.0', '{"id":"app-store-connect"}'::jsonb)`;
  const [a] =
    await admin`insert into workspaces (name) values ('A') returning id`;
  const [b] =
    await admin`insert into workspaces (name) values ('B') returning id`;
  workspaceA = a!.id as string;
  workspaceB = b!.id as string;
}, 60_000);

beforeEach(async () => {
  await admin`delete from connections`;
  connectionA = await connection(workspaceA);
  connectionB = await connection(workspaceB);
});

afterAll(async () => {
  await appClient.end({ timeout: 5 });
  await schedulerClient.end({ timeout: 5 });
  await admin.end({ timeout: 5 });
});

const ingest = (
  reviews: AppReviewInput[],
  windows: Array<{ resource: string; from: string; to: string }> = [],
  workspaceId = workspaceA,
  connectionId = connectionA,
) =>
  inWorkspace(workspaceId, (tx) =>
    ingestAppReviews(tx, {
      workspaceId,
      connectionId,
      reviews,
      windows,
      now: NOW,
    }),
  );

describe("ingest", () => {
  it("stores reviews with text, capped, and skips those past the retention age", async () => {
    const result = await ingest([
      review("r1", HOUR, {
        title: "t".repeat(400),
        body: `  ${"b".repeat(5000)}`,
        author: "😀".repeat(150),
        territory: "Germany",
      }),
      review("r2", 2 * DAY, { title: "   ", body: null }),
      review("old", 91 * DAY),
    ]);
    expect(result).toEqual({ stored: 2, deleted: 0 });
    const rows = await admin`
      select provider_review_id, resource_id, rating, char_length(title) as title,
             char_length(body) as body, char_length(author) as author,
             territory, workspace_id
      from app_reviews order by created_at desc`;
    expect(rows.map((row) => ({ ...row }))).toEqual([
      {
        provider_review_id: "r1",
        resource_id: APP,
        rating: 4,
        title: 300,
        body: 4000,
        author: 100,
        territory: null,
        workspace_id: workspaceA,
      },
      {
        provider_review_id: "r2",
        resource_id: APP,
        rating: 4,
        title: null,
        body: null,
        author: 9,
        territory: "DE",
        workspace_id: workspaceA,
      },
    ]);
  });

  it("follows an edit, keeping a hidden review hidden", async () => {
    await ingest([review("r1", HOUR)]);
    const hidden = await inWorkspace(workspaceA, (tx) =>
      hideAppReview(tx, {
        workspaceId: workspaceA,
        connectionId: connectionA,
        providerReviewId: "r1",
        now: NOW,
      }),
    );
    expect(hidden).toEqual({ resourceId: APP, hiddenAt: NOW });
    await ingest([review("r1", HOUR, { rating: 2, body: "Edited body" })]);
    const [row] = await admin`
      select rating, body, hidden_at from app_reviews where provider_review_id = 'r1'`;
    expect(row).toMatchObject({ rating: 2, body: "Edited body" });
    expect((row!.hidden_at as Date).toISOString()).toBe(NOW.toISOString());
  });

  it("deletes reviews missing from a complete window, and only those", async () => {
    await ingest([
      review("inside-kept", HOUR),
      review("inside-gone", 2 * HOUR),
      review("before-window", 10 * DAY),
      review("other-app", 2 * HOUR, { resource: OTHER_APP }),
    ]);
    await ingest(
      [review("other-connection", 2 * HOUR)],
      [],
      workspaceB,
      connectionB,
    );
    const result = await ingest(
      [review("inside-kept", HOUR, { rating: 5 })],
      [
        {
          resource: APP,
          from: new Date(NOW.getTime() - 5 * DAY).toISOString(),
          to: NOW.toISOString(),
        },
      ],
    );
    expect(result).toEqual({ stored: 1, deleted: 1 });
    expect(await storedIds()).toEqual([
      "inside-kept",
      "other-app",
      "before-window",
    ]);
    expect(await storedIds(connectionB)).toEqual(["other-connection"]);
  });

  it("empties a window that came back without reviews", async () => {
    await ingest([review("r1", HOUR), review("r2", 2 * HOUR)]);
    const result = await ingest(
      [],
      [
        {
          resource: APP,
          from: new Date(NOW.getTime() - DAY).toISOString(),
          to: NOW.toISOString(),
        },
      ],
    );
    expect(result).toEqual({ stored: 0, deleted: 2 });
    expect(await storedIds()).toEqual([]);
  });

  it("enforces the caps in the database too", async () => {
    await expect(admin`
      insert into app_reviews (connection_id, workspace_id, provider_review_id,
        resource_id, rating, body, created_at)
      values (${connectionA}, ${workspaceA}, 'long', ${APP}, 4,
              ${"x".repeat(4001)}, now())`).rejects.toThrow(
      /app_reviews_body_length/,
    );
    await expect(admin`
      insert into app_reviews (connection_id, workspace_id, provider_review_id,
        resource_id, rating, created_at)
      values (${connectionA}, ${workspaceA}, 'zero', ${APP}, 0, now())`).rejects.toThrow(
      /app_reviews_rating/,
    );
  });

  it("caps text by characters", () => {
    expect(capAppReviewText(" a ", 300)).toBe("a");
    expect(capAppReviewText("", 300)).toBeNull();
    expect(capAppReviewText(null, 300)).toBeNull();
    expect(Array.from(capAppReviewText("😀".repeat(9), 4)!)).toHaveLength(4);
  });
});

describe("tenant isolation", () => {
  it("never shows, hides, changes or deletes another workspace's reviews", async () => {
    await ingest([review("r1", HOUR)]);
    // RLS alone: no predicate on the workspace in this query.
    const visible = await inWorkspace(workspaceB, (tx) =>
      tx.select().from(schema.appReviews),
    );
    expect(visible).toEqual([]);
    const hidden = await inWorkspace(workspaceB, (tx) =>
      hideAppReview(tx, {
        workspaceId: workspaceB,
        connectionId: connectionA,
        providerReviewId: "r1",
        now: NOW,
      }),
    );
    expect(hidden).toBeNull();
    // A window of workspace B over A's connection deletes nothing.
    await ingest(
      [],
      [
        {
          resource: APP,
          from: new Date(NOW.getTime() - DAY).toISOString(),
          to: NOW.toISOString(),
        },
      ],
      workspaceB,
      connectionA,
    );
    expect(
      await inWorkspace(workspaceB, (tx) =>
        deleteConnectionAppReviews(tx, workspaceB, connectionA),
      ),
    ).toBe(0);
    // Workspace B cannot write reviews into A's connection either.
    // The error names the SQLSTATE only, never the review's text.
    const error = await ingest(
      [review("intruder", HOUR)],
      [],
      workspaceB,
      connectionA,
    ).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeInstanceOf(AppReviewStoreError);
    expect(error!.message).toMatch(/SQLSTATE [0-9A-Z]{5}/);
    expect(error!.cause).toBeUndefined();
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toMatch(/Title intruder|Body intruder|author-intruder/);
    await expect(
      inWorkspace(workspaceB, (tx) =>
        tx.insert(schema.appReviews).values({
          connectionId: connectionA,
          workspaceId: workspaceA,
          providerReviewId: "rls",
          resourceId: APP,
          rating: 3,
          createdAt: NOW,
        }),
      ),
    ).rejects.toThrow();
    const [row] = await admin`
      select hidden_at from app_reviews where provider_review_id = 'r1'`;
    expect(row!.hidden_at).toBeNull();
    expect(await storedIds()).toEqual(["r1"]);
  });
});

describe("latest review (ADR 0019 section 12)", () => {
  const latest = (
    options: { resourceId?: string; minRating?: number; requireText?: boolean },
    workspaceId = workspaceA,
    connectionId = connectionA,
  ) =>
    inWorkspace(workspaceId, (tx) =>
      findLatestAppReview(tx, {
        workspaceId,
        connectionId,
        resourceId: options.resourceId ?? null,
        minRating: options.minRating ?? 1,
        requireText: options.requireText ?? true,
      }),
    );

  it("is the newest match that is not hidden", async () => {
    await ingest([
      review("newest-other-app", HOUR, { resource: OTHER_APP }),
      review("two-stars", 2 * HOUR, { rating: 2 }),
      review("no-text", 3 * HOUR, { rating: 5, body: "   " }),
      review("five", 4 * HOUR, { rating: 5 }),
      review("older-five", 5 * HOUR, { rating: 5 }),
    ]);
    expect((await latest({}))?.providerReviewId).toBe("newest-other-app");
    expect((await latest({ resourceId: APP }))?.providerReviewId).toBe(
      "two-stars",
    );
    expect(
      (await latest({ resourceId: APP, minRating: 4 }))?.providerReviewId,
    ).toBe("five");
    expect(
      (await latest({ resourceId: APP, minRating: 4, requireText: false }))
        ?.providerReviewId,
    ).toBe("no-text");
    await inWorkspace(workspaceA, (tx) =>
      hideAppReview(tx, {
        workspaceId: workspaceA,
        connectionId: connectionA,
        providerReviewId: "five",
        now: NOW,
      }),
    );
    expect(await latest({ resourceId: APP, minRating: 4 })).toMatchObject({
      providerReviewId: "older-five",
      rating: 5,
      title: "Title older-five",
      body: "Body older-five",
      author: "author-older-five",
      territory: "DE",
    });
    expect(await latest({ resourceId: "unknown" })).toBeNull();
  });

  it("never reads another workspace's reviews", async () => {
    await ingest([review("b1", HOUR)], [], workspaceB, connectionB);
    // Workspace A asking for B's connection, under A's RLS and predicate.
    expect(await latest({}, workspaceA, connectionB)).toBeNull();
    expect((await latest({}, workspaceB, connectionB))?.providerReviewId).toBe(
      "b1",
    );
  });
});

describe("deletion", () => {
  it("deletes a connection's reviews when its reviews key goes", async () => {
    await ingest([review("r1", HOUR), review("r2", 2 * HOUR)]);
    await ingest([review("b1", HOUR)], [], workspaceB, connectionB);
    expect(
      await inWorkspace(workspaceA, (tx) =>
        deleteConnectionAppReviews(tx, workspaceA, connectionA),
      ),
    ).toBe(2);
    expect(await storedIds()).toEqual([]);
    expect(await storedIds(connectionB)).toEqual(["b1"]);
  });

  it("goes with the connection and with the workspace", async () => {
    await ingest([review("r1", HOUR)]);
    await ingest([review("b1", HOUR)], [], workspaceB, connectionB);
    await admin`delete from connections where id = ${connectionA}`;
    expect(await storedIds()).toEqual([]);
    const [doomed] =
      await admin`insert into workspaces (name) values ('Doomed') returning id`;
    const doomedConnection = await connection(doomed!.id as string);
    await ingest(
      [review("d1", HOUR)],
      [],
      doomed!.id as string,
      doomedConnection,
    );
    await admin`delete from workspaces where id = ${doomed!.id as string}`;
    const [{ count }] = (await admin`
      select count(*)::int as count from app_reviews
      where connection_id = ${doomedConnection}`) as unknown as [
      { count: number },
    ];
    expect(count).toBe(0);
    expect(await storedIds(connectionB)).toEqual(["b1"]);
  });
});

describe("retention", () => {
  it("keeps the newest 50 per app and none older than 90 days", async () => {
    const many = Array.from({ length: 55 }, (_, index) =>
      review(`n${String(index).padStart(2, "0")}`, (index + 1) * HOUR),
    );
    await ingest([
      ...many,
      review("other-app", 80 * DAY, { resource: OTHER_APP }),
    ]);
    // Rows that were stored while younger (ingest refuses older ones).
    await admin`
      insert into app_reviews (connection_id, workspace_id, provider_review_id,
        resource_id, rating, created_at)
      values (${connectionB}, ${workspaceB}, 'expired', ${APP}, 3,
              ${new Date(NOW.getTime() - 90 * DAY - 1000).toISOString()}::timestamptz),
             (${connectionB}, ${workspaceB}, 'fresh', ${APP}, 3,
              ${new Date(NOW.getTime() - 89 * DAY).toISOString()}::timestamptz)`;

    const result = await pruneAppReviews(schedulerDb, NOW);
    expect(result).toEqual({ expiredDeleted: 1, surplusDeleted: 5 });
    const kept = await storedIds();
    expect(kept).toHaveLength(51);
    expect(kept).toContain("n49");
    expect(kept).not.toContain("n50");
    expect(kept).toContain("other-app");
    expect(await storedIds(connectionB)).toEqual(["fresh"]);
    expect(await pruneAppReviews(schedulerDb, NOW)).toEqual({
      expiredDeleted: 0,
      surplusDeleted: 0,
    });
  });

  it("works in batches", async () => {
    await ingest(
      Array.from({ length: 6 }, (_, index) =>
        review(`b${index}`, index * HOUR),
      ),
    );
    const policy = { ...APP_REVIEW_RETENTION, keepPerResource: 1, batch: 2 };
    expect(await pruneAppReviews(schedulerDb, NOW, policy)).toEqual({
      expiredDeleted: 0,
      surplusDeleted: 2,
    });
    expect(await storedIds()).toHaveLength(4);
  });

  it("is the scheduler's: the app role cannot run it", async () => {
    const error = await pruneAppReviews(db, NOW).then(
      () => null,
      (caught: unknown) => caught as Error & { cause?: { code?: string } },
    );
    // 42501: insufficient_privilege.
    expect(error?.cause?.code).toBe("42501");
  });
});

describe("migration", () => {
  it("adds an empty table under forced RLS to a database with connections", async () => {
    const journal = JSON.parse(
      readFileSync(
        path.join(migrationsFolder, "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    const index = journal.entries.findIndex((entry) =>
      entry.tag.endsWith("_app_reviews"),
    );
    expect(index).toBeGreaterThan(0);
    const previous = await createTestDatabase({
      upTo: journal.entries[index - 1]!.tag,
    });
    const owner = postgres(previous.adminUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      await owner`insert into connectors (id, version, manifest)
                  values ('c', '1.0.0', '{"id":"c"}'::jsonb)`;
      const [workspace] =
        await owner`insert into workspaces (name) values ('W') returning id`;
      await owner`insert into connections (workspace_id, connector_id, name)
                  values (${workspace!.id as string}, 'c', 'C')`;
      await previous.migrate();
      const [{ count }] = (await owner`
        select count(*)::int as count from connections`) as unknown as [
        { count: number },
      ];
      expect(count).toBe(1);
      const [table] = await owner`
        select relrowsecurity, relforcerowsecurity from pg_class
        where relname = 'app_reviews'`;
      expect(table).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      const [{ reviews }] = (await owner`
        select count(*)::int as reviews from app_reviews`) as unknown as [
        { reviews: number },
      ];
      expect(reviews).toBe(0);
    } finally {
      await owner.end({ timeout: 5 });
    }
  }, 60_000);
});
