import type {
  CheckResult,
  ConnectionContext,
  Connector,
  ConnectorManifest,
  Resource,
  SyncRequest,
  SyncResult,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  APP_STORE_CONNECT_HOST,
  createAppStoreConnectClient,
  type AppStoreConnectClient,
} from "./api.js";
import { checkKey, vendorNumberOf } from "./probes.js";

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
  AGREEMENTS_MESSAGE,
  KEY_MISMATCH_MESSAGE,
  ROLE_MESSAGE,
  SALES_REPORT_FILTERS,
  VENDOR_NUMBER_FORMAT_MESSAGE,
  checkKey,
  latestReportDate,
  probeApps,
  probeSalesReport,
  vendorNumberMessage,
  vendorNumberOf,
  type ProbeResult,
} from "./probes.js";

const PREFIX = "app_store_connect";

/** Apps per page of `GET /v1/apps` (Apple allows up to 200). */
export const APPS_PAGE_SIZE = 100;
/** Pages of apps read at most (5,000 apps). */
const MAX_APP_PAGES = 50;

export const appStoreConnectManifest: ConnectorManifest = {
  id: "app-store-connect",
  version: "0.1.0",
  sdkVersion: "^0.2.3",
  name: "App Store Connect",
  description:
    "Downloads, in-app purchases and proceeds of your apps from App Store Connect sales reports, per app.",
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
  // The sales metrics arrive with the sales sync (#172, ADR 0014); the
  // manifest needs at least one metric, and this is the first of them.
  metrics: [
    {
      key: `${PREFIX}.downloads`,
      name: "Downloads",
      description:
        "First-time downloads per day and app, from the daily App Store sales report (reporting days are Pacific Time).",
      kind: "delta",
      unit: "downloads",
      granularity: "day",
      dimensions: ["resource"],
      aggregations: ["sum", "avg", "min", "max"],
    },
  ],
  // Daily reports arrive once a day, the next morning Pacific Time.
  minRefreshIntervalSeconds: 6 * 60 * 60,
  // TODO(#172): the sales sync backfills 365 days (supportsBackfill: true,
  // backfillDays: 365). Until then no backfill runs, so none is marked done
  // without data.
  supportsBackfill: false,
  // The analytics segment host joins with the analytics issue (#174).
  outboundDomains: [APP_STORE_CONNECT_HOST],
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

export interface AppStoreConnectConnectorOptions {
  now?: () => number;
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

    // TODO(#172): the daily sales sync. Until then a sync reads nothing and
    // keeps its cursor where it started, so the sales sync later begins
    // from there instead of a window that was never read.
    async sync(_context, request: SyncRequest): Promise<SyncResult> {
      return {
        observations: [],
        nextCursor: request.cursor ?? request.from,
        done: true,
      };
    },
  };
}
