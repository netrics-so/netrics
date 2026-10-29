import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ManifestTranslation,
  Resource,
  SyncResult,
} from "@netrics/connector-sdk";

import {
  adAccountIdOf,
  appName,
  checkAccess,
  discoverAdAccounts,
  getAdAccount,
  listCampaigns,
  MAX_APPS,
} from "./access.js";
import { APPLE_ADS_HOST, createAppleAdsClient } from "./api.js";
import { APPLE_ADS_METRIC_KEYS, APPLE_ADS_METRICS } from "./metrics.js";
import { noteOnce } from "./observations.js";
import { APPLE_ADS_BACKFILL_DAYS, syncCampaignPage } from "./sync.js";

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
  addDayValues,
  AppleAdsReportError,
  appleAdsDimensions,
  DAY_VALUE_FIELDS,
  parseDayMetrics,
  valueObservations,
  zeroDayValues,
  type DayValues,
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
  AD_ACCOUNT_FORMAT_MESSAGE,
  adAccountIdOf,
  API_ROLES,
  APP_STORE_FEATURE,
  APPLE_MAPS_FEATURE,
  APPLE_MAPS_MESSAGE,
  appName,
  CAMPAIGNS_PAGE_SIZE,
  checkAccess,
  discoverAdAccounts,
  getAdAccount,
  isRateLimited,
  listAcls,
  listCampaigns,
  lostAccessMessage,
  NO_AD_ACCOUNTS_MESSAGE,
  NO_APP_STORE_ACCOUNT_MESSAGE,
  RATE_LIMITED_MESSAGE,
  RATE_LIMITED_MESSAGE as APPLE_ADS_RATE_LIMITED_MESSAGE,
  ROLE_MESSAGE,
  type AccessResult,
  type AclEntry,
  type AdAccountDetails,
  type AppleAdsCampaign,
  type DiscoveredAdAccount,
} from "./access.js";
export {
  APPLE_ADS_API,
  APPLE_ADS_HOST,
  AppleAdsApiError,
  AppleAdsRateBudgetError,
  appleAdsErrorBody,
  createAppleAdsClient,
  MAX_RETRY_AFTER_SECONDS,
  MIN_REMAINING_REQUESTS,
  parseRateLimit,
  retryAfterSeconds,
  type AppleAdsClient,
  type AppleAdsClientOptions,
  type AppleAdsFetch,
  type RateLimit,
} from "./api.js";
export {
  CAMPAIGN_REPORT_PATH,
  COUNTRY_GROUP_BY,
  MAX_REPORT_DAYS,
  MAX_REPORT_PAGES,
  readCampaignReport,
  REPORT_PAGE_SIZE,
  reportRequestBody,
  type DayRange,
  type ReportQuery,
} from "./reports.js";
export {
  adAccountToday,
  addDays,
  APPLE_ADS_BACKFILL_DAYS,
  chunkRange,
  decodeCursor,
  encodeCursor,
  LOOKBACK_DAYS,
  syncCampaignPage,
  type CampaignSyncOptions,
  type SyncPosition,
} from "./sync.js";
export {
  DecimalAmountError,
  parseDecimalAmount,
  type MinorUnitAmount,
} from "../decimal-amount.js";

/**
 * The label of an Apple Ads connection's days (ADR 0020 section 8): its
 * reporting days are the ad account's days, as in the Apple Ads UI, not the
 * workspace's. English and German (ADR 0016).
 */
