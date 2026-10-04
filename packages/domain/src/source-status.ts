// A status board's items (ADR 0019 section 7): the health of each source
// of a workspace by the rules every widget's status follows (`tileStatus`
// on the server, with data), attention first.

/** A source's health on a status board. */
export type SourceItemStatus =
  "ok" | "stale" | "backfilling" | "auth_failed" | "outage";

/** Attention first: the order a board lists its items in. */
export const SOURCE_ITEM_STATUS_ORDER: readonly SourceItemStatus[] = [
  "auth_failed",
  "outage",
  "stale",
  "backfilling",
  "ok",
];

/**
 * Data older than this many poll intervals (at least 15 minutes) is stale,
 * as for every widget (ADR 0007).
 */
export const SOURCE_STALE_AFTER_INTERVALS = 3;
export const SOURCE_MIN_STALE_MS = 15 * 60 * 1000;

/** What decides a source's status: its connection and its sync state. */
export interface SourceStateInput {
  health: "ok" | "pending" | "auth_failed" | "needs_reauthorization" | "outage";
  lastSuccessAt: string | null;
  pollIntervalSeconds: number;
  /** Created by an OAuth authorization and not finished (ADR 0012). */
  setupPending: boolean;
  /** A backfill of the connection's history is queued or running. */
  backfilling?: boolean;
}

/**
 * A source's status at `now` (ms): a failing connection first (a grant
 * that needs reauthorization and a setup not finished are `auth_failed`:
 * someone has to act), then the first sync or a backfill (`backfilling`),
 * then the age of the last success against three poll intervals (at least
 * 15 minutes): `stale` when older or never, else `ok`.
 */
export function sourceItemStatus(
  state: SourceStateInput,
  now: number,
): SourceItemStatus {
  if (state.health === "auth_failed" || state.health === "outage") {
    return state.health;
  }
  if (state.health === "needs_reauthorization" || state.setupPending) {
    return "auth_failed";
  }
  if (state.health === "pending" || state.backfilling === true) {
    return "backfilling";
  }
  if (state.lastSuccessAt === null) return "stale";
  const age = now - Date.parse(state.lastSuccessAt);
  const limit = Math.max(
    SOURCE_STALE_AFTER_INTERVALS * state.pollIntervalSeconds * 1000,
    SOURCE_MIN_STALE_MS,
  );
  return age > limit ? "stale" : "ok";
}

/** The rank of a status in the board's order; unknown ones last. */
export function sourceStatusRank(status: string): number {
  const at = (SOURCE_ITEM_STATUS_ORDER as readonly string[]).indexOf(status);
  return at < 0 ? SOURCE_ITEM_STATUS_ORDER.length : at;
}

/**
 * A board's items in its order: attention first (auth_failed, outage,
 * stale, backfilling, ok), then by name (case-insensitive, by code point,
 * so every runtime agrees), then by id.
 */
export function sortSourceItems<
  T extends { connectionId: string; name: string; status: string },
>(items: readonly T[]): T[] {
  const key = (name: string) => name.toLowerCase();
  return [...items].sort((a, b) => {
    const rank = sourceStatusRank(a.status) - sourceStatusRank(b.status);
    if (rank !== 0) return rank;
    const an = key(a.name);
    const bn = key(b.name);
    if (an !== bn) return an < bn ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.connectionId < b.connectionId
      ? -1
      : a.connectionId > b.connectionId
        ? 1
        : 0;
  });
}

/** What a board's footer counts ("4 connected · 1 delayed"). */
export interface StatusCounts {
  /** Every source on the board. */
  connected: number;
  /** Synced, but not recently (`stale`). */
  delayed: number;
  /** Failing: credentials, reauthorization, setup or an outage. */
  failing: number;
}

export function statusCounts(
  items: ReadonlyArray<{ status: string }>,
): StatusCounts {
  let delayed = 0;
  let failing = 0;
  for (const item of items) {
    if (item.status === "stale") delayed += 1;
    else if (item.status === "auth_failed" || item.status === "outage") {
      failing += 1;
    }
  }
  return { connected: items.length, delayed, failing };
}

/** At most this many chosen sources per board (`connectionIds`). */
export const STATUS_MAX_CONNECTIONS = 12;
