import type {
  Observation,
  ReviewWindow,
  SyncReview,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  ascErrorBody,
  type AppStoreConnectClient,
} from "./api.js";
import {
  SALES_REPORT_FILTERS,
  latestReportDate,
  pacificToday,
  vendorNumberOf,
  type ProbeResult,
} from "./probes.js";
import { OTHERS, UNKNOWN } from "./sales-sync.js";
import { territoryAlpha2 } from "./territories.js";

// Ratings and reviews (ADR 0014, decision 2, #190): read with a second,
// optional team key that has a review-reading role (Customer Support
// recommended). The host signs a separate token for it and hands it to the
// connector as `credentials.reviewsAccessToken`; without it, the connector
// reads no reviews and behaves exactly as before.
//
// `GET /v1/apps/{id}/customerReviews`
// (https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-customerreviews)
// sorted by `-createdDate`, 200 per page, following `links.next`. The API
// has no aggregate store rating; the metrics are counts and rating sums of
// the reviews Apple returns.
//
// Review text (ADR 0019 §11, amending ADR 0014 decision 2, #334): the same
// pages also request the title, body and reviewer nickname. The newest
// reviews of each app (at most REVIEW_TEXT_PER_APP, none older than
// REVIEW_TEXT_DAYS) go to the host as `SyncResult.reviews`, with the span
// read completely as a `reviewWindows` entry. Review text and nicknames are
// personal data: they never appear in log lines or error messages here.

const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = "app_store_connect";

export const REVIEW_METRIC_KEYS = {
  reviews: `${PREFIX}.reviews`,
  reviewsByTerritory: `${PREFIX}.reviews_by_territory`,
  reviewsByRating: `${PREFIX}.reviews_by_rating`,
  reviewRatingSum: `${PREFIX}.review_rating_sum`,
} as const;

/** The only review fields netrics asks Apple for. */
export const REVIEW_FIELDS =
  "rating,title,body,reviewerNickname,createdDate,territory";
/** Reviews with text handed to the host per app and sync (its retention). */
export const REVIEW_TEXT_PER_APP = 50;
/** Reviews older than this are never handed to the host with text. */
export const REVIEW_TEXT_DAYS = 90;
/** Character caps of the stored text (the host cuts again on ingest). */
export const REVIEW_TEXT_LIMITS = {
  title: 300,
  body: 4_000,
  author: 100,
} as const;
/**
 * The latest start of a Pacific day after its UTC midnight (PST, UTC−8): a
 * review read for Pacific day D was created at or after D + 8 h at the
 * latest, so a window starting there never claims an unread instant.
 */
const PACIFIC_DAY_START_MAX_MS = 8 * 60 * 60 * 1000;
/** Reviews per page (Apple's maximum). */
export const REVIEWS_PAGE_SIZE = 200;
/**
 * Pages read per app and sync (3,000 reviews). An app with more reviews in
 * the window keeps the newest complete days; older days are left as they
 * are, and the log says so.
 */
export const MAX_REVIEW_PAGES = 15;
/** Apps whose reviews one sync page reads (each page has 60 s). */
export const REVIEWS_APPS_PER_PAGE = 2;
/**
 * Reporting days every incremental sync reads again, so edited and deleted
 * reviews correct the stored counts.
 */
export const REVIEWS_LOOKBACK_DAYS = 7;
/** Territories kept per app and calendar month; the rest is "Others". */
export const TOP_REVIEW_TERRITORIES = 10;
export const RATINGS = ["1", "2", "3", "4", "5"] as const;

/** The reviews key was refused during a sync: review metrics pause. */
export const REVIEWS_PAUSED_MESSAGE =
  "App Store reviews paused — upload a new reviews key. App Store Connect refused the Customer Support key (revoked, or its role no longer allows reading reviews). Sales keep syncing.";

export const REVIEWS_KEY_MISMATCH_MESSAGE =
  "App Store Connect refused the reviews key: its key ID and private key do not belong to this connection's issuer ID, or the key was revoked. Check the key ID and the .p8 file, or create a new team key with the Customer Support role.";

export const REVIEWS_ROLE_MESSAGE =
  "This key cannot read ratings and reviews. It needs the Customer Support role; Developer or Marketing also work but grant more. Sales and Finance keys cannot read reviews. Create a team key with the Customer Support role and upload it.";

export const REVIEWS_ADMIN_MESSAGE =
  "This key can also read sales reports, so it has the Admin role. netrics does not store Admin keys: create a team key with the Customer Support role for reviews, and revoke this one if you created it for netrics.";