export function appleAdsDaysLabel(
  timeZone: string,
  locale: string = "en",
): string {
  const zone = timeZone.trim() || "UTC";
  return locale === "de"
    ? `Tage in ${zone}, wie in Apple Ads`
    : `Days in ${zone}, as in Apple Ads`;
}

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
    currency: {
      title: "Währung",
      description:
        "Die Währung des Werbekontos, wie Apple Ads sie meldet. Ausgaben werden nicht umgerechnet.",
    },
    timeZone: {
      title: "Zeitzone",
      description:
        "Die Zeitzone des Werbekontos. Die Tage folgen ihr, wie in Apple Ads.",
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
 * their English and German texts. The "apple-ads" signed-key provider with
 * its token exchange is host code (#369, #373).
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
      currency: {
        type: "string",
        title: "Currency",
        description:
          "The ad account's currency, as Apple Ads reports it. Spend is not converted.",
      },
      timeZone: {
        type: "string",
        title: "Time zone",
        description:
          "The ad account's time zone. Days follow it, as in Apple Ads.",
      },
    },
    // Not required: the wizard's preview runs before an ad account is
    // chosen and lists the API user's ad accounts (ADR 0020 section 5).
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

/** Kinds of the resources discover lists. */
export const RESOURCE_KINDS = {
  /** An ad account of the API user (before one is chosen). */
  adAccount: "ad_account",
  /** A promoted app: the `resource` dimension, as App Store Connect's apps. */
  app: "app",
  /** A campaign: the `campaign` dimension, named for dashboards. */
  campaign: "campaign",
} as const;

export const CHOOSE_AD_ACCOUNT_MESSAGE =
  "Choose the Apple Ads ad account of this connection to finish setup.";

export interface AppleAdsConnectorOptions {
  /** Waits between retries; replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** The clock of the sync windows; replaced in tests. */
  now?: () => number;
  /** Where notes (rounded amounts) go; default: nowhere. */
  log?: (message: string) => void;
}

function configText(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function accessTokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.accessToken;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

/**
 * Apple Ads (ADR 0020). The host exchanges the connection's signed client
 * secret for an access token at appleid.apple.com, caches it, and hands
 * the connector `credentials: { accessToken }`; connector code never sees
 * the key and only reaches api.ads.apple.com.
 *
 * One connection reads one ad account (config `adAccountId`, with its
 * `currency` and `timeZone` as labels). Every call after discovery carries
 * that account as `X-AP-Context`, and the check before every sync confirms
 * the API user still has it in `/v1/acls`.
 *
 * Discovery has two modes. Without an ad account (the wizard's preview)
 * it lists the API user's ad accounts, App Store accounts selectable and
 * Apple Maps accounts shown but not. With one, it lists that account's
 * promoted apps (the `resource` dimension) and its campaigns (the
 * `campaign` dimension), so dashboards can name them.
 *
 * A sync reads the campaign report (#374, see sync.ts): daily campaign ×
 * country or region rows in the ad account's currency and days.
 */
export function createAppleAdsConnector(
  options: AppleAdsConnectorOptions = {},
): Connector {
  function client(
    context: ConnectionContext,
    runtime: {
      fetch: Parameters<typeof createAppleAdsClient>[0];
      signal: AbortSignal;
    },
  ) {
    const token = accessTokenOf(context);
    if (!token) {
      throw new Error("Apple Ads connection has no access token");
    }
    return createAppleAdsClient(runtime.fetch, token, {
      signal: runtime.signal,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  }

  return {
    manifest: appleAdsManifest,

    async check(context, runtime): Promise<CheckResult> {
      if (!accessTokenOf(context)) {
        return {
          ok: false,
          message:
            "This connection has no Apple Ads key. Set up an Apple Ads API key.",
        };
      }
      return checkAccess(client(context, runtime), context.config);
    },

    async discover(context, runtime): Promise<Resource[]> {
      const api = client(context, runtime);
      const adAccountId = adAccountIdOf(context.config);
      if (adAccountId === undefined) {
        const accounts = await discoverAdAccounts(api);
        return accounts.map(({ acl, details, selectable, reason }) => ({
          id: acl.adAccountId,
          name: details.name ?? acl.name,
          kind: RESOURCE_KINDS.adAccount,
          metadata: {
            selectable,
            ...(reason ? { reason } : {}),
            ...(acl.orgId ? { orgId: acl.orgId } : {}),
            roles: acl.roles,
            ...(details.currency ? { currency: details.currency } : {}),
            ...(details.timeZone ? { timeZone: details.timeZone } : {}),
            ...(details.systemStatus
              ? { systemStatus: details.systemStatus }
              : {}),
            ...(details.systemStatusReasons.length > 0
              ? { systemStatusReasons: details.systemStatusReasons }
              : {}),
            productFeatures: details.productFeatures,
          },
        }));
      }
      const campaigns = await listCampaigns(api, adAccountId);
      const appIds = [
        ...new Set(campaigns.flatMap((c) => (c.appId ? [c.appId] : []))),
      ]
        .sort()
        .slice(0, MAX_APPS);
      const apps: Resource[] = [];
      for (const appId of appIds) {
        const name = await appName(api, adAccountId, appId);
        if (name) {
          apps.push({ id: appId, name, kind: RESOURCE_KINDS.app });
        }
      }
      return [
        ...apps,
        ...campaigns.map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          kind: RESOURCE_KINDS.campaign,
          metadata: {
            adAccountId,
            ...(campaign.appId ? { appId: campaign.appId } : {}),
            ...(campaign.status ? { status: campaign.status } : {}),
            ...(campaign.displayStatus
              ? { displayStatus: campaign.displayStatus }
              : {}),
          },
        })),
      ];
    },

    async sync(context, request, runtime): Promise<SyncResult> {
      const adAccountId = adAccountIdOf(context.config);
      if (adAccountId === undefined) {
        throw new Error(CHOOSE_AD_ACCOUNT_MESSAGE);
      }
      // The check before this page has confirmed the key, the role and the
      // ad account. Currency and time zone come from the connection; a
      // connection made before they were stored asks Apple.
      const api = client(context, runtime);
      let currency = configText(context.config, "currency");
      let timeZone = configText(context.config, "timeZone");
      if (currency === undefined || timeZone === undefined) {
        const details = await getAdAccount(api, adAccountId);
        currency ??= details.currency;
        timeZone ??= details.timeZone;
      }
      if (currency === undefined || timeZone === undefined) {
        throw new Error(
          "Apple Ads did not name the ad account's currency and time zone",
        );
      }
      return syncCampaignPage(api, request, {
        now: (options.now ?? Date.now)(),
        adAccountId,
        currency,
        timeZone,
        note: noteOnce(options.log ?? (() => undefined)),
      });
    },
  };
}
