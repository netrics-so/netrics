import type {
  ConnectorManifest,
  ManifestTranslation,
} from "@netrics/connector-sdk";

import { APPLE_ADS_METRIC_KEYS, APPLE_ADS_METRICS } from "./metrics.js";

export {
  APPLE_ADS_DIMENSIONS,
  APPLE_ADS_METRIC_KEYS,
  APPLE_ADS_METRICS,
  ATTRIBUTIONS,
  OTHERS,
  TOP_COUNTRIES,
  type Attribution,
} from "./metrics.js";
export {
  AMOUNT_ROUNDED_NOTE,
  AppleAdsReportError,
  appleAdsDimensions,
  appsDayMetricsSchema,
  countryValue,
  dayObservations,
  noteOnce,
  reportDayTimestamp,
  type AppleAdsRowIdentity,
  type AppleId,
  type AppsDayMetrics,
  type DayObservationsOptions,
} from "./observations.js";
export {
  DecimalAmountError,
  parseDecimalAmount,
  type MinorUnitAmount,
} from "../decimal-amount.js";

/** The Apple Ads Platform API host (ADR 0020 section 9). */
export const APPLE_ADS_HOST = "api.ads.apple.com";
/** Days a backfill reads: 12 months, capped by Apple's retention (#370). */
export const APPLE_ADS_BACKFILL_DAYS = 365;

/**
 * German texts of the manifest (ADR 0016): "du" where the text addresses
 * the reader; product names and stored values stay as they are.
 */
const appleAdsDe: ManifestTranslation = {
  name: "Apple Ads",
  description:
    "Ausgaben, Impressionen, Taps und Installationen deiner App-Store-Kampagnen aus Apple Ads, pro Kampagne, Anzeigengruppe und Land oder Region, in der Währung und Zeitzone des Werbekontos.",
  resourceNoun: { singular: "App", plural: "Apps" },
  config: {
    adAccountId: {
      title: "Werbekonto",
      description: "Die ID des Apple-Ads-Werbekontos dieser Verbindung.",
    },
  },
  metrics: {
    [APPLE_ADS_METRIC_KEYS.spend]: {
      name: "Werbeausgaben",
      description:
        "Was Apple Ads pro Tag, Kampagne, Anzeigengruppe und Land oder Region berechnet hat, in der Währung des Werbekontos, ohne Umrechnung. Die Tage folgen der Zeitzone des Werbekontos, wie in Apple Ads.",
    },
    [APPLE_ADS_METRIC_KEYS.impressions]: {
      name: "Anzeigenimpressionen",
      description:
        "Wie oft deine Anzeigen gezeigt wurden, pro Tag, Kampagne, Anzeigengruppe und Land oder Region.",
    },
    [APPLE_ADS_METRIC_KEYS.taps]: {
      name: "Anzeigentaps",
      description:
        "Taps auf deine Anzeigen pro Tag, Kampagne, Anzeigengruppe und Land oder Region.",
    },
    [APPLE_ADS_METRIC_KEYS.installs]: {
      name: "Installationen über Anzeigen",
      description:
        "Installationen (Erstdownloads und erneute Downloads), die deinen Anzeigen zugeordnet sind, pro Tag, Kampagne, Anzeigengruppe und Land oder Region: nach einem Tap oder nachdem eine Anzeige gesehen wurde (View-Through). Die Summe umfasst beides.",
    },
    [APPLE_ADS_METRIC_KEYS.newDownloads]: {
      name: "Erstdownloads über Anzeigen",
      description:
        "Erstdownloads, die deinen Anzeigen zugeordnet sind, pro Tag, Kampagne, Anzeigengruppe und Land oder Region, nach einem Tap oder einer Ansicht.",
    },
    [APPLE_ADS_METRIC_KEYS.redownloads]: {
      name: "Erneute Downloads über Anzeigen",
      description:
        "Downloads durch Personen, die die App schon einmal hatten, deinen Anzeigen zugeordnet, pro Tag, Kampagne, Anzeigengruppe und Land oder Region, nach einem Tap oder einer Ansicht.",
    },
  },
  dimensions: {
    resource: "App",
    campaign: "Kampagne",
    ad_group: "Anzeigengruppe",
    country: "Land oder Region",
    attribution: "Zuordnung",
    currency: "Währung",
  },
};

/**
 * The Apple Ads manifest (ADR 0020): metrics, units and dimensions, and
 * their English and German texts. The connector itself (check, ad-account
 * discovery, sync) is #373 and #374; the "apple-ads" signed-key provider
 * with its token exchange is host code (#369).
 */
export const appleAdsManifest: ConnectorManifest = {
  id: "apple-ads",
  version: "0.1.0",
  sdkVersion: "^0.2.7",
  category: "ads",
  brandColor: "#0d84ff",
  name: "Apple Ads",
  description:
    "Spend, impressions, taps and installs of your App Store campaigns from Apple Ads, per campaign, ad group and country or region, in the ad account's currency and time zone.",
  url: "https://ads.apple.com/",
  authStrategies: [{ strategy: "signed-key", provider: "apple-ads" }],
  configSchema: {
    type: "object",
    properties: {
      adAccountId: {
        type: "string",
        title: "Ad account",
        description: "The ID of the Apple Ads ad account of this connection.",
      },
    },
    required: ["adAccountId"],
    additionalProperties: false,
  },
  metrics: APPLE_ADS_METRICS,
  // Apple publishes daily numbers in the ad account's day; attribution
  // settles over a few days (ADR 0020 section 8).
  minRefreshIntervalSeconds: 6 * 60 * 60,
  supportsBackfill: true,
  backfillDays: APPLE_ADS_BACKFILL_DAYS,
  // The token exchange at appleid.apple.com is the host's, not the
  // connector's (ADR 0020 section 9).
  outboundDomains: [APPLE_ADS_HOST],
  resourceNoun: { singular: "app", plural: "apps" },
  translations: { de: appleAdsDe },
};