const reviewsPageSchema = z.object({
  data: z.array(
    z
      .object({
        type: z.literal("customerReviews"),
        id: z.string().min(1),
        attributes: z
          .object({
            rating: z.number().int().min(1).max(5),
            createdDate: z.string(),
            territory: z.string().optional(),
            // Text fields are taken only when they are strings; anything
            // else is treated as absent instead of failing the page.
            title: z.unknown().optional(),
            body: z.unknown().optional(),
            reviewerNickname: z.unknown().optional(),
          })
          .loose(),
      })
      .loose(),
  ),
  links: z.object({ next: z.string().optional() }).loose().optional(),
});

/** One review as read: its Pacific day, rating, territory and text. */
export interface ReviewEntry {
  /** The Pacific-Time day of `createdDate`, as UTC midnight (ms). */
  day: number;
  rating: number;
  /** Alpha-2, or UNKNOWN (for the territory metric). */
  territory: string;
  /** Apple's review id. */
  id?: string;
  /** `createdDate` as epoch ms. */
  createdMs?: number;
  title?: string | null;
  body?: string | null;
  author?: string | null;
}

/**
 * Text as stored: at most `max` characters (code points, as PostgreSQL's
 * char_length counts them), surrounding whitespace trimmed, empty as null.
 */
export function capReviewText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const chars = Array.from(trimmed);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : trimmed;
}

export type AppReviewsResult =
  | {
      status: "read";
      reviews: ReviewEntry[];
      /**
       * Set when the page limit ended the read before `since`: the oldest
       * day seen, which may be incomplete. Days after it are complete.
       */
      truncatedAt?: number;
      /** Reviews whose createdDate could not be read (skipped). */
      unreadable: number;
    }
  /** The reviews key was refused (401) or lacks the role (403). */
  | { status: "refused"; httpStatus: 401 | 403 };

function reviewsPath(appId: string): string {
  return `/v1/apps/${encodeURIComponent(appId)}/customerReviews`;
}

/**
 * The reviews of one app created on or after the Pacific day `since`
 * (UTC midnight ms), newest first, at most MAX_REVIEW_PAGES pages. A 401
 * or 403 is answered as "refused" (it pauses reviews, never the
 * connection); 429 and other errors are thrown.
 */
export async function readAppReviews(
  client: AppStoreConnectClient,
  appId: string,
  since: number,
  maxPages = MAX_REVIEW_PAGES,
): Promise<AppReviewsResult> {
  const reviews: ReviewEntry[] = [];
  let unreadable = 0;
  let next: string | undefined = reviewsPath(appId);
  let query: Record<string, string> | undefined = {
    sort: "-createdDate",
    limit: String(REVIEWS_PAGE_SIZE),
    "fields[customerReviews]": REVIEW_FIELDS,
  };
  let oldestSeen: number | undefined;
  for (let page = 0; next !== undefined; page += 1) {
    if (page >= maxPages) {
      return {
        status: "read",
        reviews,
        unreadable,
        truncatedAt: oldestSeen ?? since,
      };
    }
    const response = await client.request(next, query);
    if (response.status === 401 || response.status === 403) {
      return { status: "refused", httpStatus: response.status };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AppStoreConnectApiError(
        response.status,
        ascErrorBody(response),
      );
    }
    const body = reviewsPageSchema.parse(response.json());
    for (const review of body.data) {
      const created = Date.parse(review.attributes.createdDate);
      if (Number.isNaN(created)) {
        unreadable += 1;
        continue;
      }
      const day = pacificToday(created);
      if (day < since) {
        // Sorted by -createdDate: everything after this is older.
        return { status: "read", reviews, unreadable };
      }
      oldestSeen = day;
      reviews.push({
        day,
        rating: review.attributes.rating,
        territory: territoryAlpha2(review.attributes.territory) ?? UNKNOWN,
        id: review.id,
        createdMs: created,
        title: capReviewText(review.attributes.title, REVIEW_TEXT_LIMITS.title),
        body: capReviewText(review.attributes.body, REVIEW_TEXT_LIMITS.body),
        author: capReviewText(
          review.attributes.reviewerNickname,
          REVIEW_TEXT_LIMITS.author,
        ),
      });
    }
    // links.next carries every query parameter (and the page cursor).
    next = body.links?.next;
    query = undefined;
  }
  return { status: "read", reviews, unreadable };
}

function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function topTerritories(
  totals: Map<string, number>,
  limit: number,
): Set<string> {
  return new Set(
    [...totals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([territory]) => territory),
  );
}

