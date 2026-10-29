import {
  CURRENCY_DIMENSION,
  CURRENCY_MINOR_UNIT,
  type MetricDefinition,
} from "@netrics/connector-sdk";

// Apple Ads metric definitions (ADR 0020 section 6, #372). Every metric is
// a `delta` at `day`, summed. Ratios (TTR, CPT, CPM, CPI, install rates) are
// not stored: daily ratios do not add up, so the compare widget (ADR 0019)
// and derived metrics (milestone 11) form them from these sums. Pre-order
// counts are not in v1.

const PREFIX = "apple_ads";

/**
 * Metric keys. ADR 0020 names them `ads_spend`, `ads_impressions`, …; the
 * keys carry the connector's prefix like every other connector's
 * (`app_store_connect.downloads`).
 */
export const APPLE_ADS_METRIC_KEYS = {
  spend: `${PREFIX}.spend`,
  impressions: `${PREFIX}.impressions`,
  taps: `${PREFIX}.taps`,
  installs: `${PREFIX}.installs`,
  newDownloads: `${PREFIX}.new_downloads`,
  redownloads: `${PREFIX}.redownloads`,
} as const;

/** Dimension names of the Apple Ads metrics. */
export const APPLE_ADS_DIMENSIONS = {
  /** The promoted app's Apple ID (Adam ID), as App Store Connect's `resource`. */
  resource: "resource",
  /** The campaign's Apple ID; its name is a label, not identity. */
  campaign: "campaign",
  /** The ad group's Apple ID; its name is a label, not identity. */
  adGroup: "ad_group",
  /** `countryOrRegion`, ISO 3166-1 alpha-2, or OTHERS. */
  country: "country",
  /** How an install was attributed: ATTRIBUTIONS. */
  attribution: "attribution",
  currency: CURRENCY_DIMENSION,
} as const;

/**
 * Attribution of installs, new downloads and redownloads: after a tap on
 * the ad, or after an ad was seen (view-through). The headline number is
 * their sum, as the Apple Ads UI shows by default; a filter on
 * `attribution` shows one of them.
 */
export const ATTRIBUTIONS = ["tap", "view"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

/** Countries per campaign and month kept by name; the rest are OTHERS. */
export const TOP_COUNTRIES = 10;
/** The `country` value of the countries outside the top TOP_COUNTRIES. */
export const OTHERS = "Others";

const SUMMED = ["sum", "avg", "min", "max"] as const;

const { resource, campaign, adGroup, country, attribution, currency } =
  APPLE_ADS_DIMENSIONS;
const BASE_DIMENSIONS = [resource, campaign, adGroup, country];

export const APPLE_ADS_METRICS: MetricDefinition[] = [
  {
    key: APPLE_ADS_METRIC_KEYS.spend,
    name: "Ad spend",
    description:
      "What Apple Ads charged per day, campaign, ad group and country or region, in the ad account's currency, without conversion. Days follow the ad account's time zone, as in Apple Ads.",
    kind: "delta",
    unit: CURRENCY_MINOR_UNIT,
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS, currency],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_METRIC_KEYS.impressions,
    name: "Ad impressions",
    description:
      "How often your ads were shown per day, campaign, ad group and country or region.",
    kind: "delta",
    unit: "impressions",
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_METRIC_KEYS.taps,
    name: "Ad taps",
    description:
      "Taps on your ads per day, campaign, ad group and country or region.",
    kind: "delta",
    unit: "taps",
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_METRIC_KEYS.installs,
    name: "Ad installs",
    description:
      "Installs (new downloads and redownloads) attributed to your ads per day, campaign, ad group and country or region: after a tap or after an ad was seen (view-through). The total is both.",
    kind: "delta",
    unit: "installs",
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS, attribution],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_METRIC_KEYS.newDownloads,
    name: "Ad new downloads",
    description:
      "First-time downloads attributed to your ads per day, campaign, ad group and country or region, after a tap or a view.",
    kind: "delta",
    unit: "downloads",
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS, attribution],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_METRIC_KEYS.redownloads,
    name: "Ad redownloads",
    description:
      "Downloads by people who had the app before, attributed to your ads per day, campaign, ad group and country or region, after a tap or a view.",
    kind: "delta",
    unit: "downloads",
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS, attribution],
    aggregations: [...SUMMED],
  },
];
