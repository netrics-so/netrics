import { and, desc, eq, gte, isNull, lt, notInArray, sql } from "drizzle-orm";

import type { Db, Transaction } from "./context.js";
import * as schema from "./schema.js";

// Recent customer reviews with their text (ADR 0019 §11, #334). The
// reviewer nickname is personal data and the text user content: nothing
// here logs or returns either beyond the caller's own query, lengths are
// capped before the database's CHECKs see them, and retention is fixed in
// code. Runs as netrics_app inside withWorkspace; every statement also
// names the workspace (tenant isolation twice). Pruning runs as the
// scheduler through the owner-role prune_app_reviews (migration 0039).

/** Character caps of the stored text (the table's CHECK constraints). */
export const APP_REVIEW_LIMITS = {
  title: 300,
  body: 4_000,
  author: 100,
} as const;

/** Retention of review text; the privacy policy states the same. */
export interface AppReviewRetentionPolicy {
  /** Reviews created longer ago than this are deleted. */
  maxAgeDays: number;
  /** Reviews kept per connection and app, newest first. */
  keepPerResource: number;
  /** Maximum rows touched per statement and call. */
  batch: number;
}

export const APP_REVIEW_RETENTION: AppReviewRetentionPolicy = {
  maxAgeDays: 90,
  keepPerResource: 50,
  batch: 10_000,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows per INSERT (each binds ten parameters). */
const INSERT_BATCH_ROWS = 2_000;

/** One review as a connector reported it (SDK 0.2.8 `SyncResult.reviews`). */
export interface AppReviewInput {
  id: string;
  resource: string;
  rating: number;
  title: string | null;
  body: string | null;
  author: string | null;
  territory: string | null;
  createdAt: string;
}

/** A span [from, to) of one resource the connector read completely. */
export interface AppReviewWindow {
  resource: string;
  from: string;
  to: string;
}

/**
 * Text as stored: at most `max` characters (code points, as char_length
 * counts them), surrounding whitespace trimmed, empty as null.
 */
export function capAppReviewText(
  value: string | null,
  max: number,
): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const chars = Array.from(trimmed);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : trimmed;
}

/**
 * A failed review statement. Database errors carry the statement's
 * parameters (the review text) in their message, so this error names only
 * the SQLSTATE and keeps no cause.
 */
export class AppReviewStoreError extends Error {
  constructor(public readonly code: string | undefined) {
    super(`storing review text failed (SQLSTATE ${code ?? "unknown"})`);
    this.name = "AppReviewStoreError";
  }
}

function sqlState(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Stores the reviews of one sync page and follows the provider inside the
 * windows it read completely (ADR 0019 §11):
 *
 * - reviews are upserted by (connection, provider id); an edited review
 *   gets its new rating and text, and keeps `hidden_at`;
 * - reviews created before the retention's maximum age are not stored;
 * - stored reviews of a window's resource created inside the window that
 *   the page did not return were deleted or replaced at the provider, and
 *   are deleted here.
 *
 * Returns counts only, never content.
 */
export async function ingestAppReviews(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    reviews: readonly AppReviewInput[];
    windows: readonly AppReviewWindow[];
    now: Date;
    retention?: AppReviewRetentionPolicy;
  },
): Promise<{ stored: number; deleted: number }> {
  try {
    return await storeAppReviews(tx, input);
  } catch (error) {
    throw new AppReviewStoreError(sqlState(error));
  }
}

async function storeAppReviews(
  tx: Transaction,
  input: Parameters<typeof ingestAppReviews>[1],
): Promise<{ stored: number; deleted: number }> {
  const retention = input.retention ?? APP_REVIEW_RETENTION;
  const oldest = input.now.getTime() - retention.maxAgeDays * DAY_MS;
  // One row per id: a statement may not update the same key twice.
  const unique = new Map<string, AppReviewInput>();
  for (const review of input.reviews) {
    if (Date.parse(review.createdAt) >= oldest) {
      unique.set(review.id, review);
    }
  }
  const rows = [...unique.values()].map((review) => ({
    connectionId: input.connectionId,
    workspaceId: input.workspaceId,
    providerReviewId: review.id,
    resourceId: review.resource,
    rating: review.rating,
    title: capAppReviewText(review.title, APP_REVIEW_LIMITS.title),
    body: capAppReviewText(review.body, APP_REVIEW_LIMITS.body),
    author: capAppReviewText(review.author, APP_REVIEW_LIMITS.author),
    territory:
      review.territory !== null && /^[A-Z]{2}$/.test(review.territory)
        ? review.territory
        : null,
    createdAt: new Date(review.createdAt),
    ingestedAt: input.now,
  }));
  let stored = 0;
  for (let start = 0; start < rows.length; start += INSERT_BATCH_ROWS) {
    const written = await tx
      .insert(schema.appReviews)
      .values(rows.slice(start, start + INSERT_BATCH_ROWS))
      .onConflictDoUpdate({
        target: [
          schema.appReviews.connectionId,
          schema.appReviews.providerReviewId,
        ],
        set: {
          resourceId: sql`excluded.resource_id`,
          rating: sql`excluded.rating`,
          title: sql`excluded.title`,
          body: sql`excluded.body`,
          author: sql`excluded.author`,
          territory: sql`excluded.territory`,
          createdAt: sql`excluded.created_at`,
          ingestedAt: sql`excluded.ingested_at`,
        },
        // The row's workspace never changes: the conflict key includes the
        // connection, which belongs to exactly one workspace.
        setWhere: eq(schema.appReviews.workspaceId, input.workspaceId),
      })
      .returning({ id: schema.appReviews.providerReviewId });
    stored += written.length;
  }

  let deleted = 0;
  for (const window of input.windows) {
    const returned = input.reviews
      .filter((review) => review.resource === window.resource)
      .map((review) => review.id);
    const conditions = [
      eq(schema.appReviews.workspaceId, input.workspaceId),
      eq(schema.appReviews.connectionId, input.connectionId),
      eq(schema.appReviews.resourceId, window.resource),
      gte(schema.appReviews.createdAt, new Date(window.from)),
      lt(schema.appReviews.createdAt, new Date(window.to)),
    ];
    if (returned.length > 0) {
      conditions.push(notInArray(schema.appReviews.providerReviewId, returned));
    }
    const gone = await tx
      .delete(schema.appReviews)
      .where(and(...conditions))
      .returning({ id: schema.appReviews.providerReviewId });
    deleted += gone.length;
  }
  return { stored, deleted };
}

