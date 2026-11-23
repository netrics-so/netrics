// The Hetzner Cloud sync, as a resumable run (#872).
//
// A run is a sequence of steps, each exactly one GET request:
//
//   1. pricing: the price list (`/pricing`), kept in the cursor until the
//      listings are priced;
//   2. listings: one page (50 items, by ID) of servers, volumes, primary
//      IPs, floating IPs, load balancers, then snapshots. Each page's
//      servers go out as `servers` rows, and every item as a `cost_items`
//      row at once;
//   3. metrics: one server's CPU, disk and network samples at a one-hour
//      step for up to 20 days of the window.
//
// A sync page runs at most MAX_REQUESTS_PER_PAGE steps and checkpoints the
// position after the last one in its cursor, so a retry repeats the step
// that failed, never one before it. A failure after a successful step ends
// the page with what it read. The cursor is bound to the connection and a
// salted, shortened hash of the token (never the token). Snapshots are
// completed only by the last page of a run, which carries nothing else,
// and only when every part of them was read in one consistent listing.
//
// A finished run leaves a cursor of its own (`hetzner-cloud.done1:`): the
// resources whose cost it reported, so the next run reports zero for one
// that no longer holds anything, instead of leaving its last value.

import { createHash } from "node:crypto";

import {
  DATASET_LIMITS,
  RateLimitedError,
  type ConnectionContext,
  type ConnectorLogger,
  type DatasetPage,
  type DatasetRecord,
  type FreshnessEntry,
  type Observation,
  type SyncRequest,
  type SyncResult,
} from "@netrics/connector-sdk";

import { boundFreshness } from "../freshness.js";

import { HetznerApiError, type HetznerGet } from "./api.js";
import {
  floatingIpItem,
  loadBalancerItem,
  minorOf,
  priceBook,
  primaryIpItem,
  serverItems,
  serverResource,
  snapshotItem,
  volumeItem,
  type CostItem,
  type PriceBook,
} from "./cost.js";
import {
  costItemsDataset,
  costRecord,
  serverRecord,
  serversDataset,
} from "./datasets.js";
import {
  checkPagination,
  floatingIpsPageSchema,
  imagesPageSchema,
  loadBalancersPageSchema,
  metricsSchema,
  parse,
  pricingSchema,
  primaryIpsPageSchema,
  serversPageSchema,
  volumesPageSchema,
  type Pagination,
} from "./schemas.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Requests per sync page. Hetzner answers a listing in well under a
 * second; ten keep a page far inside the host's call budget and spread a
 * backfill over pages, so a rate limit or failure loses at most one step.
 */
export const MAX_REQUESTS_PER_PAGE = 10;
/** A page also ends after this long, so it never runs into the call timeout. */
export const PAGE_TIME_BUDGET_MS = 20_000;
/** Items per listing request: the API's maximum. */
export const PER_PAGE = 50;
/** The step of the metrics netrics reads: one sample an hour. */
export const METRICS_STEP_SECONDS = 3_600;
/**
 * Hours per metrics request. Hetzner returns at most 500 samples and
 * widens the step beyond that; 480 one-hour samples (20 days) stay below.
 */
export const METRICS_CHUNK_HOURS = 480;
/** Hetzner keeps metrics for 30 days. */
export const METRICS_RETENTION_DAYS = 30;
/**
 * An hour is read once it ended this long ago, so its sample is final
 * before netrics stores it.
 */
export const METRICS_SETTLE_MS = 10 * 60 * 1000;
/** Rows and bytes per dataset page, well inside ADR 0026's limits. */
const PAGE_ROWS = 500;
const PAGE_BYTES = DATASET_LIMITS.pageBytes / 2;
/**
 * A page starts no further step once its rows fill this many dataset
 * pages: one listing step adds at most seven (50 rows of up to 64 KiB in
 * pages of 512 KiB), and a result carries at most 20.
 */
const MAX_PENDING_PAGES = DATASET_LIMITS.datasets - 9;

/** Freshness streams (ADR 0025). */
export const SERVERS_STREAM = "servers";
export const METRICS_STREAM = "metrics";
export const COST_STREAM = "cost";

export const METRICS = {
  /**
   * Hetzner's own CPU value: percent of one vCPU (a 4-vCPU server reaches
   * 400). Not divided by the cores: the API has no history of them, and a
   * resize would rescale every earlier hour.
   */
  cpu: "hetzner-cloud.cpu_vcpu_percent",
  diskRead: "hetzner-cloud.disk_read",
  diskWrite: "hetzner-cloud.disk_write",
  networkIn: "hetzner-cloud.network_in",
  networkOut: "hetzner-cloud.network_out",
  monthlyCost: "hetzner-cloud.monthly_cost",
} as const;

