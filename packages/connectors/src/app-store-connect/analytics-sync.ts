import type { Observation } from "@netrics/connector-sdk";
import { z } from "zod";

import {
  AppStoreConnectApiError,
  AppStoreConnectRateBudgetError,
  type AppStoreConnectClient,
  type AscFetch,
} from "./api.js";
import { activeRequest, listAnalyticsRequests } from "./analytics-requests.js";
import {
  AnalyticsReportError,
  DISCOVERY_REPORT_NAME,
  DOWNLOADS_REPORT_NAME,
  isFirstTimeDownload,
  isImpression,
  isProductPageView,
  parseDiscoveryReport,
  parseDownloadsReport,
  readSegment,
  sourceLabel,
} from "./analytics-report.js";
import { pacificToday } from "./probes.js";
import { mapLimited } from "./sales-sync.js";

// Analytics sync (ADR 0014, #174): with the connection's Sales key, per app
// request → reports → DAILY instances → segments → presigned download. The
// chain is documented in
// https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports.

const DAY_MS = 24 * 60 * 60 * 1000;
const PREFIX = "app_store_connect";

export const ANALYTICS_METRIC_KEYS = {
  impressions: `${PREFIX}.impressions`,
  productPageViews: `${PREFIX}.product_page_views`,
  storeDownloads: `${PREFIX}.store_downloads`,
} as const;

/**
 * Hosts of the presigned segment URLs, exactly (no wildcard). Apple's
 * documentation shows a QA bucket in its example
 * (`asp-qa-us-west-2.s3.us-west-2.amazonaws.com`,
 * https://developer.apple.com/documentation/appstoreconnectapi/get-v1-analyticsreportinstances-_id_-segments)
 * and does not document the production bucket. Production segment URLs
 * recorded by other integrations (2026-08/09) use the bucket host
 * `asp-us-west-2.s3.us-west-2.amazonaws.com` with paths
 * `/reports/<app id>/<report>/daily/ongoing/<date>/…csv.gz`. netrics pins
 * that bucket host only; the exit gate (#176) confirms it against a real
 * account. A segment URL on any other host fails that app's analytics, and
 * sales keep syncing (ADR 0014: never `*.amazonaws.com`).
 */
export const ANALYTICS_SEGMENT_HOSTS: readonly string[] = [
  "asp-us-west-2.s3.us-west-2.amazonaws.com",
];

/**
 * Processing days read again on every sync: a day's data is complete
 * "within three days" (Discovery and Engagement) or two (Downloads), and
 * late events arrive as further instances.
 */
export const ANALYTICS_LOOKBACK_DAYS = 7;
/** Apps whose analytics one sync page reads (each page has 60 s). */
export const ANALYTICS_APPS_PER_PAGE = 2;
/** Segment lists and downloads at once, per app. */
const SEGMENT_CONCURRENCY = 4;
const REPORTS_PAGE_SIZE = 200;
const INSTANCES_PAGE_SIZE = 200;
const SEGMENTS_PAGE_SIZE = 50;
const MAX_PAGES = 10;
/** Instances read at most per report and sync (the lookback has seven). */
const MAX_INSTANCES = 10;