interface DayReviews {
  count: number;
  ratingSum: number;
  ratings: Map<string, number>;
  territories: Map<string, number>;
}

/**
 * The review observations of one app for the Pacific days in
 * [emitFrom, emitTo) (UTC midnight ms), from reviews read since the start
 * of emitFrom's calendar month.
 *
 * Every emitted day gets `reviews`, `review_rating_sum` and one
 * `reviews_by_rating` value per star (0 on days without reviews), so a
 * review deleted since an earlier sync corrects the stored day. The
 * territory breakdown keeps the 10 territories with the most reviews per
 * app and calendar month and groups the rest as "Others", ranked over the
 * whole month like the sales breakdown (a territory that drops out of the
 * top 10 gets an explicit 0 where it had reviews).
 */
export function reviewObservations(
  appId: string,
  reviews: readonly ReviewEntry[],
  window: { emitFrom: number; emitTo: number },
): Observation[] {
  const byDay = new Map<number, DayReviews>();
  for (const review of reviews) {
    let entry = byDay.get(review.day);
    if (!entry) {
      entry = {
        count: 0,
        ratingSum: 0,
        ratings: new Map(),
        territories: new Map(),
      };
      byDay.set(review.day, entry);
    }
    entry.count += 1;
    entry.ratingSum += review.rating;
    add(entry.ratings, String(review.rating), 1);
    add(entry.territories, review.territory, 1);
  }

  // The territory ranking of each month, and every ranking an earlier sync
  // could have used (the month up to each of its days).
  const months = new Map<
    number,
    { top: Set<string>; earlier: Set<string>; hasOthers: boolean }
  >();
  const monthTotals = new Map<number, Map<string, number>>();
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const month = startOfMonth(day);
    let totals = monthTotals.get(month);
    if (!totals) {
      totals = new Map();
      monthTotals.set(month, totals);
    }
    for (const [territory, value] of byDay.get(day)!.territories) {
      add(totals, territory, value);
    }
    const top = topTerritories(totals, TOP_REVIEW_TERRITORIES);
    const ranking = months.get(month) ?? {
      top,
      earlier: new Set<string>(),
      hasOthers: false,
    };
    ranking.top = top;
    for (const territory of top) ranking.earlier.add(territory);
    ranking.hasOthers = totals.size > TOP_REVIEW_TERRITORIES;
    months.set(month, ranking);
  }

  const observations: Observation[] = [];
  const resource = { resource: appId };
  for (let day = window.emitFrom; day < window.emitTo; day += DAY_MS) {
    const entry = byDay.get(day);
    const sourceTimestamp = new Date(day).toISOString();
    const push = (
      metricKey: string,
      value: number,
      extra: Record<string, string> = {},
    ) =>
      observations.push({
        metricKey,
        sourceTimestamp,
        value,
        dimensions: { ...resource, ...extra },
      });
    push(REVIEW_METRIC_KEYS.reviews, entry?.count ?? 0);
    push(REVIEW_METRIC_KEYS.reviewRatingSum, entry?.ratingSum ?? 0);
    for (const rating of RATINGS) {
      push(
        REVIEW_METRIC_KEYS.reviewsByRating,
        entry?.ratings.get(rating) ?? 0,
        {
          rating,
        },
      );
    }
    if (!entry) continue;
    const ranking = months.get(startOfMonth(day))!;
    let others = 0;
    for (const [territory, value] of [...entry.territories].sort((a, b) =>
      a[0].localeCompare(b[0]),
    )) {
      if (ranking.top.has(territory)) {
        push(REVIEW_METRIC_KEYS.reviewsByTerritory, value, { territory });
      } else {
        others += value;
        if (ranking.earlier.has(territory)) {
          push(REVIEW_METRIC_KEYS.reviewsByTerritory, 0, { territory });
        }
      }
    }
    if (ranking.hasOthers) {
      push(REVIEW_METRIC_KEYS.reviewsByTerritory, others, {
        territory: OTHERS,
      });
    }
  }
  return observations;
}

/**
 * The Pacific days a sync emits reviews for: from the window start (and
 * at least the last REVIEWS_LOOKBACK_DAYS) through today, never more than
 * `maxDays` back.
 */
