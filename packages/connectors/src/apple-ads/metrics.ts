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

/**
 * The same quantities per ad group (#376), in keys of their own, as App
 * Store Connect's `downloads_by_territory` beside `downloads`: the main
 * keys hold campaign × country or region rows, these hold campaign × ad
 * group rows, so an unfiltered sum of either is the ad account's total and
 * spend is never counted twice. No country breakdown at ad-group level in
 * v1.
 */
export const APPLE_ADS_AD_GROUP_METRIC_KEYS = {
  spend: `${PREFIX}.spend_by_ad_group`,
  impressions: `${PREFIX}.impressions_by_ad_group`,
  taps: `${PREFIX}.taps_by_ad_group`,
  installs: `${PREFIX}.installs_by_ad_group`,
  newDownloads: `${PREFIX}.new_downloads_by_ad_group`,
  redownloads: `${PREFIX}.redownloads_by_ad_group`,
} as const satisfies Record<keyof typeof APPLE_ADS_METRIC_KEYS, string>;

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
const BASE_DIMENSIONS = [resource, campaign, country];
const AD_GROUP_DIMENSIONS = [resource, campaign, adGroup];

export const APPLE_ADS_METRICS: MetricDefinition[] = [
  {
    key: APPLE_ADS_METRIC_KEYS.spend,
    name: "Ad spend",
    description:
      "What Apple Ads charged per day, campaign and country or region, in the ad account's currency, without conversion. Days follow the ad account's time zone, as in Apple Ads.",
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
      "How often your ads were shown per day, campaign and country or region.",
    kind: "delta",
    unit: "impressions",
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_METRIC_KEYS.taps,
    name: "Ad taps",
    description: "Taps on your ads per day, campaign and country or region.",
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
      "Installs (new downloads and redownloads) attributed to your ads per day, campaign and country or region: after a tap or after an ad was seen (view-through). The total is both.",
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
      "First-time downloads attributed to your ads per day, campaign and country or region, after a tap or a view.",
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
      "Downloads by people who had the app before, attributed to your ads per day, campaign and country or region, after a tap or a view.",
    kind: "delta",
    unit: "downloads",
    granularity: "day",
    dimensions: [...BASE_DIMENSIONS, attribution],
    aggregations: [...SUMMED],
  },
];

/**
 * The `ad_group` value of what a campaign's ad groups leave out of its
 * total (a campaign Apple no longer answers for), so the ad-group sum
 * stays the campaign's total.
 */
const AD_GROUP_NOTE = `What no ad group accounts for in a campaign's total is "${OTHERS}".`;

export const APPLE_ADS_AD_GROUP_METRICS: MetricDefinition[] = [
  {
    key: APPLE_ADS_AD_GROUP_METRIC_KEYS.spend,
    name: "Ad spend by ad group",
    description: `What Apple Ads charged per day, campaign and ad group, in the ad account's currency, without conversion. Days follow the ad account's time zone, as in Apple Ads. ${AD_GROUP_NOTE}`,
    kind: "delta",
    unit: CURRENCY_MINOR_UNIT,
    granularity: "day",
    dimensions: [...AD_GROUP_DIMENSIONS, currency],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_AD_GROUP_METRIC_KEYS.impressions,
    name: "Ad impressions by ad group",
    description: `How often your ads were shown per day, campaign and ad group. ${AD_GROUP_NOTE}`,
    kind: "delta",
    unit: "impressions",
    granularity: "day",
    dimensions: [...AD_GROUP_DIMENSIONS],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_AD_GROUP_METRIC_KEYS.taps,
    name: "Ad taps by ad group",
    description: `Taps on your ads per day, campaign and ad group. ${AD_GROUP_NOTE}`,
    kind: "delta",
    unit: "taps",
    granularity: "day",
    dimensions: [...AD_GROUP_DIMENSIONS],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_AD_GROUP_METRIC_KEYS.installs,
    name: "Ad installs by ad group",
    description: `Installs (new downloads and redownloads) attributed to your ads per day, campaign and ad group: after a tap or after an ad was seen (view-through). The total is both. ${AD_GROUP_NOTE}`,
    kind: "delta",
    unit: "installs",
    granularity: "day",
    dimensions: [...AD_GROUP_DIMENSIONS, attribution],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_AD_GROUP_METRIC_KEYS.newDownloads,
    name: "Ad new downloads by ad group",
    description: `First-time downloads attributed to your ads per day, campaign and ad group, after a tap or a view. ${AD_GROUP_NOTE}`,
    kind: "delta",
    unit: "downloads",
    granularity: "day",
    dimensions: [...AD_GROUP_DIMENSIONS, attribution],
    aggregations: [...SUMMED],
  },
  {
    key: APPLE_ADS_AD_GROUP_METRIC_KEYS.redownloads,
    name: "Ad redownloads by ad group",
    description: `Downloads by people who had the app before, attributed to your ads per day, campaign and ad group, after a tap or a view. ${AD_GROUP_NOTE}`,
    kind: "delta",
    unit: "downloads",
    granularity: "day",
    dimensions: [...AD_GROUP_DIMENSIONS, attribution],
    aggregations: [...SUMMED],
  },
];
