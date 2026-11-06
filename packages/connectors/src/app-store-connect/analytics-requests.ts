import { z } from "zod";

import {
  AppStoreConnectApiError,
  ascErrorBody,
  type AppStoreConnectClient,
} from "./api.js";

// Analytics report requests (ADR 0014, "(b) Analytics Reports API"). One
// ONGOING request per app makes Apple generate its analytics reports every
// day. Listing works with the connection's Sales key; creating one needs an
// Admin key, which the host uses once, in memory (#174)
// (https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports,
// https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-analyticsreportrequests,
// https://developer.apple.com/documentation/appstoreconnectapi/post-v1-analyticsreportrequests).

/** The access type netrics requests and reads: current data, every day. */
export const ANALYTICS_ACCESS_TYPE = "ONGOING";

/** Requests per page of `GET /v1/apps/{id}/analyticsReportRequests`. */
const REQUESTS_PAGE_SIZE = 50;
/** Pages read at most (an app has very few requests). */
const MAX_REQUEST_PAGES = 5;

const requestsPageSchema = z.object({
  data: z.array(
    z
      .object({
        type: z.literal("analyticsReportRequests"),
        id: z.string().min(1),
        attributes: z
          .object({
            accessType: z.string().optional(),
            stoppedDueToInactivity: z.boolean().optional(),
          })
          .loose()
          .optional(),
      })
      .loose(),
  ),
  links: z.object({ next: z.string().optional() }).loose().optional(),
});

const createdSchema = z.object({
  data: z
    .object({
      type: z.literal("analyticsReportRequests"),
      id: z.string().min(1),
    })
    .loose(),
});

export interface AnalyticsReportRequest {
  id: string;
  /** Apple stopped it because nobody read its reports for a long time. */
  stopped: boolean;
}

/** The app's ONGOING analytics report requests, stopped ones included. */
export async function listAnalyticsRequests(
  client: AppStoreConnectClient,
  appId: string,
): Promise<AnalyticsReportRequest[]> {
  if (!/^\d+$/.test(appId)) {
    throw new Error("App Store app IDs are numeric");
  }
  const found: AnalyticsReportRequest[] = [];
  let next: string | undefined = `/v1/apps/${appId}/analyticsReportRequests`;
  let query: Record<string, string> | undefined = {
    "filter[accessType]": ANALYTICS_ACCESS_TYPE,
    "fields[analyticsReportRequests]": "accessType,stoppedDueToInactivity",
    limit: String(REQUESTS_PAGE_SIZE),
  };
  for (let page = 0; next !== undefined; page += 1) {
    if (page >= MAX_REQUEST_PAGES) break;
    const body = requestsPageSchema.parse(await client.getJson(next, query));
    for (const entry of body.data) {
      // The filter is Apple's; a snapshot request is never used here.
      if (
        entry.attributes?.accessType !== undefined &&
        entry.attributes.accessType !== ANALYTICS_ACCESS_TYPE
      ) {
        continue;
      }
      found.push({
        id: entry.id,
        stopped: entry.attributes?.stoppedDueToInactivity === true,
      });
    }
    next = body.links?.next;
    query = undefined;
  }
  return found;
}

/** The request whose reports are read: the first one that still runs. */
export function activeRequest(
  requests: readonly AnalyticsReportRequest[],
): AnalyticsReportRequest | undefined {
  return requests.find((request) => !request.stopped);
}

export type AnalyticsRequestOutcome =
  | { status: "existing"; requestId: string | undefined }
  | { status: "created"; requestId: string };

/**
 * Makes sure the app has a running ONGOING request: an existing one is
 * reused, otherwise one is created. Apple answers 409 when a request of
 * this kind already exists (made by another tool in between), which counts
 * as existing. A stopped request does not count: Apple asks for a new one.
 * Creating needs an Admin key; other answers throw AppStoreConnectApiError.
 */
export async function ensureAnalyticsRequest(
  client: AppStoreConnectClient,
  appId: string,
): Promise<AnalyticsRequestOutcome> {
  const existing = activeRequest(await listAnalyticsRequests(client, appId));
  if (existing) {
    return { status: "existing", requestId: existing.id };
  }
  const response = await client.postJson("/v1/analyticsReportRequests", {
    data: {
      type: "analyticsReportRequests",
      attributes: { accessType: ANALYTICS_ACCESS_TYPE },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  });
  if (response.status === 201 || response.status === 200) {
    return {
      status: "created",
      requestId: createdSchema.parse(response.json()).data.id,
    };
  }
  if (response.status === 409) {
    return { status: "existing", requestId: undefined };
  }
  throw new AppStoreConnectApiError(response.status, ascErrorBody(response));
}