export function reviewsWindow(
  fromIso: string,
  nowMs: number,
  maxDays: number,
): { emitFrom: number; emitTo: number; readFrom: number } {
  const today = pacificToday(nowMs);
  const from = Date.parse(fromIso);
  const requested = Number.isNaN(from) ? today : pacificToday(from);
  const emitFrom = Math.max(
    Math.min(requested, today - REVIEWS_LOOKBACK_DAYS * DAY_MS),
    today - (maxDays - 1) * DAY_MS,
  );
  return {
    emitFrom,
    emitTo: today + DAY_MS,
    // The whole month of the first day, for its territory ranking.
    readFrom: startOfMonth(emitFrom),
  };
}

/**
 * The reviews with text of one app for the host (ADR 0019 §11): the newest
 * REVIEW_TEXT_PER_APP created in the last REVIEW_TEXT_DAYS, inside the span
 * the read covered completely, and that span as a review window. When more
 * reviews qualify than are handed over, the window starts at the oldest one
 * handed over, so the host never deletes a review it was not shown for a
 * reason other than its absence at Apple (or its retention).
 */
export function reviewTextOf(
  appId: string,
  result: { reviews: readonly ReviewEntry[]; truncatedAt?: number },
  options: { now: number; readFrom: number },
): { reviews: SyncReview[]; window: ReviewWindow | null } {
  const coveredFrom =
    (result.truncatedAt !== undefined
      ? result.truncatedAt + DAY_MS
      : options.readFrom) + PACIFIC_DAY_START_MAX_MS;
  const from = Math.max(coveredFrom, options.now - REVIEW_TEXT_DAYS * DAY_MS);
  const eligible = result.reviews
    .filter(
      (review): review is ReviewEntry & { id: string; createdMs: number } =>
        review.id !== undefined &&
        review.createdMs !== undefined &&
        review.createdMs >= from,
    )
    .sort((a, b) => b.createdMs - a.createdMs || a.id.localeCompare(b.id));
  const kept = eligible.slice(0, REVIEW_TEXT_PER_APP);
  const windowFrom =
    eligible.length > REVIEW_TEXT_PER_APP ? kept.at(-1)!.createdMs : from;
  const reviews = kept.map((review): SyncReview => ({
    id: review.id,
    resource: appId,
    rating: review.rating,
    title: review.title ?? null,
    body: review.body ?? null,
    author: review.author ?? null,
    territory: review.territory === UNKNOWN ? null : review.territory,
    createdAt: new Date(review.createdMs).toISOString(),
  }));
  return {
    reviews,
    window:
      windowFrom < options.now
        ? {
            resource: appId,
            from: new Date(windowFrom).toISOString(),
            to: new Date(options.now).toISOString(),
          }
        : null,
  };
}

function isRateLimited(error: unknown): boolean {
  return (
    error instanceof AppStoreConnectRateBudgetError ||
    (error instanceof AppStoreConnectApiError && error.status === 429)
  );
}

/**
 * Reads the reviews of the given apps with the reviews key. Reviews never
 * stop sales or the connection: a refused key ends the reviews of this run
 * ("paused"), a rate limit postpones them, and any other failure skips that
 * app; each is logged without tokens or review content.
 */
export async function syncReviewApps(
  client: AppStoreConnectClient,
  appIds: readonly string[],
  options: {
    now: number;
    from: string;
    maxDays: number;
    log: (message: string) => void;
  },
): Promise<{
  observations: Observation[];
  reviews: SyncReview[];
  reviewWindows: ReviewWindow[];
  stop: boolean;
}> {
  const window = reviewsWindow(options.from, options.now, options.maxDays);
  const observations: Observation[] = [];
  const reviews: SyncReview[] = [];
  const reviewWindows: ReviewWindow[] = [];
  const done = (stop: boolean) => ({
    observations,
    reviews,
    reviewWindows,
    stop,
  });
  for (const appId of appIds) {
    let result: AppReviewsResult;
    try {
      result = await readAppReviews(client, appId, window.readFrom);
    } catch (error) {
      if (isRateLimited(error)) {
        options.log(
          "App Store reviews postponed: the reviews key's hourly request budget is used up",
        );
        return done(true);
      }
      const message =
        error instanceof AppStoreConnectApiError
          ? error.message
          : error instanceof Error
            ? error.name
            : "Error";
      options.log(
        `App Store reviews of app ${appId} skipped: ${message.slice(0, 300)}`,
      );
      continue;
    }
    if (result.status === "refused") {
      options.log(
        `${REVIEWS_PAUSED_MESSAGE} (HTTP ${result.httpStatus} for app ${appId})`,
      );
      return done(true);
    }
    let emitFrom = window.emitFrom;
    if (result.truncatedAt !== undefined) {
      // The oldest day read may be incomplete: keep only later days.
      emitFrom = Math.max(emitFrom, result.truncatedAt + DAY_MS);
      options.log(
        `App Store reviews of app ${appId}: more than ${MAX_REVIEW_PAGES * REVIEWS_PAGE_SIZE} reviews in the window; days before ${new Date(emitFrom).toISOString().slice(0, 10)} were not read again`,
      );
    }
    if (result.unreadable > 0) {
      options.log(
        `App Store reviews of app ${appId}: ${result.unreadable} reviews without a readable creation date were not counted`,
      );
    }
    observations.push(
      ...reviewObservations(appId, result.reviews, {
        emitFrom,
        emitTo: window.emitTo,
      }),
    );
    const text = reviewTextOf(appId, result, {
      now: options.now,
      readFrom: window.readFrom,
    });
    reviews.push(...text.reviews);
    if (text.window) reviewWindows.push(text.window);
  }
  return done(false);
}