/** Hetzner's time series → netrics metric (the first disk and interface). */
const SERIES: Readonly<Record<string, string>> = {
  cpu: METRICS.cpu,
  "disk.0.bandwidth.read": METRICS.diskRead,
  "disk.0.bandwidth.write": METRICS.diskWrite,
  "network.0.bandwidth.in": METRICS.networkIn,
  "network.0.bandwidth.out": METRICS.networkOut,
};

// ─── Time ───────────────────────────────────────────────────────────────────

function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ─── Run state (the cursor) ─────────────────────────────────────────────────

/** The listings a run reads, in order. */
export const LISTINGS = [
  "servers",
  "volumes",
  "primary_ips",
  "floating_ips",
  "load_balancers",
  "images",
] as const;
type ListingKind = (typeof LISTINGS)[number];

/** Where the current listing is. Dropped whenever the run moves on. */
interface ListingProgress {
  kind: ListingKind;
  page: number;
  /** `total_entries` of the first page, when Hetzner named it. */
  total: number | null;
  /** IDs read so far, to notice an item a shifted page repeats. */
  seen: number[];
}

interface RunState {
  v: 1;
  /** The connection, and a fingerprint of its token (never the token). */
  connection: string;
  scope: string;
  /** When the run started: the clock of all its pages. */
  at: number;
  refresh: string;
  /** The metrics window, whole hours [from, to). */
  metricsFrom: number;
  metricsTo: number;
  /** The price list, until every listing is priced. */
  book?: PriceBook;
  currency?: string;
  listing?: ListingProgress;
  listed?: boolean;
  /** Server IDs in reading order. */
  servers: number[];
  /**
   * The server listing changed while it was read: a server may be left
   * out, so the metrics window is not advanced past this run's.
   */
  serversShifted?: boolean;
  /** Resources whose cost the previous finished run reported. */
  previous: string[];
  /** Monthly cost per resource: [net, gross] in 10^-12 units, as strings. */
  totals: Record<string, [string, string]>;
  /** Resources with an item the price list has no price for. */
  unpriced: string[];
  /** Metrics: the next server, and where its window continues. */
  metricsIndex: number;
  metrics?: { from: number };
  /** Servers whose metrics window was read whole. */
  metricsRead: number[];
  /**
   * A listing changed while it was read (an item repeated, the total
   * moved) or a server disappeared during the run: the snapshot it feeds
   * is left incomplete, so the stored one stays.
   */
  serversPartial?: boolean;
  costPartial?: boolean;
  /** Dataset refresh chains: last page key per dataset, page counter. */
  last: Record<string, string | null>;
  pages: number;
  /** Every step is done and the last rows went out: the next page ends. */
  finishing?: boolean;
  /**
   * A later step of the last page hit the rate limit: its progress went
   * out, and the next page hands the limit to the host before it sends
   * anything (ms since the epoch).
   */
  limitedUntil?: number;
}

const CURSOR_PREFIX = "hetzner-cloud.v1:";
const DONE_PREFIX = "hetzner-cloud.done1:";

/** What a finished run hands to the next one. */
interface DoneState {
  v: 1;
  connection: string;
  scope: string;
  /** Resources with a reported cost (or a stored one not yet replaced). */
  reported: string[];
}

function encodeDone(state: DoneState): string {
  return DONE_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url");
}

