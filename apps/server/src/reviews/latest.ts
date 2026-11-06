import type {
  ConnectionStateView,
  DeviceTileStatus,
  LatestReviewResponse,
  ReviewWidgetOptions,
} from "@netrics/contracts";
import { findLatestAppReview, type Transaction } from "@netrics/database";

import { decryptCredentials, type CredentialKeyring } from "../credentials.js";
import { tileStatus } from "../devices/dashboard.js";
import { REVIEWS_KEY_ID } from "../signed-keys/app-store-reviews.js";

// The latest-review widget's data (ADR 0019 section 12), the same for the
// screens' payload and the Studio: the newest review of the connection (one
// app's, or any app's) that is not hidden and matches the widget's options.
// Review text and nicknames never reach a log or an error from here.

/**
 * Whether a connection holds the optional reviews key (#190): its stored
 * envelope names one. Read without any provider call; an envelope that
 * cannot be opened counts as none. Nothing of the envelope leaves here.
 */
export function storedReviewsKey(
  row: {
    id: string;
    workspaceId: string;
    credentialsEncrypted: Buffer | null;
  },
  keyring: CredentialKeyring,
): boolean {
  if (!row.credentialsEncrypted) return false;
  try {
    const stored = JSON.parse(
      decryptCredentials(row.credentialsEncrypted.toString("utf8"), keyring, {
        workspaceId: row.workspaceId,
        connectionId: row.id,
      }),
    ) as Record<string, unknown>;
    return stored[REVIEWS_KEY_ID] != null;
  } catch {
    return false;
  }
}

export interface LatestReviewInput {
  workspaceId: string;
  connectionId: string;
  /** One app of the connection; null: all its apps. */
  resourceId: string | null;
  options: ReviewWidgetOptions;
  /** The connection's health; null when it is gone. */
  state: ConnectionStateView | null;
  /** A backfill of the connection is queued or running. */
  backfilling: boolean;
  /** The connection holds a reviews key (`storedReviewsKey`). */
  reviewsKey: boolean;
  now: Date;
}

/**
 * The widget's status and review, with the provider's review id (the
 * Studio's "Hide this review"; screens get the review without it).
 * Without a reviews key the review text is gone (ADR 0019 section 11) and
 * the widget asks for a new one: `auth_failed`, no query. The nickname
 * only with `showAuthor`.
 */
export async function latestReview(
  tx: Transaction,
  input: LatestReviewInput,
): Promise<LatestReviewResponse> {
  const updatedAt = input.state?.lastSuccessAt ?? null;
  if (!input.reviewsKey || input.state === null) {
    return {
      status: (input.state === null
        ? "no_data"
        : "auth_failed") satisfies DeviceTileStatus,
      updatedAt,
      review: null,
    };
  }
  const row = await findLatestAppReview(tx, {
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    resourceId: input.resourceId,
    minRating: input.options.minRating,
    requireText: input.options.requireText,
  });
  return {
    status: tileStatus(input.state, row !== null, input.now, input.backfilling),
    updatedAt,
    review: row
      ? {
          id: row.providerReviewId,
          rating: row.rating,
          title: row.title,
          body: row.body,
          author: input.options.showAuthor ? row.author : null,
          territory: row.territory,
          createdAt: row.createdAt.toISOString(),
        }
      : null,
  };
}
