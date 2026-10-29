import type { Observation } from "@netrics/connector-sdk";
import { z } from "zod";

import { isCurrencyCode } from "../currency.js";
import { DecimalAmountError, parseDecimalAmount } from "../decimal-amount.js";
import {
  APPLE_ADS_DIMENSIONS,
  APPLE_ADS_METRIC_KEYS,
  OTHERS,
  type Attribution,
} from "./metrics.js";

// Identity of Apple Ads observations (ADR 0008, ADR 0020 sections 6 to 8)
// and the conversion of one day of Apple's `AppsMetrics` into them. Pure:
// the report requests, paging and lookback are #374 and #376.
//
// Identity is (connection, metric, dimensions, day). The connection is one
// ad account (ADR 0020 section 5), so the account is not a dimension. The
// dimensions are Apple's stable IDs: the promoted app, the campaign, and
// the ad group or the country or region. Names are labels and never part
// of the identity, so a renamed campaign keeps its history.

/** Note code: an amount had more decimals than its currency and was rounded. */
export const AMOUNT_ROUNDED_NOTE = "apple_ads.amount_rounded";

export class AppleAdsReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppleAdsReportError";
  }
}

/**
 * An Apple ID (int64 in Apple's schema) as a dimension value: digits only.
 * A JSON number above 2^53 has already lost digits, so it is refused.
 */
const appleIdSchema = z.union([
  z.string().regex(/^\d{1,19}$/),
  z
    .number()
    .int()
    .nonnegative()
    .refine((value) => Number.isSafeInteger(value)),
]);
export type AppleId = z.infer<typeof appleIdSchema>;

/** What one report row belongs to. */
export interface AppleAdsRowIdentity {
  /**
   * The promoted app's Apple ID: `promotedObjectId` of the campaign
   * metadata (AppsReportingCampaign, "the Adam ID of the promoted App
   * Store app"). TO BE CONFIRMED by the owner's captures (#370): ADR 0020
   * lists the field that names the promoted app as an open check. It is
   * the `resource` dimension, as App Store Connect's app ID is, so ad
   * installs and App Store downloads of one app sit on one dashboard.
   */
  app: AppleId;
  /** The campaign's `id`. */
  campaign: AppleId;
  /** The ad group's `id`, for ad-group report rows (#376). */
  adGroup?: AppleId;
  /**
   * `countryOrRegion` of a `groupBy: ["countryOrRegion"]` row (ISO 3166-1
   * alpha-2), or OTHERS for the countries outside a campaign's top
   * TOP_COUNTRIES of the month.
   */
  country?: string;
}

function appleId(value: AppleId, what: string): string {
  const parsed = appleIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppleAdsReportError(`Apple Ads report has a malformed ${what}`);
  }
  // Leading zeros would make "042" and "42" two series of one campaign.
  return BigInt(parsed.data).toString();
}

/**
 * The dimensions of a row's observations. A row is at one level: a
 * campaign, a campaign in one country or region, or an ad group (no
 * country breakdown at ad-group level in v1, #376), so `adGroup` and
 * `country` are never both set.
 *
 * Grain warning for #374 and #376: queries add up every series whose
 * dimensions contain the filter. Observations of one metric at two levels
 * (campaign rows beside the same campaign's country or ad-group rows)
 * would count the same spend twice in an unfiltered total, so a sync
 * stores each metric at one level per connection.
 */
export function appleAdsDimensions(
  identity: AppleAdsRowIdentity,
): Record<string, string> {
  const dimensions: Record<string, string> = {
    [APPLE_ADS_DIMENSIONS.resource]: appleId(identity.app, "app ID"),
    [APPLE_ADS_DIMENSIONS.campaign]: appleId(identity.campaign, "campaign ID"),
  };
  if (identity.adGroup !== undefined && identity.country !== undefined) {
    throw new AppleAdsReportError(
      "Apple Ads rows are by ad group or by country or region, not both",
    );
  }
  if (identity.adGroup !== undefined) {
    dimensions[APPLE_ADS_DIMENSIONS.adGroup] = appleId(
      identity.adGroup,
      "ad group ID",
    );
  }
  if (identity.country !== undefined) {
    dimensions[APPLE_ADS_DIMENSIONS.country] = countryValue(identity.country);
  }
  return dimensions;
}

/** `countryOrRegion` as stored: "us" → "US"; OTHERS stays as it is. */
export function countryValue(country: string): string {
  if (country === OTHERS) return OTHERS;
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    throw new AppleAdsReportError(
      "Apple Ads report has a malformed country or region",
    );
  }
  return code;
}

/**
 * Apple's reporting day D (`date`, "YYYY-MM-DD" in the ad account's time
 * zone with `timeZone: ORTZ`) stamped D T00:00:00Z, as ADR 0008 stamps
 * every provider's daily value. The zone itself is a connection label.
 */