/** The last finished run's state, of this connection and token only. */
function decodeDone(
  cursor: string | undefined,
  connection: string,
  scope: string,
): DoneState | null {
  if (!cursor?.startsWith(DONE_PREFIX)) return null;
  try {
    const state = JSON.parse(
      Buffer.from(cursor.slice(DONE_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as DoneState;
    return state.v === 1 &&
      state.connection === connection &&
      state.scope === scope &&
      Array.isArray(state.reported) &&
      state.reported.every((resource) => typeof resource === "string")
      ? state
      : null;
  } catch {
    return null;
  }
}

/** A salted, shortened hash of the token: another token starts a new run. */
export function scopeOf(connectionId: string, token: string): string {
  return createHash("sha256")
    .update(`hetzner-cloud-cursor|${connectionId}|${token}`)
    .digest("hex")
    .slice(0, 16);
}

function encodeState(state: RunState): string {
  return (
    CURSOR_PREFIX + Buffer.from(JSON.stringify(state)).toString("base64url")
  );
}

/** A checkpoint of this connection and token; anything else is null. */
function decodeState(
  cursor: string | undefined,
  connection: string,
  scope: string,
): RunState | null {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return null;
  try {
    const state = JSON.parse(
      Buffer.from(cursor.slice(CURSOR_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as RunState;
    return state.v === 1 &&
      state.connection === connection &&
      state.scope === scope
      ? state
      : null;
  } catch {
    return null;
  }
}

// ─── Pages ──────────────────────────────────────────────────────────────────

/** Records split into pages within the row and byte bounds. */
function chunks(records: DatasetRecord[]): DatasetRecord[][] {
  const result: DatasetRecord[][] = [];
  let current: DatasetRecord[] = [];
  let bytes = 0;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (
      current.length > 0 &&
      (current.length >= PAGE_ROWS || bytes + size > PAGE_BYTES)
    ) {
      result.push(current);
      current = [];
      bytes = 0;
    }
    current.push(record);
    bytes += size;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function datasetPage(
  state: RunState,
  datasetKey: string,
  records: DatasetRecord[],
  complete: boolean,
): DatasetPage {
  state.pages += 1;
  const pageKey = `p${String(state.pages).padStart(6, "0")}`;
  const page: DatasetPage = {
    datasetKey,
    schemaVersion: 1,
    refreshKey: `${state.refresh}:${datasetKey}`,
    pageKey,
    previousPageKey: state.last[datasetKey] ?? null,
    records,
    complete,
  };
  state.last[datasetKey] = pageKey;
  return page;
}

// ─── The run ────────────────────────────────────────────────────────────────

export interface HetznerSyncOptions {
  now: () => number;
  log?: ConnectorLogger;
}

/** Puts the run back as it was before a step that failed. */
function restore(run: RunState, before: RunState): void {
  for (const key of Object.keys(run) as Array<keyof RunState>) {
    if (!(key in before)) delete run[key];
  }
  Object.assign(run, before);
}

/** Failures no later step can get past: the page fails. */
function isFatal(error: unknown): boolean {
  return error instanceof HetznerApiError && error.kind === "auth";
}

function addUnits(
  totals: RunState["totals"],
  resource: string,
  monthly: [bigint, bigint],
): void {
  const [net, gross] = totals[resource] ?? ["0", "0"];
  totals[resource] = [
    (BigInt(net) + monthly[0]).toString(),
    (BigInt(gross) + monthly[1]).toString(),
  ];
}

export async function syncPage(
  get: HetznerGet,
  context: ConnectionContext,
  token: string,
  request: SyncRequest,
  options: HetznerSyncOptions,
): Promise<SyncResult> {
  const { now, log } = options;
  const pageStarted = now();
  const scope = scopeOf(context.connectionId, token);

  let state = decodeState(request.cursor, context.connectionId, scope);
  if (!state) {
    const at = now();
    const toMs = Date.parse(request.to);
    const metricsTo = Math.min(
      floorHour(toMs),
      floorHour(at - METRICS_SETTLE_MS),
    );
    const metricsFrom = Math.max(
      floorHour(Date.parse(request.from)),
      metricsTo - METRICS_RETENTION_DAYS * DAY_MS,
    );
    state = {
      v: 1,
      connection: context.connectionId,
      scope,
      at,
      refresh: createHash("sha256")
        .update(`${context.connectionId}|${scope}|${at}`)
        .digest("hex")
        .slice(0, 32),
      metricsFrom,
      metricsTo,
      servers: [],
      previous:
        decodeDone(request.cursor, context.connectionId, scope)?.reported ?? [],
      totals: {},
      unpriced: [],
      metricsIndex: 0,
      metricsRead: [],
      last: {},
      pages: 0,
    };
  }
  const run = state;
  if (run.limitedUntil !== undefined) {
    if (now() < run.limitedUntil) {
      throw new RateLimitedError(
        "Hetzner Cloud's API rate limit is used up. netrics continues once it refills.",
        new Date(run.limitedUntil),
      );
    }
    delete run.limitedUntil;
  }
  const out = {
    observations: [] as Observation[],
    servers: [] as DatasetRecord[],
    costs: [] as DatasetRecord[],
  };

  // ── Steps ──

  async function pricingStep() {
    const pricing = parse(
      pricingSchema,
      await get("/pricing"),
      "the price list",
    ).pricing;
    run.book = priceBook(pricing);
    run.currency = pricing.currency;
    run.listing = { kind: LISTINGS[0], page: 1, total: null, seen: [] };
  }

  /** One listing page: its items, and where the listing goes on. */
  async function readListing(
    kind: ListingKind,
    page: number,
  ): Promise<{
    pagination: Pagination;
    ids: number[];
    apply: (book: PriceBook, checkedAt: string) => CostItem[];
  }> {
    const json = await get(`/${kind}`, {
      page,
      per_page: PER_PAGE,
      sort: "id:asc",
      // Backups are priced as a share of their server; system and app
      // images are Hetzner's own.
      ...(kind === "images" ? { type: "snapshot" } : {}),
    });
    switch (kind) {
      case "servers": {
        const answer = parse(serversPageSchema, json, "the server list");
        return {
          pagination: answer.meta.pagination,
          ids: answer.servers.map((server) => server.id),
          apply: (book, checkedAt) =>
            answer.servers.flatMap((server) => {
              if (run.listing!.seen.includes(server.id)) return [];
              run.servers.push(server.id);
              out.servers.push(serverRecord(server, checkedAt));
              return serverItems(book, server);
            }),
        };
      }
      case "volumes": {
        const answer = parse(volumesPageSchema, json, "the volume list");
        return {
          pagination: answer.meta.pagination,
          ids: answer.volumes.map((volume) => volume.id),
          apply: (book) =>
            answer.volumes
              .filter((volume) => !run.listing!.seen.includes(volume.id))
              .map((volume) => volumeItem(book, volume)),
        };
      }
      case "primary_ips": {
        const answer = parse(primaryIpsPageSchema, json, "the primary IPs");
        return {
          pagination: answer.meta.pagination,
          ids: answer.primary_ips.map((ip) => ip.id),
          apply: (book) =>
            answer.primary_ips
              .filter((ip) => !run.listing!.seen.includes(ip.id))
              .map((ip) => primaryIpItem(book, ip)),
        };
      }
      case "floating_ips": {
        const answer = parse(floatingIpsPageSchema, json, "the floating IPs");
        return {
          pagination: answer.meta.pagination,
          ids: answer.floating_ips.map((ip) => ip.id),
          apply: (book) =>
            answer.floating_ips
              .filter((ip) => !run.listing!.seen.includes(ip.id))
              .map((ip) => floatingIpItem(book, ip)),
        };
      }
      case "load_balancers": {
        const answer = parse(
          loadBalancersPageSchema,
          json,
          "the load balancers",
        );
        return {
          pagination: answer.meta.pagination,
          ids: answer.load_balancers.map((balancer) => balancer.id),
          apply: (book) =>
            answer.load_balancers
              .filter((balancer) => !run.listing!.seen.includes(balancer.id))
              .map((balancer) => loadBalancerItem(book, balancer)),
        };
      }
      case "images": {
        const answer = parse(imagesPageSchema, json, "the snapshots");
        const servers = new Set(run.servers);
        return {
          pagination: answer.meta.pagination,
          ids: answer.images.map((image) => image.id),
          apply: (book) =>
            answer.images
              .filter((image) => !run.listing!.seen.includes(image.id))
              .map((image) => snapshotItem(book, image, servers)),
        };
      }
    }
  }

  async function listingStep(listing: ListingProgress) {
    const book = run.book!;
    const answer = await readListing(listing.kind, listing.page);
    // Nothing of the run changes before the answer is known to be whole.
    const next = checkPagination(
      answer.pagination,
      listing.page,
      answer.ids.length,
      `the ${listing.kind} list`,
    );
    const total = answer.pagination.total_entries ?? null;
    // Hetzner pages by position: an item created or deleted between two
    // pages shifts the rest, so a page may repeat an item or leave one
    // out. Either makes the listing unfit for a snapshot.
    const repeated = answer.ids.some((id) => listing.seen.includes(id));
    const moved =
      listing.page > 1 &&
      listing.total !== null &&
      total !== null &&
      total !== listing.total;
    if (repeated || moved) {
      log?.info("listing changed while it was read", { listing: listing.kind });
      run.costPartial = true;
      if (listing.kind === "servers") {
        run.serversPartial = true;
        run.serversShifted = true;
      }
    }
    const checkedAt = iso(now());
    for (const item of answer.apply(book, checkedAt)) {
      out.costs.push(costRecord(item, book.currency, checkedAt));
      if (item.monthly) addUnits(run.totals, item.resource, item.monthly);
      else if (!run.unpriced.includes(item.resource)) {
        run.unpriced.push(item.resource);
      }
    }
    if (listing.page === 1) listing.total = total;
    listing.seen.push(...answer.ids);
    if (next !== null) {
      listing.page = next;
      return;
    }
    const index = LISTINGS.indexOf(listing.kind);
    if (index + 1 < LISTINGS.length) {
      run.listing = {
        kind: LISTINGS[index + 1]!,
        page: 1,
        total: null,
        seen: [],
      };
    } else {
      delete run.listing;
      delete run.book;
      run.listed = true;
    }
  }

  function nextServer() {
    run.metricsIndex += 1;
    delete run.metrics;
  }

  async function metricsStep() {
    const serverId = run.servers[run.metricsIndex]!;
    const from = run.metrics?.from ?? run.metricsFrom;
    const to = Math.min(from + METRICS_CHUNK_HOURS * HOUR_MS, run.metricsTo);
    let answer;
    try {
      answer = parse(
        metricsSchema,
        await get(`/servers/${serverId}/metrics`, {
          type: "cpu,disk,network",
          start: iso(from),
          end: iso(to),
          step: METRICS_STEP_SECONDS,
        }),
        "the server metrics",
      ).metrics;
    } catch (error) {
      if (error instanceof HetznerApiError && error.kind === "not_found") {
        // Deleted since the listing: its row must not stay in a completed
        // snapshot, so this run completes neither the servers nor the cost.
        log?.info("server gone during the sync", { server: serverId });
        run.serversPartial = true;
        run.costPartial = true;
        nextServer();
        return;
      }
      if (error instanceof HetznerApiError && error.kind === "forbidden") {
        // Refused on its own: the other servers go on; this one's metrics
        // stay stale.
        log?.warn("server metrics refused, skipped", { server: serverId });
        nextServer();
        return;
      }
      throw error;
    }
    const resource = serverResource(serverId);
    for (const [series, data] of Object.entries(answer.time_series)) {
      const metricKey = SERIES[series];
      if (!metricKey) continue;
      // One value per hour: the samples whose time falls in it, averaged.
      const hours = new Map<number, { sum: number; count: number }>();
      for (const [seconds, raw] of data.values) {
        const value = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(value)) continue;
        const hour = floorHour(seconds * 1000);
        if (hour < from || hour >= to) continue;
        const bucket = hours.get(hour) ?? { sum: 0, count: 0 };
        bucket.sum += value;
        bucket.count += 1;
        hours.set(hour, bucket);
      }
      for (const [hour, { sum, count }] of [...hours].sort(
        ([a], [b]) => a - b,
      )) {
        out.observations.push({
          metricKey,
          sourceTimestamp: iso(hour),
          value: Math.round((sum / count) * 1e6) / 1e6,
          dimensions: { resource },
        });
      }
    }
    if (to >= run.metricsTo) {
      run.metricsRead.push(serverId);
      nextServer();
    } else {
      run.metrics = { from: to };
    }
  }

  /** The next step, or null when the run has nothing left to read. */
  function nextStep(): (() => Promise<void>) | null {
    if (!run.listed && !run.listing) return pricingStep;
    if (run.listing) {
      const listing = run.listing;
      return () => listingStep(listing);
    }
    if (
      run.metricsFrom < run.metricsTo &&
      run.metricsIndex < run.servers.length
    ) {
      return metricsStep;
    }
    return null;
  }

  const pendingPages = () =>
    chunks(out.servers).length + chunks(out.costs).length;

  // ── The page ──

  let steps = 0;
  let step = nextStep();
  while (
    step &&
    steps < MAX_REQUESTS_PER_PAGE &&
    (steps === 0 || now() - pageStarted < PAGE_TIME_BUDGET_MS) &&
    pendingPages() <= MAX_PENDING_PAGES
  ) {
    // A step's rows go out only when it succeeds.
    const mark = {
      observations: out.observations.length,
      servers: out.servers.length,
      costs: out.costs.length,
    };
    const before = JSON.stringify(run);
    try {
      await step();
    } catch (error) {
      out.observations.length = mark.observations;
      out.servers.length = mark.servers;
      out.costs.length = mark.costs;
      restore(run, JSON.parse(before) as RunState);
      // The first step's failure fails the page (the host retries it, or
      // waits for a rate limit's reset); so does a rejected token. A later
      // failure ends the page with what it read: the next page starts with
      // the failed step, and a rate limit surfaces there as itself.
      if (steps === 0 || isFatal(error)) throw error;
      if (error instanceof RateLimitedError) {
        run.limitedUntil = Date.parse(error.retryAt);
      }
      log?.warn("step failed, the next page repeats it", {
        error:
          error instanceof RateLimitedError
            ? "rate_limited"
            : error instanceof HetznerApiError
              ? error.kind
              : "unknown",
      });
      break;
    }
    steps += 1;
    step = nextStep();
  }

  const datasetPages: DatasetPage[] = [];
  for (const chunk of chunks(out.servers)) {
    datasetPages.push(datasetPage(run, serversDataset.key, chunk, false));
  }
  for (const chunk of chunks(out.costs)) {
    datasetPages.push(datasetPage(run, costItemsDataset.key, chunk, false));
  }

  const costComplete = !run.costPartial && run.currency !== undefined;
  const today = startOfUtcDay(run.at);

  // Every step done: the cost of each resource goes out on this page, which
  // is not final, and the next page completes the refreshes. The host
  // refuses a final result with an incomplete page (ADR 0026 §7), so the
  // final result carries nothing but the empty pages that complete them.
  if (!step && !run.finishing) {
    if (costComplete) {
      const currency = run.currency!;
      const observe = (resource: string, value: number) =>
        out.observations.push({
          metricKey: METRICS.monthlyCost,
          sourceTimestamp: iso(today),
          value,
          dimensions: { resource, currency },
        });
      for (const [resource, [net]] of Object.entries(run.totals).sort()) {
        // A resource with an unpriced item would be understated: its cost
        // is unknown, not zero.
        if (run.unpriced.includes(resource)) continue;
        observe(resource, minorOf(BigInt(net), currency));
      }
      // Reported before, holding nothing now (an IP assigned elsewhere, a
      // deleted server): zero, so its last value does not count on.
      for (const resource of [...run.previous].sort()) {
        if (resource in run.totals || run.unpriced.includes(resource)) continue;
        observe(resource, 0);
      }
    }
    run.finishing = true;
  }

  if (step || datasetPages.length > 0 || out.observations.length > 0) {
    return {
      observations: out.observations,
      datasetPages,
      nextCursor: encodeState(run),
      done: false,
    };
  }

  // The final page.
  const received: string[] = [];
  if (!run.serversPartial) {
    datasetPages.push(datasetPage(run, serversDataset.key, [], true));
    received.push(serversDataset.key);
  }
  if (!run.costPartial) {
    datasetPages.push(datasetPage(run, costItemsDataset.key, [], true));
    received.push(costItemsDataset.key);
  }

  const freshness: FreshnessEntry[] = [];
  if (!run.serversPartial) freshness.push({ stream: SERVERS_STREAM });
  // Only servers whose metrics this run read (ADR 0025 §2): not a refused
  // one, and none when no hour completed since the last sync.
  for (const id of run.metricsRead) {
    freshness.push({ stream: METRICS_STREAM, resource: serverResource(id) });
  }
  if (costComplete && run.unpriced.length === 0) {
    freshness.push({ stream: COST_STREAM });
  }
  const bounded = boundFreshness(
    freshness,
    run.servers.map((id) => serverResource(id)),
  );

  // The next window starts with the first hour not read yet. A server
  // listing that shifted may have left a server out, whose hours are all
  // unread: the window stays where it was.
  const resumeAt = iso(
    Math.min(
      Date.parse(request.to),
      run.serversShifted
        ? run.metricsFrom
        : Math.max(run.metricsTo, run.metricsFrom),
    ),
  );
  // The resources with a cost the dashboards hold now: those reported, and
  // the earlier ones this run could not price (their value stays stored).
  const reported = costComplete
    ? [
        ...Object.keys(run.totals).filter(
          (resource) => !run.unpriced.includes(resource),
        ),
        ...run.previous.filter((resource) => run.unpriced.includes(resource)),
      ].sort()
    : run.previous;
  return {
    observations: [],
    datasetPages,
    receivedDatasets: received,
    ...(bounded.length > 0 ? { freshness: bounded } : {}),
    nextCursor: encodeDone({
      v: 1,
      connection: run.connection,
      scope: run.scope,
      reported,
    }),
    nextFrom: resumeAt,
    done: true,
  };
}
