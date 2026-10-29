import type {
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import type { AppleAdsClient } from "./api.js";
import { OTHERS, TOP_COUNTRIES } from "./metrics.js";
import {
  addDayValues,
  AppleAdsReportError,
  appleAdsDimensions,
  countryValue,
  isZeroDayValues,
  parseDayMetrics,
  valueObservations,
  zeroDayValues,
  type AppleAdsRowIdentity,
  type DayValues,
} from "./observations.js";
import {
  countryOf,
  daySpan,
  MAX_REPORT_DAYS,
  readCampaignReport,
  rowDays,
  type DayRange,
  type ReportRow,
} from "./reports.js";

// The campaign report sync (ADR 0020 sections 6 to 8, #374).
//
// The main `apple_ads.*` metrics hold only campaign × country or region
// rows (owner decision 2026-10-29): for every campaign and day the named
// countries plus "Others" add up to the campaign's total, so an unfiltered
// sum is the ad account's total and nothing is counted twice. Two passes
// per range read the campaign totals and the `countryOrRegion` breakdown;
// what the breakdown leaves out of a total (rows Apple hides, a country it
// does not name) is stored under "Others" too.
//
// Windows. A sync reads whole calendar months (the top 10 countries are
// ranked per campaign and month) in requests of at most 90 days, from the
// newest month backwards so recent data shows first. Each page of the sync
// is one such request range; the cursor names the next one, so a 429 in the
// middle of a backfill resumes there. Every sync re-reads the last
// LOOKBACK_DAYS days: attribution settles late.

/** Days a backfill reads: 12 months, capped by Apple's retention (#370). */
export const APPLE_ADS_BACKFILL_DAYS = 365;
/**
 * Days every sync reads again, today included: Apple's attribution settles
 * over a few days (ADR 0020 section 8). TO BE CONFIRMED by #370: whether
 * the day before yesterday still changes.
 */
export const LOOKBACK_DAYS = 3;

const CURSOR_PREFIX = "apple-ads:1";

export interface CampaignSyncOptions {
  now: number;
  adAccountId: string;
  /** The ad account's currency (ISO 4217): spend in any other is refused. */
  currency: string;
  /** The ad account's time zone (IANA): its days are Apple's ORTZ days. */
  timeZone: string;
  note: (code: string, message: string) => void;
}

// ─── Days ───────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** YYYY-MM-DD of a UTC instant. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS);
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(day: string): string {
  const date = new Date(`${monthStart(day)}T00:00:00.000Z`);
  return utcDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

/**
 * Today in the ad account's time zone: the newest ORTZ day. An unknown
 * zone is refused rather than read as UTC, which would shift every day.
 */
export function adAccountToday(nowMs: number, timeZone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(nowMs));
  } catch {
    throw new AppleAdsReportError(
      `The ad account's time zone "${timeZone.slice(0, 64)}" is unknown`,
    );
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

/**
 * Where a sync is: the oldest day it emits (`floor`), the newest day it
 * read first (`newest`, where the next sync's lookback starts from), and
 * the newest day of the next range to read (`next`).
 */
export interface SyncPosition {
  floor: string;
  newest: string;
  next: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function encodeCursor(position: SyncPosition): string {
  return `${CURSOR_PREFIX}:${position.floor}:${position.newest}:${position.next}`;
}

/** The position in a cursor of this connector, or undefined. */
export function decodeCursor(
  cursor: string | undefined,
): SyncPosition | undefined {
  if (!cursor?.startsWith(`${CURSOR_PREFIX}:`)) return undefined;
  const [floor, newest, next] = cursor
    .slice(CURSOR_PREFIX.length + 1)
    .split(":");
  if (
    [floor, newest, next].every(
      (day) =>
        day !== undefined &&
        DAY_PATTERN.test(day) &&
        utcDay(Date.parse(`${day}T00:00:00.000Z`)) === day,
    )
  ) {
    return { floor: floor!, newest: newest!, next: next! };
  }
  return undefined;
}

/**
 * The range a page reads: whole months, newest first, ending at `next`,
 * as many as fit in MAX_REPORT_DAYS, never before `oldest` (retention) or
 * the month of `floor`.
 */
export function chunkRange(position: SyncPosition, oldest: string): DayRange {
  const end = position.next;
  let start = maxDay(monthStart(end), oldest);
  const floorMonth = monthStart(position.floor);
  for (;;) {
    if (monthStart(start) <= floorMonth || start <= oldest) break;
    const previous = maxDay(monthStart(addDays(start, -1)), oldest);
    if (daySpan({ start: previous, end }) > MAX_REPORT_DAYS) break;
    start = previous;
  }
  return { start, end };
}

// ─── Rows ───────────────────────────────────────────────────────────────────

interface CampaignDays {
  app: string;
  campaign: string;
  /** Totals of the campaign per day (the pass without groupBy). */
  totals: Map<string, DayValues>;
  /** Per day, per country or region (the countryOrRegion pass). */
  countries: Map<string, Map<string, DayValues>>;
}

function campaignOf(
  campaigns: Map<string, CampaignDays>,
  row: ReportRow,
  selected: Set<string> | undefined,
): CampaignDays | undefined {
  const app = row.metadata.promotedObjectId;
  if (app === null || app === undefined || app === "") {
    // TO BE CONFIRMED by #370: `promotedObjectId` names the promoted app.
    throw new AppleAdsReportError(
      "Apple Ads report has a campaign without its promoted app",
    );
  }
  const dimensions = appleAdsDimensions({
    app,
    campaign: row.metadata.id,
  } as AppleAdsRowIdentity);
  const appId = dimensions.resource!;
  const campaignId = dimensions.campaign!;
  if (selected && !selected.has(appId)) return undefined;
  let entry = campaigns.get(campaignId);
  if (!entry) {
    entry = {
      app: appId,
      campaign: campaignId,
      totals: new Map(),
      countries: new Map(),
    };
    campaigns.set(campaignId, entry);
  }
  return entry;
}

function inRange(day: string, range: DayRange): boolean {
  return day >= range.start && day <= range.end;
}

// ─── Ranking ────────────────────────────────────────────────────────────────

/** The `limit` largest countries by spend, then impressions, then code. */
function topCountries(
  totals: Map<string, DayValues>,
  limit: number,
): Set<string> {
  return new Set(
    [...totals.entries()]
      .sort(
        (a, b) =>
          b[1].spend - a[1].spend ||
          b[1].impressions - a[1].impressions ||
          a[0].localeCompare(b[0]),
      )
      .slice(0, limit)
      .map(([country]) => country),
  );
}

function sumOf(values: Iterable<DayValues>): DayValues {
  let sum = zeroDayValues();
  for (const value of values) sum = addDayValues(sum, value);
  return sum;
}

/**
 * The observations of one campaign in one month, for the days in `emit`.
 *
 * The 10 countries with the most spend in the month keep their names; the
 * rest, and whatever the breakdown leaves out of the campaign's total, are
 * "Others". The month is ranked over every day read (the whole month), so
 * a day gets the same values whichever window asks for it.
 *
 * While a month runs, its ranking can change between syncs. A country that
 * dropped out of the top 10 gets an explicit 0 on the days where it has
 * data (they moved to "Others"), so a value stored under an earlier ranking
 * is overwritten instead of counted twice. Only countries that led some
 * earlier part of the month (a ranking an earlier sync could have used)
 * get these zeros, as App Store Connect's territories do.
 *
 * A day without data is zero only once it is older than the lookback: then
 * the named series of the month get explicit zeros, so a day Apple revised
 * away does not keep an earlier value. Recent days without data are left
 * out, as Apple may still be filling them.
 */
function monthObservations(
  entry: CampaignDays,
  month: string,
  emit: DayRange,
  settledBefore: string,
  currency: string,
): Observation[] {
  const inMonth = (day: string) => monthStart(day) === month;
  const days = [
    ...new Set([
      ...[...entry.totals.keys()].filter(inMonth),
      ...[...entry.countries.keys()].filter(inMonth),
    ]),
  ].sort();
  if (days.length === 0) return [];

  const totalOf = (day: string) =>
    entry.totals.get(day) ??
    sumOf((entry.countries.get(day) ?? new Map()).values());

  const monthTotals = new Map<string, DayValues>();
  const earlierLeaders = new Set<string>();
  let top = new Set<string>();
  let hasGap = false;
  for (const day of days) {
    const byCountry = entry.countries.get(day) ?? new Map<string, DayValues>();
    for (const [country, values] of byCountry) {
      monthTotals.set(
        country,
        addDayValues(monthTotals.get(country) ?? zeroDayValues(), values),
      );
    }
    const gap = addDayValues(totalOf(day), sumOf(byCountry.values()), -1);
    if (!isZeroDayValues(gap)) hasGap = true;
    top = topCountries(monthTotals, TOP_COUNTRIES);
    for (const country of top) earlierLeaders.add(country);
  }
  const hasOthers = hasGap || monthTotals.size > TOP_COUNTRIES;
  const named = [...top].sort();

  const observations: Observation[] = [];
  const push = (country: string, day: string, values: DayValues) =>
    observations.push(
      ...valueObservations(
        { app: entry.app, campaign: entry.campaign, country },
        day,
        values,
        currency,
      ),
    );

  const first = maxDay(emit.start, month);
  const last = minDay(emit.end, monthEnd(month));
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const settled = day < settledBefore;
    const byCountry = entry.countries.get(day);
    const hasData = entry.totals.has(day) || byCountry !== undefined;
    if (!hasData) {
      if (settled) {
        for (const country of named) push(country, day, zeroDayValues());
        if (hasOthers) push(OTHERS, day, zeroDayValues());
      }
      continue;
    }
    const countries = byCountry ?? new Map<string, DayValues>();
    let others = addDayValues(totalOf(day), sumOf(countries.values()), -1);
    for (const country of [...countries.keys()].sort()) {
      const values = countries.get(country)!;
      if (top.has(country)) {
        push(country, day, values);
      } else {
        others = addDayValues(others, values);
        if (earlierLeaders.has(country)) push(country, day, zeroDayValues());
      }
    }
    if (settled) {
      for (const country of named) {
        if (!countries.has(country)) push(country, day, zeroDayValues());
      }
    }
    if (hasOthers) push(OTHERS, day, others);
  }
  return observations;
}

// ─── Page ───────────────────────────────────────────────────────────────────

/**
 * One page of the campaign sync: one range of whole months (at most 90
 * days), its campaign totals and country breakdown, as observations for
 * the days of the requested window in it.
 */
export async function syncCampaignPage(
  api: AppleAdsClient,
  request: SyncRequest,
  options: CampaignSyncOptions,
): Promise<SyncResult> {
  const today = adAccountToday(options.now, options.timeZone);
  const oldest = addDays(today, -(APPLE_ADS_BACKFILL_DAYS - 1));
  // Days stored as zero when Apple has nothing for them.
  const settledBefore = addDays(today, -(LOOKBACK_DAYS - 1));

  let position = decodeCursor(request.cursor);
  if (!position) {
    // The window's days: from `from` (or an incremental's resume stamp)
    // to today in the ad account's zone. Days are stamped D T00:00:00Z.
    const resumeMs = request.cursor ? Date.parse(request.cursor) : Number.NaN;
    const from = utcDay(
      Number.isNaN(resumeMs) ? Date.parse(request.from) : resumeMs,
    );
    // An ad account east of UTC is a day ahead of `to`'s UTC date.
    const end = minDay(today, addDays(utcDay(Date.parse(request.to) - 1), 1));
    position = { floor: maxDay(from, oldest), newest: end, next: end };
  }
  // The next sync starts LOOKBACK_DAYS before the newest day read.
  const resume = `${addDays(position.newest, -(LOOKBACK_DAYS - 1))}T00:00:00.000Z`;

  const selected =
    request.resources === undefined ? undefined : new Set(request.resources);
  if (
    position.next < position.floor ||
    position.next < oldest ||
    selected?.size === 0
  ) {
    return { observations: [], nextCursor: resume, done: true };
  }

  const range = chunkRange(position, oldest);
  const emit: DayRange = {
    start: maxDay(range.start, position.floor),
    end: range.end,
  };

  const [totalRows, countryRows] = [
    await readCampaignReport(api, {
      adAccountId: options.adAccountId,
      range,
      byCountry: false,
    }),
    await readCampaignReport(api, {
      adAccountId: options.adAccountId,
      range,
      byCountry: true,
    }),
  ];

  const parseOptions = {
    accountCurrency: options.currency,
    note: options.note,
  };
  const campaigns = new Map<string, CampaignDays>();
  for (const row of totalRows) {
    const entry = campaignOf(campaigns, row, selected);
    if (!entry) continue;
    for (const raw of rowDays(row, range)) {
      const { date, values } = parseDayMetrics(raw, parseOptions);
      if (inRange(date, range)) entry.totals.set(date, values);
    }
  }
  for (const row of countryRows) {
    const entry = campaignOf(campaigns, row, selected);
    if (!entry) continue;
    for (const raw of rowDays(row, range)) {
      const { date, values } = parseDayMetrics(raw, parseOptions);
      if (!inRange(date, range)) continue;
      const reported = countryOf(row, raw);
      // A row without a country or region adds to the gap: "Others".
      if (reported === undefined) continue;
      const country = countryValue(reported);
      let byCountry = entry.countries.get(date);
      if (!byCountry) {
        byCountry = new Map();
        entry.countries.set(date, byCountry);
      }
      byCountry.set(country, values);
    }
  }

  const observations: Observation[] = [];
  const months: string[] = [];
  for (let month = monthStart(range.start); month <= range.end;) {
    months.push(month);
    month = addDays(monthEnd(month), 1);
  }
  for (const campaign of [...campaigns.keys()].sort()) {
    for (const month of months) {
      observations.push(
        ...monthObservations(
          campaigns.get(campaign)!,
          month,
          emit,
          settledBefore,
          options.currency,
        ),
      );
    }
  }

  if (range.start <= position.floor || range.start <= oldest) {
    return { observations, nextCursor: resume, done: true };
  }
  return {
    observations,
    nextCursor: encodeCursor({ ...position, next: addDays(range.start, -1) }),
    done: false,
  };
}
