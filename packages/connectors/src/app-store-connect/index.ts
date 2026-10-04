import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  ManifestTranslation,
  Resource,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  CURRENCY_DIMENSION,
  CURRENCY_MINOR_UNIT,
} from "@netrics/connector-sdk";

import {
  APP_STORE_CONNECT_HOST,
  createAppStoreConnectClient,
  type AppStoreConnectClient,
} from "./api.js";
import {
  ANALYTICS_APPS_PER_PAGE,
  ANALYTICS_METRIC_KEYS,
  ANALYTICS_SEGMENT_HOSTS,
  syncAnalyticsApps,
} from "./analytics-sync.js";
import { ANALYTICS_SOURCE_TYPES, OTHER_SOURCE } from "./analytics-report.js";
import { ARTWORK_HOSTS, ITUNES_LOOKUP_HOST, appIcons } from "./icons.js";
import { checkKey, vendorNumberOf } from "./probes.js";
import {
  RATINGS,
  REVIEWS_APPS_PER_PAGE,
  REVIEW_METRIC_KEYS,
  TOP_REVIEW_TERRITORIES,
  syncReviewApps,
} from "./reviews.js";
import {
  BACKFILL_DAYS,
  OTHERS,
  SALES_METRIC_KEYS,
  TOP_TERRITORIES,
  syncSalesPage,
} from "./sales-sync.js";

export {
  APP_STORE_CONNECT_API,
  APP_STORE_CONNECT_HOST,
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  MIN_REMAINING_REQUESTS,
  createAppStoreConnectClient,
  parseRateLimit,
  type AscFetch,
} from "./api.js";
export {
  ANALYTICS_ACCESS_TYPE,
  activeRequest,
  ensureAnalyticsRequest,
  listAnalyticsRequests,
  type AnalyticsReportRequest,
  type AnalyticsRequestOutcome,
} from "./analytics-requests.js";
export {
  ANALYTICS_SOURCE_TYPES,
  AnalyticsReportError,
  DISCOVERY_REPORT_NAME,
  DOWNLOADS_REPORT_NAME,
  OTHER_SOURCE,
  md5Hex,
  parseDiscoveryReport,
  parseDownloadsReport,
  readSegment,
  reportDate,
  sourceLabel,
} from "./analytics-report.js";
export {
  ANALYTICS_APPS_PER_PAGE,
  ANALYTICS_LOOKBACK_DAYS,
  ANALYTICS_METRIC_KEYS,
  ANALYTICS_SEGMENT_HOSTS,
  AnalyticsSegmentHostError,
  downloadSegment,
  readAppAnalytics,
  syncAnalyticsApps,
  type AppAnalyticsResult,
  type AppAnalyticsStatus,
} from "./analytics-sync.js";
export {
  AGREEMENTS_MESSAGE,
  KEY_MISMATCH_MESSAGE,
  ROLE_MESSAGE,
  SALES_REPORT_FILTERS,
  VENDOR_NUMBER_FORMAT_MESSAGE,
  checkKey,
  latestReportDate,
  latestReportDay,
  pacificToday,
  probeApps,
  probeSalesReport,
  vendorNumberMessage,
  vendorNumberOf,
  type ProbeResult,
} from "./probes.js";
export {
  MAX_REVIEW_PAGES,
  RATINGS,
  REVIEWS_ADMIN_MESSAGE,
  REVIEWS_APPS_PER_PAGE,
  REVIEWS_KEY_MISMATCH_MESSAGE,
  REVIEWS_LOOKBACK_DAYS,
  REVIEWS_PAGE_SIZE,
  REVIEWS_PAUSED_MESSAGE,
  REVIEWS_ROLE_MESSAGE,
  REVIEW_FIELDS,
  REVIEW_METRIC_KEYS,
  TOP_REVIEW_TERRITORIES,
  probeCustomerReviews,
  probeReviewsKeyNotAdmin,
  readAppReviews,
  reviewObservations,
  reviewsProbeApp,
  reviewsWindow,
  syncReviewApps,
  type AppReviewsResult,
  type ReviewEntry,
} from "./reviews.js";
export {
  ARTWORK_HOSTS,
  ArtworkHostError,
  ICON_SIZE,
  ITUNES_LOOKUP_HOST,
  ITUNES_LOOKUP_URL,
  LOOKUP_BATCH_SIZE,
  MAX_LOOKUP_REQUESTS,
  appIcons,
  buildIconTemplate,
  checkArtworkUrl,
  fillIconTemplate,
  findArtwork,
  lookupArtwork,
  resizeArtworkUrl,
} from "./icons.js";
export { territoryAlpha2 } from "./territories.js";
export {
  MAX_REPORT_BYTES,
  PRODUCT_TYPES,
  SALES_REPORT_VERSION,
  currencyExponent,
  inflateReport,
  parseSalesReport,
  productCategory,
  rowProceeds,
  toMinorUnits,
  type ProductCategory,
  type SalesRow,
} from "./sales-report.js";
export {
  BACKFILL_DAYS,
  INCREMENTAL_LOOKBACK_DAYS,
  OTHERS,
  REPORT_CONCURRENCY,
  SALES_METRIC_KEYS,
  TOP_TERRITORIES,
  UNKNOWN,
} from "./sales-sync.js";

