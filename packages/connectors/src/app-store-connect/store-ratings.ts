import { createHash, randomUUID } from "node:crypto";

import type {
  ConnectorRuntime,
  DatasetRecord,
  SourceDatasetDefinition,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import { ITUNES_LOOKUP_URL, LOOKUP_BATCH_SIZE } from "./icons.js";

/** All-version ratings for one storefront; never a cross-store average. */
export const storeRatingsDataset: SourceDatasetDefinition = {
  key: "store_ratings",
  name: "App Store rating snapshots",
  version: 1,
  grain: "One app and storefront per UTC collection day",
  mode: "upsert",
  keyFields: ["app_id", "storefront", "day"],
  reportingField: "day",
  reportingTimeZone: "UTC",
  // The installation/workspace policy can shorten this. No provider-mandated
  // expiry for these public aggregate facts; no review text is collected here.
  retentionDays: null,
  fields: [
    {
      id: "app_id",
      name: "Apple app ID",
      type: "string",
      nullable: false,
      classification: "public",
    },
    {
      id: "storefront",
      name: "Storefront country",
      type: "string",
      nullable: false,
      classification: "public",
    },
    {
      id: "day",
      name: "Collection day (UTC)",
      type: "date",
      nullable: false,
      classification: "public",
    },
    {
      id: "captured_at",
      name: "Collection started at",
      type: "timestamp",
      nullable: false,
      classification: "public",
    },
    {
      id: "app_name",
      name: "App name",
      type: "string",
      nullable: true,
      classification: "public",
    },
    {
      id: "rating",
      name: "Overall store rating",
      type: "decimal",
      unit: "stars",
      nullable: true,
      classification: "public",
    },
    {
      id: "rating_count",
      name: "Overall rating count",
      type: "integer",
      nullable: true,
      classification: "public",
    },
    {
      id: "availability",
      name: "Rating availability",
      type: "string",
      nullable: false,
      classification: "public",
    },
    {
      id: "provider_fields",
      name: "Original rating fields",
      type: "json",
      nullable: true,
      classification: "public",
    },
  ],
};

export function ratingStorefront(config: Record<string, unknown>): string {
  const value = config.ratingStorefront ?? "US";
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value.trim())) {
    throw new Error(
      "Enter a two-letter country code for the rating storefront.",
    );
  }
  return value.trim().toUpperCase();
}

const ratingEntry = z.object({
  trackId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  trackName: z.string().max(1_000).optional(),
  averageUserRating: z.number().finite().min(0).max(5).optional(),
  userRatingCount: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  averageUserRatingForCurrentVersion: z
    .number()
    .finite()
    .min(0)
    .max(5)
    .optional(),
  userRatingCountForCurrentVersion: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
});
const envelope = z.object({ results: z.array(z.unknown()).max(1_000) });

/** Lookup is public: signed tokens must never reach this host. */
export async function readStoreRatings(
  runtime: ConnectorRuntime,
  appIds: string[],
  storefront: string,
  capturedAt: string,
): Promise<DatasetRecord[]> {
  if (appIds.length === 0) return [];
  if (
    appIds.length > LOOKUP_BATCH_SIZE ||
    appIds.some((id) => !/^\d+$/.test(id))
  ) {
    throw new Error("Invalid App Store rating lookup batch");
  }
  const url = new URL(ITUNES_LOOKUP_URL);
  url.searchParams.set("id", appIds.join(","));
  url.searchParams.set("country", storefront.toLowerCase());
  let results: unknown[] | undefined;
  try {
    const response = await runtime.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (response.status === 200) {
      const body = envelope.safeParse(response.json());
      if (body.success) results = body.data.results;
    }
  } catch {
    if (runtime.signal.aborted)
      throw new Error("App Store rating lookup cancelled");
    // Do not retain provider errors or fail the independent sales/analytics.
  }
  // A failed lookup (status, transport error, unexpected envelope) is no
  // observation: a record would replace the day's earlier good snapshot
  // under the upsert key, so none is emitted and that value stays.
  if (results === undefined) return [];
  const byId = new Map<string, unknown[]>();
  for (const result of results) {
    if (typeof result !== "object" || result === null || !("trackId" in result))
      continue;
    const id = String(result.trackId);
    byId.set(id, [...(byId.get(id) ?? []), result]);
  }
  return appIds.flatMap((appId) => {
    const entries = byId.get(appId) ?? [];
    const parsed =
      entries.length === 1 ? ratingEntry.safeParse(entries[0]) : null;
    const item = parsed?.success ? parsed.data : undefined;
    // An ambiguous or malformed answer for one app is no observation either.
    if (entries.length > 1 || (entries.length === 1 && !item)) return [];
    const count = item?.userRatingCount ?? null;
    const score = item?.averageUserRating;
    const rating = score !== undefined && score > 0 ? String(score) : null;
    const availability =
      entries.length === 0
        ? "not_listed"
        : count === 0 && rating === null
          ? "unrated"
          : count !== null && count > 0 && rating !== null
            ? "available"
            : "incomplete";
    return {
      values: {
        app_id: appId,
        storefront,
        day: capturedAt.slice(0, 10),
        captured_at: capturedAt,
        app_name: item?.trackName ?? null,
        rating,
        rating_count: count,
        availability,
        provider_fields: item
          ? Object.fromEntries(
              Object.entries(item).filter(
                ([key]) => key !== "trackName" && key !== "trackId",
              ),
            )
          : null,
      },
    };
  });
}

