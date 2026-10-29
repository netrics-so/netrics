import { z } from "zod";

import type { AppleAdsClient } from "./api.js";
import { AppleAdsReportError } from "./observations.js";

// Campaign reports of the Apple Ads Platform API 1.0 (ADR 0020 section 8,
// #374): `POST /v1/reports/apps/campaigns/query` in the ad account's
// context, paged with `pagination{offset,pageSize}` until
// `pagination.totalCount`.
//
// Apple's documentation, checked 2026-10-29:
// - Campaigns report (endpoint, `groupBy` values, granularity limits:
//   `DAILY` spans at most 90 days; a single day omits `granularity` and
//   answers in `totalMetrics` only):
//   https://developer.apple.com/documentation/apple-ads-platform-api/get-app-campaign-reports
// - AppsReportingRequest (`timeRange`, `groupBy`, `pagination`, `options`;
//   `EMPTY_METRICS` cannot be combined with `groupBy`):
//   https://developer.apple.com/documentation/apple-ads-platform-api/appsreportingrequest
// - TimeRange (`start`/`end` inclusive YYYY-MM-DD, `timeZone` ORTZ):
//   https://developer.apple.com/documentation/apple-ads-platform-api/timerange
// - RequestPagination (`pageSize` at most 5000, default 100):
//   https://developer.apple.com/documentation/apple-ads-platform-api/requestpagination
// - AppsCampaignReportRow and AppsReportingCampaign (`metadata` with `id`,
//   `promotedObjectId`, `name`, `deleted`, and `countryOrRegion` for a
//   grouped row), AppsMetrics (`date` and the metrics of each
//   `granularMetrics` entry):
//   https://developer.apple.com/documentation/apple-ads-platform-api/appscampaignreportrow
//   https://developer.apple.com/documentation/apple-ads-platform-api/appsreportingcampaign
//   https://developer.apple.com/documentation/apple-ads-platform-api/appsmetrics

//
// Ad-group reports (#376): `POST /v1/reports/apps/adgroups/query`, the same
// body with the required `campaignId` filter
// (`{field: "campaignId", operator: "EQUALS", value}`), one row per ad
// group with `metadata.id` and `metadata.campaignId`, the same paging and
// day limits:
//   https://developer.apple.com/documentation/apple-ads-platform-api/get-app-ad-group-reports
//   https://developer.apple.com/documentation/apple-ads-platform-api/appsreportingadgroup

//
// Keyword reports (#396): `POST /v1/reports/apps/keywords/query`, the same
// body with the required `campaignId` filter, one row per keyword with
// `metadata.id`, `text`, `matchType`, `campaignId`, `adGroupId` and
// `deleted` (ReportingKeyword), the same day limits. `sorting` by
// `localSpend` descending is AppsReportingRequest's own example:
//   https://developer.apple.com/documentation/apple-ads-platform-api/get-app-keyword-reports
//   https://developer.apple.com/documentation/apple-ads-platform-api/reportingkeyword

export const CAMPAIGN_REPORT_PATH = "/v1/reports/apps/campaigns/query";
export const AD_GROUP_REPORT_PATH = "/v1/reports/apps/adgroups/query";
export const KEYWORD_REPORT_PATH = "/v1/reports/apps/keywords/query";
/** Days a `DAILY` report request may span (Apple's limit). */
export const MAX_REPORT_DAYS = 90;
/** Rows per report page (Apple allows up to 5000). */
export const REPORT_PAGE_SIZE = 1000;
/**
 * Report pages one query reads at most: 50,000 campaign × country rows.
 * A larger answer is refused rather than read without bound.
 */
export const MAX_REPORT_PAGES = 50;
/**
 * Keyword rows one campaign's keyword report reads (#396): one page of the
 * keywords with the most spend in the range, by Apple's `localSpend`
 * sorting. Only the top TOP_KEYWORDS of each month are stored by name and
 * the rest of the campaign is "Others" (its total minus the named ones),
 * so the long tail is never needed: a campaign costs one request whatever
 * its number of keywords.
 */
export const KEYWORD_REPORT_ROWS = 1000;
/** The breakdown of the country pass. */
export const COUNTRY_GROUP_BY = "countryOrRegion";