/** Apps per page of `GET /v1/apps` (Apple allows up to 200). */
export const APPS_PAGE_SIZE = 100;
/** Pages of apps read at most (5,000 apps). */
const MAX_APP_PAGES = 50;

/**
 * German texts of the manifest (ADR 0016, #257): "du" where the text
 * addresses the reader; product names and stored values stay as they are.
 */
const appStoreConnectDe: ManifestTranslation = {
  name: "App Store Connect",
  description:
    "Downloads, In-App-Käufe und Erlöse deiner Apps aus den Verkaufsberichten von App Store Connect, pro App; Impressionen, Produktseitenaufrufe und Downloads nach Quelle, sobald die App-Store-Analysen aktiviert sind; Bewertungen und Rezensionen mit einem optionalen Customer-Support-Schlüssel.",
  resourceNoun: { singular: "App", plural: "Apps" },
  config: {
    vendorNumber: {
      title: "Anbieternummer",
      description:
        "Die Nummer, die App Store Connect unter Zahlungen und Finanzberichte neben dem Namen deiner juristischen Person anzeigt (nur Ziffern, z. B. 85012345).",
    },
  },
  metrics: {
    [SALES_METRIC_KEYS.downloads]: {
      name: "Downloads",
      description:
        "Erstdownloads pro Tag und App (kostenlose, kostenpflichtige, Bundle- und Custom-Apps) aus dem täglichen App-Store-Verkaufsbericht. Berichtstage folgen der pazifischen Zeit; Rückerstattungen zählen negativ.",
    },
    [SALES_METRIC_KEYS.downloadsByTerritory]: {
      name: "Downloads nach Land",
      description: `Erstdownloads pro Tag für die ${TOP_TERRITORIES} größten App-Store-Länder jeder App und jedes Kalendermonats (ISO-Ländercodes); andere Länder werden als „${OTHERS}“ zusammengefasst.`,
    },
    [SALES_METRIC_KEYS.downloadsByDevice]: {
      name: "Downloads nach Gerät",
      description:
        "Erstdownloads pro Tag und Gerät (iPhone, iPad, Desktop, Apple TV, Apple Vision, …).",
    },
    [SALES_METRIC_KEYS.redownloads]: {
      name: "Erneute Downloads",
      description:
        "Downloads einer App durch Personen, die sie schon einmal geladen haben, pro Tag und App.",
    },
    [SALES_METRIC_KEYS.updates]: {
      name: "Updates",
      description: "Installierte App-Updates pro Tag und App.",
    },
    [SALES_METRIC_KEYS.iapUnits]: {
      name: "In-App-Käufe",
      description:
        "In-App-Käufe und Abo-Käufe pro Tag, gezählt für ihre App; wiederhergestellte Käufe zählen nicht, Rückerstattungen zählen negativ.",
    },
    [SALES_METRIC_KEYS.proceeds]: {
      name: "Erlöse",
      description:
        "Was Apple dir auszahlt (Einheiten × Entwicklererlös) pro Tag und App, in jeder Erlöswährung, ohne Umrechnung. Rückerstattungen zählen negativ.",
    },
    [ANALYTICS_METRIC_KEYS.impressions]: {
      name: "App-Store-Impressionen",
      description:
        "Wie oft das Icon der App im App Store gezeigt wurde (Suchergebnisse, Charts, Heute, Apps und Spiele), pro Tag und App. Aus den App-Store-Analysen, die einmal aktiviert werden müssen; ein Tag ist etwa zwei Tage später vollständig.",
    },
    [ANALYTICS_METRIC_KEYS.productPageViews]: {
      name: "Produktseitenaufrufe",
      description:
        "Aufrufe der App-Store-Produktseite der App (auch Produktseiten, die in anderen Apps angezeigt werden), pro Tag und App. Aus den App-Store-Analysen.",
    },
    [ANALYTICS_METRIC_KEYS.storeDownloads]: {
      name: "Downloads nach Quelle",
      description: `Erstdownloads pro Tag, App und Ort, an dem Personen die App gefunden haben: ${ANALYTICS_SOURCE_TYPES.join(", ")} (alles Neue ist „${OTHER_SOURCE}“). Aus den App-Store-Analysen.`,
    },
    [REVIEW_METRIC_KEYS.reviews]: {
      name: "Rezensionen",
      description:
        "Kundenrezensionen pro Tag und App, wie die App Store Connect API sie liefert (Tage in pazifischer Zeit). Braucht den optionalen Customer-Support-Schlüssel. Nicht die Sternebewertung im App Store: Die API liefert keine Gesamtbewertung.",
    },
    [REVIEW_METRIC_KEYS.reviewRatingSum]: {
      name: "Rezensionssterne",
      description:
        "Die Summe der Sternebewertungen (1–5) der Rezensionen pro Tag und App. Geteilt durch Rezensionen ergibt sie die durchschnittliche Bewertung dieser Rezensionen. Braucht den optionalen Customer-Support-Schlüssel.",
    },
    [REVIEW_METRIC_KEYS.reviewsByRating]: {
      name: "Rezensionen nach Bewertung",
      description: `Kundenrezensionen pro Tag, App und Sternebewertung (${RATINGS.join(", ")}). Braucht den optionalen Customer-Support-Schlüssel.`,
    },
    [REVIEW_METRIC_KEYS.reviewsByTerritory]: {
      name: "Rezensionen nach Land",
      description: `Kundenrezensionen pro Tag für die ${TOP_REVIEW_TERRITORIES} Länder mit den meisten Rezensionen jeder App und jedes Kalendermonats (ISO-Ländercodes); andere Länder werden als „${OTHERS}“ zusammengefasst. Braucht den optionalen Customer-Support-Schlüssel.`,
    },
  },
  dimensions: {
    resource: "App",
    territory: "Land",
    device: "Gerät",
    currency: "Währung",
    source: "Quelle",
    rating: "Bewertung",
  },
};