/**
 * Deletes every stored review of a connection: its reviews key was removed
 * (the cascade covers deleting the connection or the workspace). Returns
 * the number of reviews deleted.
 */
export async function deleteConnectionAppReviews(
  tx: Transaction,
  workspaceId: string,
  connectionId: string,
): Promise<number> {
  const gone = await tx
    .delete(schema.appReviews)
    .where(
      and(
        eq(schema.appReviews.workspaceId, workspaceId),
        eq(schema.appReviews.connectionId, connectionId),
      ),
    )
    .returning({ id: schema.appReviews.providerReviewId });
  return gone.length;
}

/**
 * "Hide this review" (ADR 0019 §11, moderation): no widget shows the review
 * again. Hiding twice keeps the first time. Returns the review's app, or
 * null when the connection has no such review in the workspace.
 */
export async function hideAppReview(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    providerReviewId: string;
    now: Date;
  },
): Promise<{ resourceId: string; hiddenAt: Date } | null> {
  const [row] = await tx
    .update(schema.appReviews)
    .set({
      hiddenAt: sql`coalesce(${schema.appReviews.hiddenAt}, ${input.now.toISOString()}::timestamptz)`,
    })
    .where(
      and(
        eq(schema.appReviews.workspaceId, input.workspaceId),
        eq(schema.appReviews.connectionId, input.connectionId),
        eq(schema.appReviews.providerReviewId, input.providerReviewId),
      ),
    )
    .returning({
      resourceId: schema.appReviews.resourceId,
      hiddenAt: schema.appReviews.hiddenAt,
    });
  return row && row.hiddenAt
    ? { resourceId: row.resourceId, hiddenAt: row.hiddenAt }
    : null;
}

/** A stored review as the latest-review widget shows it. */
export interface LatestAppReview {
  providerReviewId: string;
  resourceId: string;
  rating: number;
  title: string | null;
  body: string | null;
  author: string | null;
  territory: string | null;
  createdAt: Date;
}

/**
 * The newest review of a connection (one app's, or any app's) that is not
 * hidden, has at least `minRating` stars and, with `requireText`, a body
 * (ADR 0019 section 12). Null when none matches. This is the only read of
 * review text: one review per widget, never a list.
 */
export async function findLatestAppReview(
  tx: Transaction,
  input: {
    workspaceId: string;
    connectionId: string;
    resourceId?: string | null;
    minRating: number;
    requireText: boolean;
  },
): Promise<LatestAppReview | null> {
  const t = schema.appReviews;
  const [row] = await tx
    .select({
      providerReviewId: t.providerReviewId,
      resourceId: t.resourceId,
      rating: t.rating,
      title: t.title,
      body: t.body,
      author: t.author,
      territory: t.territory,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(
      and(
        eq(t.workspaceId, input.workspaceId),
        eq(t.connectionId, input.connectionId),
        input.resourceId != null
          ? eq(t.resourceId, input.resourceId)
          : undefined,
        isNull(t.hiddenAt),
        gte(t.rating, input.minRating),
        input.requireText
          ? sql`coalesce(btrim(${t.body}), '') <> ''`
          : undefined,
      ),
    )
    .orderBy(desc(t.createdAt), desc(t.providerReviewId))
    .limit(1);
  return row ?? null;
}

export interface AppReviewPruneResult {
  expiredDeleted: number;
  surplusDeleted: number;
}

/**
 * Applies AppReviewRetentionPolicy as of `now` (scheduler role;
 * prune_app_reviews is SECURITY DEFINER, migration 0039). A count equal to
 * `batch` means more rows remain for the next call.
 */
export async function pruneAppReviews(
  schedulerDb: Db | Transaction,
  now: Date,
  policy: AppReviewRetentionPolicy = APP_REVIEW_RETENTION,
): Promise<AppReviewPruneResult> {
  const [row] = await schedulerDb.execute<{
    expired_deleted: number;
    surplus_deleted: number;
  }>(
    sql`select * from prune_app_reviews(
          ${now.toISOString()}::timestamptz,
          make_interval(days => ${policy.maxAgeDays}),
          ${policy.keepPerResource},
          ${policy.batch}
        )`,
  );
  return {
    expiredDeleted: row?.expired_deleted ?? 0,
    surplusDeleted: row?.surplus_deleted ?? 0,
  };
}