const STATE_PREFIX = "store-ratings:";
const LEGACY_PREFIX = "store-ratings-done:";
const stateSchema = z.object({
  refresh: z.uuid(),
  capturedAt: z.iso.datetime(),
  signature: z.string().regex(/^[a-f0-9]{64}$/),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  continuation: z.string().optional(),
});

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decode(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid App Store rating checkpoint");
  }
}

/**
 * Publish ratings before a potentially long sales backfill. The continuation
 * wraps the existing sales/analytics/reviews protocol without changing its
 * final timestamp cursor. Page ingestion and cursor advancement are atomic in
 * the host, so a refresh never skips an uncommitted batch.
 */
export async function syncWithStoreRatings(
  request: SyncRequest,
  runtime: ConnectorRuntime,
  options: {
    storefront: string;
    now: number;
    appIds: () => Promise<string[]>;
    legacy: (request: SyncRequest) => Promise<SyncResult>;
  },
): Promise<SyncResult> {
  if (request.cursor?.startsWith(LEGACY_PREFIX)) {
    const cursor =
      z
        .string()
        .nullable()
        .parse(decode(request.cursor.slice(LEGACY_PREFIX.length))) ?? undefined;
    const result = await options.legacy({ ...request, cursor });
    if (!result.done && !result.nextCursor)
      throw new Error("App Store sync omitted its checkpoint");
    return result.done
      ? result
      : { ...result, nextCursor: LEGACY_PREFIX + encode(result.nextCursor) };
  }
  const appIds = [...new Set(await options.appIds())].sort();
  const signature = createHash("sha256")
    .update(JSON.stringify([options.storefront, appIds]))
    .digest("hex");
  let state = request.cursor?.startsWith(STATE_PREFIX)
    ? stateSchema.parse(decode(request.cursor.slice(STATE_PREFIX.length)))
    : undefined;
  if (!state || state.signature !== signature) {
    state = {
      refresh: randomUUID(),
      capturedAt: new Date(options.now).toISOString(),
      signature,
      offset: 0,
      continuation: state ? state.continuation : request.cursor,
    };
  }
  if (state.offset > appIds.length || state.offset % LOOKUP_BATCH_SIZE !== 0) {
    throw new Error("Invalid App Store rating checkpoint");
  }
  const end = Math.min(state.offset + LOOKUP_BATCH_SIZE, appIds.length);
  const complete = end === appIds.length;
  const records = await readStoreRatings(
    runtime,
    appIds.slice(state.offset, end),
    options.storefront,
    state.capturedAt,
  );
  return {
    observations: [],
    datasetPages: [
      {
        datasetKey: storeRatingsDataset.key,
        schemaVersion: 1,
        refreshKey: state.refresh,
        pageKey: String(state.offset),
        previousPageKey:
          state.offset === 0 ? null : String(state.offset - LOOKUP_BATCH_SIZE),
        records,
        complete,
      },
    ],
    nextCursor: complete
      ? LEGACY_PREFIX + encode(state.continuation ?? null)
      : STATE_PREFIX + encode({ ...state, offset: end }),
    done: false,
  };
}