const appleIdValue = z.union([z.string(), z.number()]);

/**
 * One report row as netrics reads it. Unknown fields pass through; the
 * metrics of each day are parsed by parseDayMetrics.
 */
const reportRowSchema = z
  .object({
    metadata: z
      .object({
        id: appleIdValue,
        name: z.string().nullable().optional(),
        promotedObjectId: appleIdValue.nullable().optional(),
        // Ad-group and keyword rows: the campaign they belong to.
        campaignId: appleIdValue.nullable().optional(),
        // Keyword rows (#396): the keyword's text, a label.
        text: z.string().nullable().optional(),
        deleted: z.boolean().nullable().optional(),
        countryOrRegion: z.string().nullable().optional(),
      })
      .loose(),
    totalMetrics: z.record(z.string(), z.unknown()).nullable().optional(),
    granularMetrics: z
      .array(z.record(z.string(), z.unknown()))
      .nullable()
      .optional(),
  })
  .loose();
export type ReportRow = z.infer<typeof reportRowSchema>;

const reportResponseSchema = z
  .object({
    // "If no rows match the request, `result` is returned as an empty
    // object."
    result: z
      .object({ rows: z.array(reportRowSchema).nullable().optional() })
      .loose()
      .nullable()
      .optional(),
    pagination: z
      .object({ totalCount: z.number().int().nonnegative() })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

/** An inclusive range of reporting days (YYYY-MM-DD, ad account days). */
export interface DayRange {
  start: string;
  end: string;
}

export interface ReportQuery {
  adAccountId: string;
  range: DayRange;
  /** The country pass: `groupBy: ["countryOrRegion"]`. */
  byCountry: boolean;
  /**
   * The ad-group report's required `campaignId` filter (#376); campaign
   * reports have none.
   */
  campaignId?: string;
  /**
   * The keyword report (#396): `sorting` by `localSpend` descending and
   * pages of this many rows.
   */
  bySpend?: number;
}

/** Days from start to end, both included. */
export function daySpan(range: DayRange): number {
  return (
    Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) +
    1
  );
}

/**
 * The request body of one page. Days are the ad account's (`ORTZ`), so the
 * numbers match the Apple Ads UI. No `options`: rows without metrics
 * (`EMPTY_METRICS`) are not asked for, and no grand total is needed.
 */
export function reportRequestBody(
  query: ReportQuery,
  offset: number,
): Record<string, unknown> {
  const span = daySpan(query.range);
  if (span < 1 || span > MAX_REPORT_DAYS) {
    throw new Error(
      `Apple Ads report ranges span 1 to ${MAX_REPORT_DAYS} days (got ${span})`,
    );
  }
  return {
    timeRange: {
      start: query.range.start,
      end: query.range.end,
      timeZone: "ORTZ",
      // One day has no granular breakdown: Apple answers in totalMetrics.
      ...(span > 1 ? { granularity: "DAILY" } : {}),
    },
    ...(query.campaignId !== undefined
      ? {
          filters: [
            {
              field: "campaignId",
              operator: "EQUALS",
              value: query.campaignId,
            },
          ],
        }
      : {}),
    ...(query.byCountry ? { groupBy: [COUNTRY_GROUP_BY] } : {}),
    // Otherwise no `sorting`: Apple's default order is by ID, ascending, a
    // stable sequence for offsets.
    ...(query.bySpend !== undefined
      ? { sorting: [{ field: "localSpend", order: "DESC" }] }
      : {}),
    pagination: { offset, pageSize: query.bySpend ?? REPORT_PAGE_SIZE },
  };
}

/**
 * Reads every page of one report. A 429 or 5xx surfaces from the client
 * (after its own short retries) as a retryable error: the sync page fails
 * and the job resumes at its last checkpoint.
 */
async function readReport(
  api: AppleAdsClient,
  path: string,
  query: ReportQuery,
  what: string,
  /** Stop after this many pages instead of refusing more. */
  pageLimit?: number,
): Promise<ReportRow[]> {
  const rows: ReportRow[] = [];
  for (let page = 0; ; page += 1) {
    if (pageLimit !== undefined && page >= pageLimit) return rows;
    if (page >= MAX_REPORT_PAGES) {
      throw new AppleAdsReportError(
        `Apple Ads ${what} has more than ${MAX_REPORT_PAGES * REPORT_PAGE_SIZE} rows`,
      );
    }
    const parsed = reportResponseSchema.safeParse(
      await api.json(path, {
        adAccountId: query.adAccountId,
        body: reportRequestBody(query, rows.length),
      }),
    );
    if (!parsed.success) {
      throw new AppleAdsReportError(
        `Apple Ads answered the ${what} in an unexpected shape`,
      );
    }
    const pageRows = parsed.data.result?.rows ?? [];
    rows.push(...pageRows);
    const total = parsed.data.pagination?.totalCount ?? rows.length;
    if (pageRows.length === 0 || rows.length >= total) {
      return rows;
    }
  }
}

/** Refuses a row whose `campaignId` names another campaign. */
function refuseOtherCampaigns(
  rows: ReportRow[],
  campaignId: string,
  what: string,
  item: string,
): void {
  for (const row of rows) {
    const campaign = row.metadata.campaignId;
    if (
      campaign !== null &&
      campaign !== undefined &&
      String(campaign).replace(/^0+(?=\d)/, "") !== campaignId
    ) {
      throw new AppleAdsReportError(
        `Apple Ads answered the ${what} with another campaign's ${item}`,
      );
    }
  }
}

/** Every page of one campaign report (the totals or the country pass). */
export function readCampaignReport(
  api: AppleAdsClient,
  query: Omit<ReportQuery, "campaignId">,
): Promise<ReportRow[]> {
  return readReport(api, CAMPAIGN_REPORT_PATH, query, "campaign report");
}

/**
 * Every page of one campaign's ad-group report: one row per ad group, no
 * country breakdown (v1). A row of another campaign is refused.
 */
export async function readAdGroupReport(
  api: AppleAdsClient,
  query: { adAccountId: string; range: DayRange; campaignId: string },
): Promise<ReportRow[]> {
  const rows = await readReport(
    api,
    AD_GROUP_REPORT_PATH,
    { ...query, byCountry: false },
    "ad-group report",
  );
  // TO BE CONFIRMED by #370: every ad-group row names its campaignId.
  refuseOtherCampaigns(rows, query.campaignId, "ad-group report", "ad group");
  return rows;
}

/**
 * One campaign's keyword report (#396): the KEYWORD_REPORT_ROWS keywords
 * with the most spend in the range, one row each, no country breakdown. A
 * row of another campaign is refused.
 */
export async function readKeywordReport(
  api: AppleAdsClient,
  query: { adAccountId: string; range: DayRange; campaignId: string },
): Promise<ReportRow[]> {
  const rows = await readReport(
    api,
    KEYWORD_REPORT_PATH,
    { ...query, byCountry: false, bySpend: KEYWORD_REPORT_ROWS },
    "keyword report",
    1,
  );
  // TO BE CONFIRMED by #370: every keyword row names its campaignId.
  refuseOtherCampaigns(rows, query.campaignId, "keyword report", "keyword");
  return rows;
}

/**
 * The days of a row: each `granularMetrics` entry, or for a one-day
 * request `totalMetrics` with that day as its date.
 */
export function rowDays(
  row: ReportRow,
  range: DayRange,
): Record<string, unknown>[] {
  if (row.granularMetrics && row.granularMetrics.length > 0) {
    return row.granularMetrics;
  }
  if (daySpan(range) === 1 && row.totalMetrics) {
    return [{ date: range.start, ...row.totalMetrics }];
  }
  return [];
}

/**
 * The country or region of a grouped row. Apple's AppsReportingCampaign
 * has `countryOrRegion` in the row's `metadata`; the campaigns report's
 * example shows it in each `granularMetrics` entry instead. Both are read,
 * the day's first. TO BE CONFIRMED by #370's captures.
 */
export function countryOf(
  row: ReportRow,
  day: Record<string, unknown>,
): string | undefined {
  const value = day.countryOrRegion ?? row.metadata.countryOrRegion;
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