export const appStoreConnectManifest: ConnectorManifest = {
  id: "app-store-connect",
  version: "0.1.2",
  sdkVersion: "^0.2.7",
  category: "apps",
  brandColor: "#0d84ff",
  name: "App Store Connect",
  description:
    "Downloads, in-app purchases and proceeds of your apps from App Store Connect sales reports, per app; impressions, product page views and downloads by source once App Store analytics are enabled; ratings and reviews with an optional Customer Support key.",
  url: "https://appstoreconnect.apple.com/",
  docsUrl:
    "https://github.com/netrics-so/netrics/blob/main/docs/connectors/app-store-connect.md",
  authStrategies: [{ strategy: "signed-key", provider: "app-store-connect" }],
  configSchema: {
    type: "object",
    properties: {
      vendorNumber: {
        type: "string",
        title: "Vendor number",
        description:
          "The number shown in App Store Connect under Payments and Financial Reports, next to your legal entity name (digits only, e.g. 85012345).",
      },
    },
    required: ["vendorNumber"],
    additionalProperties: false,
  },
  metrics: [
    {
      key: SALES_METRIC_KEYS.downloads,
      name: "Downloads",
      description:
        "First-time downloads per day and app (free, paid, bundle and custom apps), from the daily App Store sales report. Reporting days are Pacific Time; refunds count negative.",
      kind: "delta",
      unit: "downloads",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: SALES_METRIC_KEYS.downloadsByTerritory,
      name: "Downloads by territory",
      description: `First-time downloads per day for the ${TOP_TERRITORIES} largest App Store territories of each app and calendar month (ISO country codes); other territories are grouped as "${OTHERS}".`,
      kind: "delta",
      unit: "downloads",
      granularity: "day",
      dimensions: ["resource", "territory"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: SALES_METRIC_KEYS.downloadsByDevice,
      name: "Downloads by device",
      description:
        "First-time downloads per day and device (iPhone, iPad, Desktop, Apple TV, Apple Vision, …).",
      kind: "delta",
      unit: "downloads",
      granularity: "day",
      dimensions: ["resource", "device"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: SALES_METRIC_KEYS.redownloads,
      name: "Redownloads",
      description:
        "Downloads of an app by people who downloaded it before, per day and app.",
      kind: "delta",
      unit: "downloads",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: SALES_METRIC_KEYS.updates,
      name: "Updates",
      description: "App updates installed per day and app.",
      kind: "delta",
      unit: "updates",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: SALES_METRIC_KEYS.iapUnits,
      name: "In-app purchases",
      description:
        "In-app purchases and subscription purchases per day, counted for their app; restored purchases are not counted, refunds count negative.",
      kind: "delta",
      unit: "purchases",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: SALES_METRIC_KEYS.proceeds,
      name: "Proceeds",
      description:
        "What Apple pays you (units × developer proceeds) per day and app, in each currency of proceeds, without conversion. Refunds count negative.",
      kind: "delta",
      unit: CURRENCY_MINOR_UNIT,
      granularity: "day",
      dimensions: ["resource", CURRENCY_DIMENSION],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: ANALYTICS_METRIC_KEYS.impressions,
      name: "App Store impressions",
      description:
        "How often the app's icon was shown on the App Store (search results, charts, Today, Apps and Games), per day and app. From App Store analytics, which have to be enabled once; a day is complete about two days later.",
      kind: "delta",
      unit: "impressions",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: ANALYTICS_METRIC_KEYS.productPageViews,
      name: "Product page views",
      description:
        "Views of the app's App Store product page (including product pages shown inside other apps), per day and app. From App Store analytics.",
      kind: "delta",
      unit: "views",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: ANALYTICS_METRIC_KEYS.storeDownloads,
      name: "Downloads by source",
      description: `First-time downloads per day, app and where people found the app: ${ANALYTICS_SOURCE_TYPES.join(", ")} (anything new is "${OTHER_SOURCE}"). From App Store analytics.`,
      kind: "delta",
      unit: "downloads",
      granularity: "day",
      dimensions: ["resource", "source"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: REVIEW_METRIC_KEYS.reviews,
      name: "Reviews",
      description:
        "Customer reviews per day and app, as the App Store Connect API returns them (Pacific Time days). Needs the optional Customer Support key. Not the App Store's star rating: the API has no aggregate rating.",
      kind: "delta",
      unit: "reviews",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: REVIEW_METRIC_KEYS.reviewRatingSum,
      name: "Review stars",
      description:
        "The sum of the star ratings (1–5) of the reviews per day and app. Divided by Reviews it is the average rating of those reviews. Needs the optional Customer Support key.",
      kind: "delta",
      unit: "stars",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: REVIEW_METRIC_KEYS.reviewsByRating,
      name: "Reviews by rating",
      description: `Customer reviews per day, app and star rating (${RATINGS.join(", ")}). Needs the optional Customer Support key.`,
      kind: "delta",
      unit: "reviews",
      granularity: "day",
      dimensions: ["resource", "rating"],
      aggregations: ["sum", "avg", "min", "max"],
    },
    {
      key: REVIEW_METRIC_KEYS.reviewsByTerritory,
      name: "Reviews by territory",
      description: `Customer reviews per day for the ${TOP_REVIEW_TERRITORIES} territories with the most reviews of each app and calendar month (ISO country codes); other territories are grouped as "${OTHERS}". Needs the optional Customer Support key.`,
      kind: "delta",
      unit: "reviews",
      granularity: "day",
      dimensions: ["resource", "territory"],
      aggregations: ["sum", "avg", "min", "max"],
    },
  ],
  // Daily reports arrive once a day, the next morning Pacific Time.
  minRefreshIntervalSeconds: 6 * 60 * 60,
  // Apple keeps daily sales reports for a year; one request per day, a
  // tenth of the hourly limit (ADR 0014).
  supportsBackfill: true,
  backfillDays: BACKFILL_DAYS,
  // The API, the bucket host of the presigned analytics segment URLs, and
  // for app icons (#226) the public App Store lookup and Apple's image CDN,
  // all exactly (ADR 0014: never *.amazonaws.com; never *.mzstatic.com).
  outboundDomains: [
    APP_STORE_CONNECT_HOST,
    ...ANALYTICS_SEGMENT_HOSTS,
    ITUNES_LOOKUP_HOST,
    ...ARTWORK_HOSTS,
  ],
  resourceNoun: { singular: "app", plural: "apps" },
  translations: { de: appStoreConnectDe },
  // Apple's limit is per key and rolling hour; connections sharing a key
  // share it (ADR 0014).
  rateLimit: { maxRequests: 3500, windowSeconds: 3600, scope: "key" },
};

// ─── Response shapes (a changed shape fails parsing, and the tests) ─────────

const appsPageSchema = z.object({
  data: z.array(
    z
      .object({
        type: z.literal("apps"),
        id: z.string().regex(/^\d+$/),
        attributes: z
          .object({
            name: z.string().min(1),
            bundleId: z.string().optional(),
            sku: z.string().optional(),
          })
          .loose(),
        relationships: z
          .object({
            appStoreVersions: z
              .object({
                data: z
                  .array(z.object({ type: z.string(), id: z.string() }).loose())
                  .optional(),
              })
              .loose()
              .optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
  included: z
    .array(
      z
        .object({
          type: z.string(),
          id: z.string(),
          attributes: z
            .object({ platform: z.string().optional() })
            .loose()
            .optional(),
        })
        .loose(),
    )
    .optional(),
  links: z.object({ next: z.string().optional() }).loose().optional(),
});

/** Apple's platform enum, as a label. */
const PLATFORM_LABELS: Record<string, string> = {
  IOS: "iOS",
  MAC_OS: "macOS",
  TV_OS: "tvOS",
  VISION_OS: "visionOS",
};
const PLATFORM_ORDER = Object.keys(PLATFORM_LABELS);

export interface AppStoreApp {
  /** The numeric Apple ID, also the sales report's Apple Identifier. */
  id: string;
  name: string;
  bundleId: string | undefined;
  sku: string | undefined;
  /** Platforms of the app's App Store versions (IOS, MAC_OS, …). */
  platforms: string[];
}

/**
 * Every app of the key's team: `GET /v1/apps`, paginated by `links.next`.
 * The platforms come from the included App Store versions (one request per
 * page instead of one listing per platform); they are only a label.
 */
export async function listApps(
  client: AppStoreConnectClient,
): Promise<AppStoreApp[]> {
  const apps: AppStoreApp[] = [];
  let next: string | undefined = "/v1/apps";
  let query: Record<string, string> | undefined = {
    "fields[apps]": "name,bundleId,sku,appStoreVersions",
    include: "appStoreVersions",
    "fields[appStoreVersions]": "platform",
    "limit[appStoreVersions]": "50",
    limit: String(APPS_PAGE_SIZE),
  };
  for (let page = 0; next !== undefined; page += 1) {
    if (page >= MAX_APP_PAGES) {
      throw new Error(
        `App Store Connect listed more than ${MAX_APP_PAGES * APPS_PAGE_SIZE} apps`,
      );
    }
    const body = appsPageSchema.parse(await client.getJson(next, query));
    const platformOf = new Map(
      (body.included ?? [])
        .filter((entry) => entry.type === "appStoreVersions")
        .map((entry) => [entry.id, entry.attributes?.platform]),
    );
    for (const app of body.data) {
      const platforms = new Set<string>();
      for (const version of app.relationships?.appStoreVersions?.data ?? []) {
        const platform = platformOf.get(version.id);
        if (platform) platforms.add(platform);
      }
      apps.push({
        id: app.id,
        name: app.attributes.name,
        bundleId: app.attributes.bundleId,
        sku: app.attributes.sku,
        platforms: [...platforms].sort(
          (a, b) =>
            (PLATFORM_ORDER.indexOf(a) + 1 || 99) -
              (PLATFORM_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
        ),
      });
    }
    // links.next carries every query parameter (and the page cursor).
    next = body.links?.next;
    query = undefined;
  }
  const unique = new Map(apps.map((app) => [app.id, app]));
  return [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

function platformLabel(platforms: string[]): string {
  return platforms.length === 0
    ? "app"
    : platforms
        .map((platform) => PLATFORM_LABELS[platform] ?? platform)
        .join(", ");
}

function accessTokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.accessToken;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

/**
 * The token of the optional reviews key (#190), signed by the host like the
 * main one. Absent when the connection has no reviews key, or on a host
 * that does not know reviews keys: then no review is read.
 */
function reviewsTokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.reviewsAccessToken;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

export interface AppStoreConnectConnectorOptions {
  now?: () => number;
  /**
   * Notes that carry no data (unknown product type codes, skipped
   * analytics). Default: console.warn.
   */
  log?: (message: string) => void;
  /**
   * Read App Store analytics after the sales (default true). The sales
   * tests turn it off to look at sales pages alone.
   */
  analytics?: boolean;
}

/**
 * The cursor of a reviews page: `reviews:<app index>:<sales cursor>`, read
 * after the analytics pages with the optional reviews key (#190).
 */
const REVIEWS_CURSOR = /^reviews:(\d+):(.+)$/;

export function reviewsCursor(index: number, salesCursor: string): string {
  return `reviews:${index}:${salesCursor}`;
}

/**
 * The cursor of an analytics page: `analytics:<app index>:<sales cursor>`.
 * Sales cursors are ISO timestamps, so they never look like this; the
 * sales cursor is where the next sync's sales continue.
 */
const ANALYTICS_CURSOR = /^analytics:(\d+):(.+)$/;

export function analyticsCursor(index: number, salesCursor: string): string {
  return `analytics:${index}:${salesCursor}`;
}

/**
 * App Store Connect (ADR 0014). The host signs a fresh ES256 token from the
 * connection's team key for every call and hands the connector
 * `credentials: { accessToken }`; connector code never sees the key and
 * only reaches api.appstoreconnect.apple.com.
 *
 * One connection holds one key and one vendor number (config). The apps of
 * the key's team are its resources, keyed by their numeric Apple ID.
 */
export function createAppStoreConnectConnector(
  options: AppStoreConnectConnectorOptions = {},
): Connector {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.warn(message));
  const analytics = options.analytics ?? true;

  function token(context: ConnectionContext): string {
    const value = accessTokenOf(context);
    if (!value) {
      throw new Error("App Store Connect connection has no signed token");
    }
    return value;
  }

  return {
    manifest: appStoreConnectManifest,

    async check(context, runtime): Promise<CheckResult> {
      const accessToken = accessTokenOf(context);
      if (!accessToken) {
        return {
          ok: false,
          message:
            "This connection has no App Store Connect key. Upload a team key.",
        };
      }
      if (!vendorNumberOf(context.config)) {
        return {
          ok: false,
          message:
            "Enter the vendor number from Payments and Financial Reports (digits only) to finish setup.",
        };
      }
      return checkKey(
        createAppStoreConnectClient(runtime.fetch, accessToken),
        context.config,
        now(),
      );
    },

    async discover(context, runtime): Promise<Resource[]> {
      const apps = await listApps(
        createAppStoreConnectClient(runtime.fetch, token(context)),
      );
      return apps.map((app) => ({
        id: app.id,
        name: app.name,
        kind: platformLabel(app.platforms),
        metadata: {
          ...(app.bundleId ? { bundleId: app.bundleId } : {}),
          ...(app.sku ? { sku: app.sku } : {}),
          platforms: app.platforms,
        },
      }));
    },

    /**
     * App icons (#226): the App Store artwork from the public lookup, else
     * the newest build's icon when the key may read builds. The signed
     * token goes to the App Store Connect API only, never to the lookup or
     * the image CDN.
     */
    async resourceIcons(context, request, runtime) {
      const accessToken = accessTokenOf(context);
      return {
        icons: await appIcons(
          runtime.fetch,
          request.resources,
          accessToken
            ? createAppStoreConnectClient(runtime.fetch, accessToken)
            : undefined,
        ),
      };
    },

    async sync(context, request: SyncRequest, runtime): Promise<SyncResult> {
      const vendorNumber = vendorNumberOf(context.config);
      if (!vendorNumber) {
        throw new Error(
          "Enter the vendor number from Payments and Financial Reports (digits only) to finish setup.",
        );
      }
      const client = createAppStoreConnectClient(runtime.fetch, token(context));
      const reviewsToken = reviewsTokenOf(context);
      const appIdsOf = async () =>
        request.resources !== undefined
          ? [...request.resources].sort()
          : (await listApps(client)).map((app) => app.id).sort();
      /** What follows the analytics: the reviews, or the end of the run. */
      const afterAnalytics = (
        observations: SyncResult["observations"],
        salesCursor: string,
      ): SyncResult =>
        reviewsToken !== undefined && request.resources?.length !== 0
          ? {
              observations,
              nextCursor: reviewsCursor(0, salesCursor),
              done: false,
            }
          : { observations, nextCursor: salesCursor, done: true };

      // Reviews pages come last (#190), with the reviews key's own token
      // and hourly budget. A refused reviews key pauses only the reviews.
      const reviewsResumed = REVIEWS_CURSOR.exec(request.cursor ?? "");
      if (reviewsResumed) {
        const start = Number(reviewsResumed[1]);
        const salesCursor = reviewsResumed[2]!;
        if (reviewsToken === undefined) {
          return { observations: [], nextCursor: salesCursor, done: true };
        }
        const appIds = await appIdsOf();
        const end = Math.min(start + REVIEWS_APPS_PER_PAGE, appIds.length);
        const { observations, stop } = await syncReviewApps(
          createAppStoreConnectClient(runtime.fetch, reviewsToken),
          appIds.slice(start, end),
          { now: now(), from: request.from, maxDays: BACKFILL_DAYS, log },
        );
        return end < appIds.length && !stop
          ? {
              observations,
              nextCursor: reviewsCursor(end, salesCursor),
              done: false,
            }
          : { observations, nextCursor: salesCursor, done: true };
      }

      // Analytics pages come after the sales of a sync (ADR 0014, #174):
      // a few apps per page, each page within its own time budget.
      const resumed = ANALYTICS_CURSOR.exec(request.cursor ?? "");
      if (resumed) {
        const start = Number(resumed[1]);
        const salesCursor = resumed[2]!;
        const appIds = await appIdsOf();
        const end = Math.min(start + ANALYTICS_APPS_PER_PAGE, appIds.length);
        const { observations, rateLimited } = await syncAnalyticsApps(
          client,
          runtime.fetch,
          appIds.slice(start, end),
          { now: now(), log },
        );
        return end < appIds.length && !rateLimited
          ? {
              observations,
              nextCursor: analyticsCursor(end, salesCursor),
              done: false,
            }
          : afterAnalytics(observations, salesCursor);
      }

      const sales = await syncSalesPage(client, request, {
        now: now(),
        vendorNumber,
        log,
        listAppSkus: async () =>
          new Map(
            (await listApps(client)).flatMap((app) =>
              app.sku ? [[app.sku, app.id] as const] : [],
            ),
          ),
      });
      if (!sales.done || request.resources?.length === 0) {
        return sales;
      }
      if (!analytics) {
        return afterAnalytics(sales.observations, sales.nextCursor!);
      }
      return {
        observations: sales.observations,
        nextCursor: analyticsCursor(0, sales.nextCursor!),
        done: false,
      };
    },
  };
}
