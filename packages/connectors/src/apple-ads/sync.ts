import type {
  Observation,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";

import { AppleAdsApiError, type AppleAdsClient } from "./api.js";
import { APPLE_ADS_DIMENSIONS, OTHERS, TOP_COUNTRIES } from "./metrics.js";
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
  readAdGroupReport,
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
//
// Ad groups (#376). The ad-group report needs a `campaignId`, so it fans
// out per campaign over the same ranges, days and lookback. Its rows go to
// the `*_by_ad_group` keys (never the main ones), one series per campaign
// and ad group, no country breakdown. Campaigns without any numbers in the
// days a page writes (by the totals pass) are skipped. A page reads the
// ad groups of at most AD_GROUP_CAMPAIGNS_PER_PAGE campaigns, by campaign
// ID ascending; while campaigns of a range remain, the cursor keeps the
// range and the last campaign done (`after`), and the next page reads the
// range's totals again (one request) and goes on after that campaign. A
// campaign removed in between is simply not in the totals any more, and
// IDs compare as numbers, so the cursor never depends on it. What a
// campaign's ad groups leave out of its total (Apple answers 404 for a
// deleted campaign, TO BE CONFIRMED by #370) is the ad group "Others", so
// ad-group sums equal campaign sums.

/** Days a backfill reads: 12 months, capped by Apple's retention (#370). */
export const APPLE_ADS_BACKFILL_DAYS = 365;
/**
 * Days every sync reads again, today included: Apple's attribution settles
 * over a few days (ADR 0020 section 8). TO BE CONFIRMED by #370: whether
 * the day before yesterday still changes.
 */
export const LOOKBACK_DAYS = 3;

/**
 * Campaigns whose ad-group reports one sync page reads (#376). A page has
 * 60 seconds and a run at most 100 pages: 10 campaigns plus the totals is
 * about a dozen requests a page, and a 12-month backfill of five ranges
 * covers about 190 campaigns with numbers per range in one run.
 */
export const AD_GROUP_CAMPAIGNS_PER_PAGE = 10;

const CURSOR_PREFIX = "apple-ads:1";

/** Note code: a deleted campaign had no ad-group report (404). */
export const DELETED_CAMPAIGN_NOTE = "apple_ads.deleted_campaign_ad_groups";

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
 * the newest day of the next range to read (`next`). In the middle of a
 * range's ad-group fan-out (#376), `after` is the last campaign whose ad
 * groups were read: the next page continues that range after it.
 */
export interface SyncPosition {
  floor: string;
  newest: string;
  next: string;
  after?: string;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CAMPAIGN_ID_PATTERN = /^(0|[1-9]\d{0,18})$/;

export function encodeCursor(position: SyncPosition): string {
  const base = `${CURSOR_PREFIX}:${position.floor}:${position.newest}:${position.next}`;
  return position.after === undefined ? base : `${base}:${position.after}`;
}

/** The position in a cursor of this connector, or undefined. */
export function decodeCursor(
  cursor: string | undefined,
): SyncPosition | undefined {
  if (!cursor?.startsWith(`${CURSOR_PREFIX}:`)) return undefined;
  const parts = cursor.slice(CURSOR_PREFIX.length + 1).split(":");
  const [floor, newest, next, after] = parts;
  if (
    parts.length <= 4 &&
    [floor, newest, next].every(
      (day) =>
        day !== undefined &&
        DAY_PATTERN.test(day) &&
        utcDay(Date.parse(`${day}T00:00:00.000Z`)) === day,
    ) &&
    (after === undefined || CAMPAIGN_ID_PATTERN.test(after))
  ) {
    return {
      floor: floor!,
      newest: newest!,
      next: next!,
      ...(after === undefined ? {} : { after }),
    };
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
  /** Apple marks the campaign deleted (`metadata.deleted`). */
  deleted: boolean;
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
      deleted: false,
      totals: new Map(),
      countries: new Map(),
    };
    campaigns.set(campaignId, entry);
  }
  if (row.metadata.deleted === true) entry.deleted = true;
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

// ─── Ad groups ──────────────────────────────────────────────────────────────

/** Ad group ID → day → its numbers, of one campaign in one range. */
type AdGroupDays = Map<string, Map<string, DayValues>>;

/** Campaign IDs ascending as numbers ("9" before "10"). */
function byCampaignId(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Whether a campaign has any numbers on a day the page writes. */
function hasNumbers(entry: CampaignDays, emit: DayRange): boolean {
  for (const [day, values] of entry.totals) {
    if (inRange(day, emit) && !isZeroDayValues(values)) return true;
  }
  return false;
}

/**
 * One campaign's ad-group report for the range: its ad groups' days. A
 * deleted campaign Apple answers 404 for has none (its total becomes the
 * ad group "Others"); any other error is the page's.
 */
async function adGroupDays(
  api: AppleAdsClient,
  entry: CampaignDays,
  range: DayRange,
  options: CampaignSyncOptions,
): Promise<AdGroupDays> {
  let rows: ReportRow[];
  try {
    rows = await readAdGroupReport(api, {
      adAccountId: options.adAccountId,
      range,
      campaignId: entry.campaign,
    });
  } catch (error) {
    // TO BE CONFIRMED by #370: what Apple answers for a deleted campaign.
    if (
      entry.deleted &&
      error instanceof AppleAdsApiError &&
      error.status === 404
    ) {
      options.note(
        DELETED_CAMPAIGN_NOTE,
        "Apple Ads has no ad groups for a deleted campaign; its numbers are kept under the ad group Others.",
      );
      return new Map();
    }
    throw error;
  }
  const parseOptions = {
    accountCurrency: options.currency,
    note: options.note,
  };
  const adGroups: AdGroupDays = new Map();
  for (const row of rows) {
    const adGroup = appleAdsDimensions({
      app: entry.app,
      campaign: entry.campaign,
      adGroup: row.metadata.id,
    } as AppleAdsRowIdentity)[APPLE_ADS_DIMENSIONS.adGroup]!;
    let days = adGroups.get(adGroup);
    if (!days) {
      days = new Map();
      adGroups.set(adGroup, days);
    }
    for (const raw of rowDays(row, range)) {
      const { date, values } = parseDayMetrics(raw, parseOptions);
      if (!inRange(date, range)) continue;
      days.set(date, values);
    }
  }
  return adGroups;
}

/**
 * The `*_by_ad_group` observations of one campaign in one month, for the
 * days in `emit`: each ad group's numbers, and under "Others" what the ad
 * groups leave out of the campaign's total, so the ad-group sum of every
 * day is the campaign's total (and the country sum's).
 *
 * As for countries: a settled day without data is an explicit zero for
 * every ad group with data in the month (and "Others" when it has any), so
 * a day Apple revised away does not keep an earlier value; recent days
 * without data are left out.
 */
function adGroupMonthObservations(
  entry: CampaignDays,
  adGroups: AdGroupDays,
  month: string,
  emit: DayRange,
  settledBefore: string,
  currency: string,
): Observation[] {
  const inMonth = (day: string) => monthStart(day) === month;
  const days = new Set([...entry.totals.keys()].filter(inMonth));
  const named: string[] = [];
  for (const [adGroup, byDay] of adGroups) {
    const monthDays = [...byDay.keys()].filter(inMonth);
    if (monthDays.length === 0) continue;
    named.push(adGroup);
    for (const day of monthDays) days.add(day);
  }
  if (days.size === 0) return [];
  named.sort(byCampaignId);

  const sumOn = (day: string) => {
    let sum = zeroDayValues();
    for (const byDay of adGroups.values()) {
      const values = byDay.get(day);
      if (values) sum = addDayValues(sum, values);
    }
    return sum;
  };
  const gapOn = (day: string) =>
    addDayValues(entry.totals.get(day) ?? sumOn(day), sumOn(day), -1);
  const hasOthers = [...days].some((day) => !isZeroDayValues(gapOn(day)));

  const observations: Observation[] = [];
  const push = (adGroup: string, day: string, values: DayValues) =>
    observations.push(
      ...valueObservations(
        { app: entry.app, campaign: entry.campaign, adGroup },
        day,
        values,
        currency,
      ),
    );
  const first = maxDay(emit.start, month);
  const last = minDay(emit.end, monthEnd(month));
  for (let day = first; day <= last; day = addDays(day, 1)) {
    const settled = day < settledBefore;
    if (!days.has(day)) {
      if (settled) {
        for (const adGroup of named) push(adGroup, day, zeroDayValues());
        if (hasOthers) push(OTHERS, day, zeroDayValues());
      }
      continue;
    }
    for (const adGroup of named) {
      const values = adGroups.get(adGroup)!.get(day);
      if (values) push(adGroup, day, values);
      else if (settled) push(adGroup, day, zeroDayValues());
    }
    if (hasOthers) push(OTHERS, day, gapOn(day));
  }
  return observations;
}

// ─── Page ───────────────────────────────────────────────────────────────────

/**
 * One page of the sync: one range of whole months (at most 90 days). The
 * range's first page reads the campaign totals and the country breakdown
 * (the main metrics) and the ad groups of its first
 * AD_GROUP_CAMPAIGNS_PER_PAGE campaigns with numbers; further pages of the
 * range read the totals again and the ad groups of the next campaigns.
 * Observations are for the days of the requested window in the range.
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
  // The range's first page; later pages only go on with its ad groups.
  const firstPage = position.after === undefined;

  const totalRows = await readCampaignReport(api, {
    adAccountId: options.adAccountId,
    range,
    byCountry: false,
  });
  const countryRows = firstPage
    ? await readCampaignReport(api, {
        adAccountId: options.adAccountId,
        range,
        byCountry: true,
      })
    : [];

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
  const campaignIds = [...campaigns.keys()].sort(byCampaignId);
  if (firstPage) {
    for (const campaign of campaignIds) {
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
  }

  // The ad-group fan-out: the next campaigns with numbers in the range.
  const pending = campaignIds.filter(
    (campaign) =>
      (position.after === undefined ||
        byCampaignId(campaign, position.after) > 0) &&
      hasNumbers(campaigns.get(campaign)!, emit),
  );
  const batch = pending.slice(0, AD_GROUP_CAMPAIGNS_PER_PAGE);
  for (const campaign of batch) {
    const entry = campaigns.get(campaign)!;
    const adGroups = await adGroupDays(api, entry, range, options);
    for (const month of months) {
      observations.push(
        ...adGroupMonthObservations(
          entry,
          adGroups,
          month,
          emit,
          settledBefore,
          options.currency,
        ),
      );
    }
  }
  if (pending.length > batch.length) {
    return {
      observations,
      nextCursor: encodeCursor({ ...position, after: batch.at(-1)! }),
      done: false,
    };
  }

  if (range.start <= position.floor || range.start <= oldest) {
    return { observations, nextCursor: resume, done: true };
  }
  const { after: _after, ...rest } = position;
  return {
    observations,
    nextCursor: encodeCursor({ ...rest, next: addDays(range.start, -1) }),
    done: false,
  };
}
