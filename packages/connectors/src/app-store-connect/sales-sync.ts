import type {
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import {
  AppStoreConnectApiError,
  ascErrorBody,
  type AppStoreConnectClient,
} from "./api.js";
import {
  SALES_REPORT_FILTERS,
  latestReportDay,
  pacificToday,
} from "./probes.js";
import {
  inflateReport,
  parseSalesReport,
  productCategory,
  rowProceeds,
  toMinorUnits,
  type SalesRow,
} from "./sales-report.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = "app_store_connect";

/** Apple keeps daily reports for one year: the backfill reads 365 days. */
export const BACKFILL_DAYS = 365;
/** Reporting days every incremental sync reads again (revisions upsert). */
export const INCREMENTAL_LOOKBACK_DAYS = 3;
/** Territories kept per app and calendar month; the rest is "Others". */
export const TOP_TERRITORIES = 10;
export const OTHERS = "Others";
/** Device or territory missing from a row. */
export const UNKNOWN = "Unknown";
/** Daily reports fetched at once within one sync page. */
export const REPORT_CONCURRENCY = 4;
/**
 * A 400 naming `filter[reportDate]` for a day this old is a day Apple no
 * longer keeps (retention is about a year), not a bug: it reads as empty.
 */
const RETENTION_EDGE_DAYS = 330;

export const SALES_METRIC_KEYS = {
  downloads: `${PREFIX}.downloads`,
  downloadsByTerritory: `${PREFIX}.downloads_by_territory`,
  downloadsByDevice: `${PREFIX}.downloads_by_device`,
  redownloads: `${PREFIX}.redownloads`,
  updates: `${PREFIX}.updates`,
  iapUnits: `${PREFIX}.iap_units`,
  proceeds: `${PREFIX}.proceeds`,
} as const;

export interface SalesSyncOptions {
  now: number;
  vendorNumber: string;
  /** SKU → Apple ID of every app of the team (for in-app purchases). */
  listAppSkus: () => Promise<Map<string, string>>;
  /** Product type codes the mapping does not know (code only, no data). */
  log: (message: string) => void;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ADR 0008: Apple's reporting date D is stamped D T00:00:00Z. */
function stamp(ms: number): string {
  return new Date(ms).toISOString();
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function startOfNextMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** A day's report: its rows, or "pending" when it is not published yet. */
type DayReport = SalesRow[] | "pending";

/**
 * Reads one reporting day. A 404 for a day whose report should exist (D + 1
 * at 12:00 PT has passed) is a day without sales; for a more recent day it
 * is a report not published yet (ADR 0014, "404 has two meanings").
 */
async function readDay(
  client: AppStoreConnectClient,
  vendorNumber: string,
  dayMs: number,
  latestMs: number,
  oldestKeptMs: number,
): Promise<DayReport> {
  const response = await client.request(
    "/v1/salesReports",
    {
      ...SALES_REPORT_FILTERS,
      "filter[vendorNumber]": vendorNumber,
      "filter[reportDate]": day(dayMs),
    },
    "application/a-gzip, application/json",
  );
  if (response.status === 200) {
    return parseSalesReport(inflateReport(response.bytes()));
  }
  if (response.status === 404) {
    return dayMs <= latestMs ? [] : "pending";
  }
  const body = ascErrorBody(response);
  if (
    response.status === 400 &&
    body.parameter === "filter[reportDate]" &&
    dayMs < oldestKeptMs
  ) {
    return [];
  }
  throw new AppStoreConnectApiError(response.status, body);
}

/** Runs `task` for every item, at most `limit` at a time, in input order. */
export async function mapLimited<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index]!);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

interface DayTotals {
  downloads: number;
  redownloads: number;
  updates: number;
  iapUnits: number;
  /** First downloads per territory. */
  territories: Map<string, number>;
  /** First downloads per device. */
  devices: Map<string, number>;
  /** Exact proceeds per currency of proceeds. */
  proceeds: Map<string, bigint>;
}

function emptyTotals(): DayTotals {
  return {
    downloads: 0,
    redownloads: 0,
    updates: 0,
    iapUnits: 0,
    territories: new Map(),
    devices: new Map(),
    proceeds: new Map(),
  };
}

function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

/** Sums of decimal units, without binary noise (units have 2 decimals). */
function units(value: number): number {
  return Math.round(value * 100) / 100 || 0;
}

/** The `limit` largest territories, ties by code. */
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

/**
 * One sync page: one calendar month of reporting days.
 *
 * The territory breakdown keeps the 10 largest territories per app and
 * calendar month (ADR 0014). They are ranked over every published day of
 * the month, so each page reads the whole month (up to the latest
 * published day) and emits only the days inside the requested window: a
 * day gets the same values whichever window asks for it.
 *
 * While a month is still running, its ranking can change from one sync to
 * the next. A territory that dropped out of the top 10 gets an explicit 0
 * on the re-read days where it has downloads (they move to "Others"), so a
 * value stored under the earlier ranking is overwritten instead of being
 * counted twice. Only territories that led some earlier part of the month
 * (a ranking an earlier sync could have used) get these zeros, so the
 * series count stays bounded.
 */
export async function syncSalesPage(
  client: AppStoreConnectClient,
  request: SyncRequest,
  options: SalesSyncOptions,
): Promise<SyncResult> {
  const todayMs = pacificToday(options.now);
  // Yesterday (PT) is the newest day that can be published; before noon PT
  // it may not be yet (then it is "pending").
  const newestMs = todayMs - DAY_MS;
  const latestMs = latestReportDay(options.now);
  const oldestMs = todayMs - (BACKFILL_DAYS - 1) * DAY_MS;
  const oldestKeptMs = todayMs - RETENTION_EDGE_DAYS * DAY_MS;

  const fromMs = Date.parse(request.from);
  const toMs = Date.parse(request.to);
  const startMs = Math.max(
    startOfUtcDay(request.cursor ? Date.parse(request.cursor) : fromMs),
    oldestMs,
  );
  // Days before `to`, never after yesterday (PT).
  const endMs = Math.min(startOfUtcDay(toMs - 1) + DAY_MS, newestMs + DAY_MS);

  const resumeAt = (resolvedEndMs: number) =>
    stamp(
      Math.max(
        resolvedEndMs - INCREMENTAL_LOOKBACK_DAYS * DAY_MS,
        startOfUtcDay(fromMs),
      ),
    );

  const selected =
    request.resources === undefined ? undefined : new Set(request.resources);
  if (startMs >= endMs || selected?.size === 0) {
    return { observations: [], nextCursor: resumeAt(endMs), done: true };
  }

  const monthStart = startOfMonth(startMs);
  const monthEnd = startOfNextMonth(startMs);
  const readFrom = Math.max(monthStart, oldestMs);
  const readTo = Math.min(monthEnd, newestMs + DAY_MS);
  const days: number[] = [];
  for (let ms = readFrom; ms < readTo; ms += DAY_MS) days.push(ms);

  const reports = await mapLimited(days, REPORT_CONCURRENCY, (dayMs) =>
    readDay(client, options.vendorNumber, dayMs, latestMs, oldestKeptMs),
  );
  const published = new Map<number, SalesRow[]>();
  let pendingMs: number | undefined;
  days.forEach((dayMs, index) => {
    const report = reports[index]!;
    if (report === "pending") {
      pendingMs ??= dayMs;
    } else if (pendingMs === undefined) {
      published.set(dayMs, report);
    }
  });

  // In-app purchases name their app by SKU (Parent Identifier); the app rows
  // of the same reports give most SKUs, the team's app list the rest.
  const appBySku = new Map<string, string>();
  const unknownTypes = new Set<string>();
  for (const rows of published.values()) {
    for (const row of rows) {
      const category = productCategory(row.productType);
      if (category && category !== "iap" && category !== "restore") {
        if (row.sku && row.appleId) appBySku.set(row.sku, row.appleId);
      }
    }
  }
  const needsListing = [...published.values()].some((rows) =>
    rows.some(
      (row) =>
        productCategory(row.productType) === "iap" &&
        !appBySku.has(row.parentId),
    ),
  );
  if (needsListing) {
    for (const [sku, appId] of await options.listAppSkus()) {
      if (!appBySku.has(sku)) appBySku.set(sku, appId);
    }
  }

  // Totals per app and day.
  const totals = new Map<string, Map<number, DayTotals>>();
  const totalsOf = (appId: string, dayMs: number) => {
    let byDay = totals.get(appId);
    if (!byDay) {
      byDay = new Map();
      totals.set(appId, byDay);
    }
    let entry = byDay.get(dayMs);
    if (!entry) {
      entry = emptyTotals();
      byDay.set(dayMs, entry);
    }
    return entry;
  };
  for (const [dayMs, rows] of published) {
    for (const row of rows) {
      const category = productCategory(row.productType);
      if (category === undefined) {
        unknownTypes.add(row.productType);
        continue;
      }
      if (category === "restore") continue;
      const appId =
        category === "iap" ? appBySku.get(row.parentId) : row.appleId;
      if (!appId) continue;
      if (selected && !selected.has(appId)) continue;
      const entry = totalsOf(appId, dayMs);
      switch (category) {
        case "download":
          entry.downloads += row.units;
          add(entry.territories, row.countryCode || UNKNOWN, row.units);
          add(entry.devices, row.device || UNKNOWN, row.units);
          break;
        case "redownload":
          entry.redownloads += row.units;
          break;
        case "update":
          entry.updates += row.units;
          break;
        case "iap":
          entry.iapUnits += row.units;
          break;
      }
      const amount = rowProceeds(row.rawUnits, row.proceeds);
      if (amount !== 0n) {
        if (!/^[A-Z]{3}$/.test(row.currency)) {
          throw new Error(
            "App Store sales report has proceeds without a currency code",
          );
        }
        entry.proceeds.set(
          row.currency,
          (entry.proceeds.get(row.currency) ?? 0n) + amount,
        );
      }
    }
  }
  for (const code of [...unknownTypes].sort()) {
    options.log(
      `App Store sales report: unknown product type "${code.slice(0, 20)}" counted in no metric`,
    );
  }

  // Emitted: days of this month inside the window that are published (or
  // known to have had no sales).
  const emitFrom = Math.max(startMs, monthStart);
  const emitTo = Math.min(
    monthEnd,
    endMs,
    pendingMs ?? Number.POSITIVE_INFINITY,
  );
  const emitDays = [...published.keys()].filter(
    (dayMs) => dayMs >= emitFrom && dayMs < emitTo,
  );
  const apps = selected ? [...selected] : [...totals.keys()];
  apps.sort();

  const observations: Observation[] = [];
  for (const appId of apps) {
    const byDay = totals.get(appId) ?? new Map<number, DayTotals>();
    // The month's ranking, and every ranking an earlier sync could have
    // used (the month up to each of its days).
    const monthTotals = new Map<string, number>();
    const earlierLeaders = new Set<string>();
    let top = new Set<string>();
    for (const dayMs of [...byDay.keys()].sort((a, b) => a - b)) {
      for (const [territory, value] of byDay.get(dayMs)!.territories) {
        add(monthTotals, territory, value);
      }
      top = topTerritories(monthTotals, TOP_TERRITORIES);
      for (const territory of top) earlierLeaders.add(territory);
    }
    const hasOthers = monthTotals.size > TOP_TERRITORIES;
    const resource = { resource: appId };

    for (const dayMs of emitDays) {
      const entry = byDay.get(dayMs) ?? emptyTotals();
      const sourceTimestamp = stamp(dayMs);
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
      push(SALES_METRIC_KEYS.downloads, units(entry.downloads));
      push(SALES_METRIC_KEYS.redownloads, units(entry.redownloads));
      push(SALES_METRIC_KEYS.updates, units(entry.updates));
      push(SALES_METRIC_KEYS.iapUnits, units(entry.iapUnits));

      let others = 0;
      for (const [territory, value] of [...entry.territories].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        if (top.has(territory)) {
          push(SALES_METRIC_KEYS.downloadsByTerritory, units(value), {
            territory,
          });
        } else {
          others += value;
          if (earlierLeaders.has(territory)) {
            push(SALES_METRIC_KEYS.downloadsByTerritory, 0, { territory });
          }
        }
      }
      if (hasOthers && entry.territories.size > 0) {
        push(SALES_METRIC_KEYS.downloadsByTerritory, units(others), {
          territory: OTHERS,
        });
      }
      for (const [device, value] of [...entry.devices].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        push(SALES_METRIC_KEYS.downloadsByDevice, units(value), { device });
      }
      for (const [currency, amount] of [...entry.proceeds].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        push(SALES_METRIC_KEYS.proceeds, toMinorUnits(amount, currency), {
          currency,
        });
      }
    }
  }

  if (pendingMs === undefined && monthEnd < endMs) {
    return { observations, nextCursor: stamp(monthEnd), done: false };
  }
  // The next sync starts a few days back (revisions), and never after a
  // day that is not published yet.
  return {
    observations,
    nextCursor: resumeAt(Math.min(endMs, pendingMs ?? endMs)),
    done: true,
  };
}