export function reportDayTimestamp(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const stamp = `${date}T00:00:00.000Z`;
  // Round-tripping refuses days that do not exist (2026-02-30).
  if (!match || new Date(stamp).toISOString() !== stamp) {
    throw new AppleAdsReportError("Apple Ads report has a malformed date");
  }
  return stamp;
}

const count = z.number().int().nonnegative();

/**
 * The fields of Apple's `AppsMetrics` (one entry of `granularMetrics`) that
 * netrics stores. Field names and types are from Apple's documentation
 * (https://developer.apple.com/documentation/Apple-Ads-Platform-API/AppsMetrics);
 * TO BE CONFIRMED against the owner's captures (#370). Ratios, average
 * costs and pre-orders are ignored.
 */
export const appsDayMetricsSchema = z
  .object({
    date: z.string(),
    localSpend: z.object({ amount: z.string(), currency: z.string() }).loose(),
    impressions: count,
    taps: count,
    tapInstalls: count,
    viewInstalls: count,
    totalInstalls: count,
    tapNewDownloads: count,
    viewNewDownloads: count,
    totalNewDownloads: count,
    tapRedownloads: count,
    viewRedownloads: count,
    totalRedownloads: count,
  })
  .loose();
export type AppsDayMetrics = z.infer<typeof appsDayMetricsSchema>;

export interface DayObservationsOptions {
  /** The ad account's currency (`AdAccount.currency`). */
  accountCurrency: string;
  /** Records a note; NoteOnce keeps one per code. */
  note: (code: string, message: string) => void;
}

const ATTRIBUTED = [
  ["installs", "Installs"],
  ["newDownloads", "NewDownloads"],
  ["redownloads", "Redownloads"],
] as const;

/**
 * One day of one row as observations: spend in minor units with its
 * currency, impressions, taps, and installs, new downloads and redownloads
 * once per attribution (`tap`, `view`). The totals are not stored; they
 * are the sum over `attribution`, and a row whose total is not that sum
 * is refused.
 */
export function dayObservations(
  identity: AppleAdsRowIdentity,
  raw: unknown,
  options: DayObservationsOptions,
): Observation[] {
  const parsed = appsDayMetricsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppleAdsReportError("Apple Ads report has malformed metrics");
  }
  const metrics = parsed.data;
  const sourceTimestamp = reportDayTimestamp(metrics.date);
  const dimensions = appleAdsDimensions(identity);

  const currency = metrics.localSpend.currency;
  if (!isCurrencyCode(currency) || currency !== options.accountCurrency) {
    throw new AppleAdsReportError(
      "Apple Ads spend is not in the ad account's currency",
    );
  }
  let spend: number;
  try {
    const amount = parseDecimalAmount(metrics.localSpend.amount, currency);
    spend = amount.minor;
    if (amount.rounded) {
      options.note(
        AMOUNT_ROUNDED_NOTE,
        `Apple Ads sent ${currency} amounts with more decimals than the currency has; they were rounded half to even.`,
      );
    }
  } catch (error) {
    if (error instanceof DecimalAmountError) {
      throw new AppleAdsReportError(
        `Apple Ads report has a malformed spend amount (${error.message})`,
      );
    }
    throw error;
  }

  const observations: Observation[] = [];
  const push = (
    metricKey: string,
    value: number,
    extra: Record<string, string> = {},
  ) =>
    observations.push({
      metricKey,
      sourceTimestamp,
      value,
      dimensions: { ...dimensions, ...extra },
    });

  push(APPLE_ADS_METRIC_KEYS.spend, spend, {
    [APPLE_ADS_DIMENSIONS.currency]: currency,
  });
  push(APPLE_ADS_METRIC_KEYS.impressions, metrics.impressions);
  push(APPLE_ADS_METRIC_KEYS.taps, metrics.taps);
  for (const [key, field] of ATTRIBUTED) {
    const byAttribution: Record<Attribution, number> = {
      tap: metrics[`tap${field}`],
      view: metrics[`view${field}`],
    };
    // TO BE CONFIRMED (#370): Apple documents the total as tap plus view.
    if (byAttribution.tap + byAttribution.view !== metrics[`total${field}`]) {
      throw new AppleAdsReportError(
        `Apple Ads total ${field} is not tap plus view`,
      );
    }
    for (const attribution of ["tap", "view"] as const) {
      push(APPLE_ADS_METRIC_KEYS[key], byAttribution[attribution], {
        [APPLE_ADS_DIMENSIONS.attribution]: attribution,
      });
    }
  }
  return observations;
}

/**
 * A note callback that passes each code on once, for one sync: a report
 * with a thousand rounded amounts logs one line.
 */
export function noteOnce(
  log: (message: string) => void,
): (code: string, message: string) => void {
  const seen = new Set<string>();
  return (code, message) => {
    if (seen.has(code)) return;
    seen.add(code);
    log(`${code}: ${message}`);
  };
}