const reportsPageSchema = z.object({
  data: z.array(
    z
      .object({
        type: z.literal("analyticsReports"),
        id: z.string().min(1),
        attributes: z
          .object({
            name: z.string().optional(),
            category: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
  links: z.object({ next: z.string().optional() }).loose().optional(),
});

const instancesPageSchema = z.object({
  data: z.array(
    z
      .object({
        type: z.literal("analyticsReportInstances"),
        id: z.string().min(1),
        attributes: z
          .object({
            granularity: z.string().optional(),
            processingDate: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
  links: z.object({ next: z.string().optional() }).loose().optional(),
});

const segmentsPageSchema = z.object({
  data: z.array(
    z
      .object({
        type: z.literal("analyticsReportSegments"),
        id: z.string().min(1),
        attributes: z
          .object({
            checksum: z.string().optional(),
            sizeInBytes: z.number().optional(),
            url: z.string().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
  links: z.object({ next: z.string().optional() }).loose().optional(),
});

/** Every page of a JSON:API listing, following `links.next`. */
async function listAll<T extends { links?: { next?: string } | undefined }>(
  client: AppStoreConnectClient,
  path: string,
  query: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const pages: T[] = [];
  let next: string | undefined = path;
  let params: Record<string, string> | undefined = query;
  for (let page = 0; next !== undefined && page < MAX_PAGES; page += 1) {
    const body = schema.parse(await client.getJson(next, params));
    pages.push(body);
    next = body.links?.next;
    params = undefined;
  }
  return pages;
}

/** The request's reports by exact name. */
async function reportIds(
  client: AppStoreConnectClient,
  requestId: string,
): Promise<Map<string, string>> {
  const pages = await listAll(
    client,
    `/v1/analyticsReportRequests/${encodeURIComponent(requestId)}/reports`,
    {
      "fields[analyticsReports]": "name,category",
      limit: String(REPORTS_PAGE_SIZE),
    },
    reportsPageSchema,
  );
  const byName = new Map<string, string>();
  for (const page of pages) {
    for (const report of page.data) {
      const name = report.attributes?.name;
      if (name && !byName.has(name)) byName.set(name, report.id);
    }
  }
  return byName;
}

interface Instance {
  id: string;
  processingDate: string;
}

/** The report's DAILY instances, newest processing day first. */
async function dailyInstances(
  client: AppStoreConnectClient,
  reportId: string,
): Promise<Instance[]> {
  const pages = await listAll(
    client,
    `/v1/analyticsReports/${encodeURIComponent(reportId)}/instances`,
    {
      "filter[granularity]": "DAILY",
      "fields[analyticsReportInstances]": "granularity,processingDate",
      limit: String(INSTANCES_PAGE_SIZE),
    },
    instancesPageSchema,
  );
  const instances: Instance[] = [];
  for (const page of pages) {
    for (const instance of page.data) {
      const { granularity, processingDate } = instance.attributes ?? {};
      if (granularity !== undefined && granularity !== "DAILY") continue;
      if (!processingDate || !/^\d{4}-\d{2}-\d{2}$/.test(processingDate)) {
        continue;
      }
      instances.push({ id: instance.id, processingDate });
    }
  }
  return instances.sort((a, b) =>
    b.processingDate.localeCompare(a.processingDate),
  );
}

interface Segment {
  url: string;
  checksum: string | undefined;
}

async function segmentsOf(
  client: AppStoreConnectClient,
  instanceId: string,
): Promise<Segment[]> {
  const pages = await listAll(
    client,
    `/v1/analyticsReportInstances/${encodeURIComponent(instanceId)}/segments`,
    {
      "fields[analyticsReportSegments]": "checksum,sizeInBytes,url",
      limit: String(SEGMENTS_PAGE_SIZE),
    },
    segmentsPageSchema,
  );
  return pages.flatMap((page) =>
    page.data.flatMap((segment) =>
      segment.attributes?.url
        ? [
            {
              url: segment.attributes.url,
              checksum: segment.attributes.checksum,
            },
          ]
        : [],
    ),
  );
}

/** A segment URL outside ANALYTICS_SEGMENT_HOSTS (never fetched). */
export class AnalyticsSegmentHostError extends Error {
  constructor(host: string) {
    super(
      `App Store analytics segment is hosted on ${host.slice(0, 120)}, which netrics does not allow (allowed: ${ANALYTICS_SEGMENT_HOSTS.join(", ")})`,
    );
    this.name = "AnalyticsSegmentHostError";
  }
}

/**
 * Downloads one presigned segment. The URL is a bearer credential: it is
 * never put in an error or log, and no App Store Connect token is sent with
 * it. The host is checked against the pinned list before the request.
 */
export async function downloadSegment(
  fetch: AscFetch,
  segment: Segment,
  hosts: readonly string[] = ANALYTICS_SEGMENT_HOSTS,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(segment.url);
  } catch {
    throw new AnalyticsReportError(
      "App Store analytics segment has no valid download URL",
    );
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !hosts.includes(host)) {
    throw new AnalyticsSegmentHostError(
      url.protocol === "https:" ? host : `${url.protocol}//${host}`,
    );
  }
  let response;
  try {
    response = await fetch(url.toString(), { method: "GET" });
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    // The cause may quote the presigned URL: it is not passed on.
    throw new AnalyticsReportError(
      `App Store analytics segment download failed (${name})`,
    );
  }
  if (response.status !== 200) {
    // 403 usually means the 5-minute link expired.
    throw new AnalyticsReportError(
      `App Store analytics segment download answered ${response.status}`,
    );
  }
  return readSegment(response.bytes(), segment.checksum);
}

interface ReportWindow {
  /** Rows of these dates are emitted (all when undefined). */
  from: string | undefined;
  texts: string[];
  /** DAILY instances the report has (0: no data generated yet). */
  instances: number;
}

/**
 * Reads the segments of a report's DAILY instances processed within the
 * lookback. An instance holds data up to its processing day (and late
 * events of earlier days), so a date D is complete once every instance
 * processed on or after D is read: dates before the oldest instance read
 * are left out, unless no older instance exists (a new request's first
 * instances may carry earlier days).
 */
async function readReport(
  client: AppStoreConnectClient,
  fetch: AscFetch,
  reportId: string,
  sinceDate: string,
  hosts: readonly string[],
): Promise<ReportWindow> {
  const instances = await dailyInstances(client, reportId);
  const recent = instances
    .filter((instance) => instance.processingDate >= sinceDate)
    .slice(0, MAX_INSTANCES);
  const oldestRead = recent.at(-1)?.processingDate;
  const olderExists = instances.some(
    (instance) =>
      oldestRead === undefined || instance.processingDate < oldestRead,
  );
  const segmentLists = await mapLimited(
    recent,
    SEGMENT_CONCURRENCY,
    (instance) => segmentsOf(client, instance.id),
  );
  // Each list is downloaded right away: the links last five minutes.
  const texts = await mapLimited(
    segmentLists.flat(),
    SEGMENT_CONCURRENCY,
    (segment) => downloadSegment(fetch, segment, hosts),
  );
  return {
    from: olderExists ? (oldestRead ?? sinceDate) : undefined,
    texts,
    instances: instances.length,
  };
}

function stamp(date: string): string {
  return `${date}T00:00:00.000Z`;
}

function add(map: Map<string, number>, key: string, value: number) {
  map.set(key, (map.get(key) ?? 0) + value);
}

export type AppAnalyticsStatus =
  /** No ONGOING request: analytics was never enabled for the app. */
  | "not_enabled"
  /** Every request stopped: "App Store analytics paused — enable again". */
  | "stopped"
  /** Requested; the reports have no instance yet (1–2 days). */
  | "pending"
  | "read";

export interface AppAnalyticsResult {
  status: AppAnalyticsStatus;
  observations: Observation[];
}

/**
 * The analytics observations of one app: impressions and product page
 * views per day (Discovery and Engagement), and first-time downloads per
 * day and source type (App Downloads). Days are Apple's reporting days,
 * stamped D T00:00:00Z (ADR 0008).
 */
export async function readAppAnalytics(
  client: AppStoreConnectClient,
  fetch: AscFetch,
  appId: string,
  options: { now: number; hosts?: readonly string[] },
): Promise<AppAnalyticsResult> {
  const requests = await listAnalyticsRequests(client, appId);
  const request = activeRequest(requests);
  if (!request) {
    return {
      status: requests.length > 0 ? "stopped" : "not_enabled",
      observations: [],
    };
  }
  const reports = await reportIds(client, request.id);
  const sinceDate = new Date(
    pacificToday(options.now) - ANALYTICS_LOOKBACK_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const hosts = options.hosts ?? ANALYTICS_SEGMENT_HOSTS;
  const discoveryId = reports.get(DISCOVERY_REPORT_NAME);
  const downloadsId = reports.get(DOWNLOADS_REPORT_NAME);
  const discovery = discoveryId
    ? await readReport(client, fetch, discoveryId, sinceDate, hosts)
    : undefined;
  const downloads = downloadsId
    ? await readReport(client, fetch, downloadsId, sinceDate, hosts)
    : undefined;

  const observations: Observation[] = [];
  const resource = { resource: appId };
  const inWindow = (window: ReportWindow, date: string) =>
    window.from === undefined || date >= window.from;

  if (discovery) {
    const impressions = new Map<string, number>();
    const views = new Map<string, number>();
    for (const text of discovery.texts) {
      for (const row of parseDiscoveryReport(text)) {
        if (row.appId !== appId || !inWindow(discovery, row.date)) continue;
        add(impressions, row.date, isImpression(row) ? row.counts : 0);
        add(views, row.date, isProductPageView(row) ? row.counts : 0);
      }
    }
    for (const date of [...impressions.keys()].sort()) {
      observations.push(
        {
          metricKey: ANALYTICS_METRIC_KEYS.impressions,
          sourceTimestamp: stamp(date),
          value: impressions.get(date)!,
          dimensions: resource,
        },
        {
          metricKey: ANALYTICS_METRIC_KEYS.productPageViews,
          sourceTimestamp: stamp(date),
          value: views.get(date) ?? 0,
          dimensions: resource,
        },
      );
    }
  }
  if (downloads) {
    const bySource = new Map<string, Map<string, number>>();
    for (const text of downloads.texts) {
      for (const row of parseDownloadsReport(text)) {
        if (row.appId !== appId || !inWindow(downloads, row.date)) continue;
        if (!isFirstTimeDownload(row)) continue;
        let day = bySource.get(row.date);
        if (!day) {
          day = new Map();
          bySource.set(row.date, day);
        }
        add(day, sourceLabel(row.sourceType), row.counts);
      }
    }
    for (const date of [...bySource.keys()].sort()) {
      for (const [source, value] of [...bySource.get(date)!].sort((a, b) =>
        a[0].localeCompare(b[0]),
      )) {
        observations.push({
          metricKey: ANALYTICS_METRIC_KEYS.storeDownloads,
          sourceTimestamp: stamp(date),
          value,
          dimensions: { ...resource, source },
        });
      }
    }
  }
  return {
    status:
      (discovery?.instances ?? 0) + (downloads?.instances ?? 0) > 0
        ? "read"
        : "pending",
    observations,
  };
}

/** Errors that end the analytics of this sync run, not just one app's. */
function stopsRun(error: unknown): boolean {
  return (
    error instanceof AppStoreConnectRateBudgetError ||
    (error instanceof AppStoreConnectApiError && error.status === 429)
  );
}

/**
 * A refused token is the key's problem (the host puts the connection in
 * auth_failed), so it is thrown; anything else fails analytics only.
 */
function isRefusedKey(error: unknown): boolean {
  return error instanceof Error && error.name === "AccessTokenRejectedError";
}

/** A log line for an app's failed analytics, without URLs or tokens. */
function failureNote(appId: string, error: unknown): string {
  const message =
    error instanceof AnalyticsReportError ||
    error instanceof AnalyticsSegmentHostError ||
    error instanceof AppStoreConnectApiError
      ? error.message
      : `${error instanceof Error ? error.name : "Error"}`;
  return `App Store analytics of app ${appId} skipped: ${message.slice(0, 300)}`;
}

/**
 * Reads the analytics of the given apps. Analytics never stop sales: an
 * app whose analytics fail (a checksum, a host outside the allowlist, an
 * unreadable file, a 5xx) is skipped and logged, and a rate limit ends the
 * analytics of this run early. Only a refused key (401) is thrown.
 */
export async function syncAnalyticsApps(
  client: AppStoreConnectClient,
  fetch: AscFetch,
  appIds: readonly string[],
  options: {
    now: number;
    log: (message: string) => void;
    hosts?: readonly string[];
  },
): Promise<{ observations: Observation[]; rateLimited: boolean }> {
  const observations: Observation[] = [];
  for (const appId of appIds) {
    try {
      const result = await readAppAnalytics(client, fetch, appId, options);
      if (result.status === "stopped") {
        options.log(
          `App Store analytics of app ${appId} paused: Apple stopped its report request; enable analytics again`,
        );
      }
      observations.push(...result.observations);
    } catch (error) {
      if (isRefusedKey(error)) throw error;
      if (stopsRun(error)) {
        options.log(
          "App Store analytics postponed: the key's hourly request budget is used up",
        );
        return { observations, rateLimited: true };
      }
      options.log(failureNote(appId, error));
    }
  }
  return { observations, rateLimited: false };
}