// ─── Probes of a candidate reviews key (run by the host before storing) ────

/**
 * The reviews key reads `GET /v1/apps/{id}/customerReviews?limit=1` for an
 * app of the connection. 401: the key ID and private key do not belong to
 * the issuer, or the key was revoked; 403: the role cannot read reviews.
 */
export async function probeCustomerReviews(
  client: AppStoreConnectClient,
  appId: string,
): Promise<ProbeResult> {
  const response = await client.request(reviewsPath(appId), {
    limit: "1",
    "fields[customerReviews]": "rating",
  });
  if (response.status >= 200 && response.status < 300) return { ok: true };
  const body = ascErrorBody(response);
  if (response.status === 429 || response.status >= 500) {
    throw new AppStoreConnectApiError(response.status, body);
  }
  if (response.status === 401) {
    return { ok: false, message: REVIEWS_KEY_MISMATCH_MESSAGE };
  }
  if (response.status === 403) {
    return { ok: false, message: REVIEWS_ROLE_MESSAGE };
  }
  return {
    ok: false,
    message: new AppStoreConnectApiError(response.status, body).message,
  };
}

/**
 * An app to probe the reviews key with: the connection's first selected
 * app, else the first app the key lists. Undefined when the team has none.
 */
export async function reviewsProbeApp(
  client: AppStoreConnectClient,
  config: Readonly<Record<string, unknown>>,
): Promise<string | undefined | ProbeResult> {
  const selection = config.resourceSelection;
  if (Array.isArray(selection)) {
    const first = selection.find(
      (id): id is string => typeof id === "string" && /^\d+$/.test(id),
    );
    if (first) return first;
  }
  const response = await client.request("/v1/apps", {
    limit: "1",
    "fields[apps]": "name",
  });
  if (response.status === 401) {
    return { ok: false, message: REVIEWS_KEY_MISMATCH_MESSAGE };
  }
  if (response.status < 200 || response.status >= 300) {
    const body = ascErrorBody(response);
    if (response.status === 429 || response.status >= 500) {
      throw new AppStoreConnectApiError(response.status, body);
    }
    return { ok: false, message: REVIEWS_ROLE_MESSAGE };
  }
  const parsed = z
    .object({ data: z.array(z.object({ id: z.string() }).loose()) })
    .loose()
    .safeParse(response.json());
  return parsed.success ? parsed.data.data[0]?.id : undefined;
}

/**
 * The least-privilege check: a key that reads reviews AND sales reports
 * has the Admin role (review readers are Customer Support, Developer,
 * Marketing, App Manager and Admin; sales readers are Sales, Finance and
 * Admin; ADR 0014). Such a key is refused. A 403 on the sales report is
 * the expected answer; 404 (no sales that day) means the role was accepted.
 */
export async function probeReviewsKeyNotAdmin(
  client: AppStoreConnectClient,
  config: Readonly<Record<string, unknown>>,
  nowMs: number,
): Promise<ProbeResult> {
  const vendorNumber = vendorNumberOf(config);
  if (!vendorNumber) return { ok: true };
  const response = await client.request(
    "/v1/salesReports",
    {
      ...SALES_REPORT_FILTERS,
      "filter[vendorNumber]": vendorNumber,
      "filter[reportDate]": latestReportDate(nowMs),
    },
    "application/a-gzip, application/json",
  );
  if (response.status === 429 || response.status >= 500) {
    throw new AppStoreConnectApiError(response.status, ascErrorBody(response));
  }
  if (
    (response.status >= 200 && response.status < 300) ||
    response.status === 404
  ) {
    return { ok: false, message: REVIEWS_ADMIN_MESSAGE };
  }
  return { ok: true };
}
