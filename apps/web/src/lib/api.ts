import { ZodError, type ZodType } from "zod";

import {
  IMAGE_NAME_HEADER,
  createDashboardFromTemplateRequestSchema,
  dashboardTemplateOptionsResponseSchema,
  resourceIconListResponseSchema,
  useResourceIconRequestSchema,
  type CreateDashboardFromTemplateRequest,
  type DashboardTemplateOptionsResponse,
  type ResourceIconListResponse,
  imageListResponseSchema,
  imageResponseSchema,
  type ImageContentType,
  type ImageListResponse,
  type ImageResponse,
  createWorkspaceResponseSchema,
  type CreateWorkspaceResponse,
  addDemoContentResponseSchema,
  type AddDemoContentResponse,
  createDashboardRequestSchema,
  dashboardListResponseSchema,
  approveDeviceRequestSchema,
  dashboardResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  duplicateDashboardRequestSchema,
  metricCurrenciesRequestSchema,
  metricCurrenciesResponseSchema,
  metricResourcesRequestSchema,
  metricResourcesResponseSchema,
  metricBreakdownRequestSchema,
  metricBreakdownResponseSchema,
  metricQueryRequestSchema,
  metricQueryResponseSchema,
  replaceDashboardRequestSchema,
  updateDeviceRequestSchema,
  workspaceMetricListResponseSchema,
  type CreateDashboardRequest,
  type DashboardListResponse,
  type ApproveDeviceRequest,
  type DashboardResponse,
  type DeviceListResponse,
  type DeviceResponse,
  type CurrencyConversionOptionsResponse,
  currencyConversionOptionsResponseSchema,
  type MetricCurrenciesRequest,
  type MetricCurrenciesResponse,
  type MetricResourcesRequest,
  type MetricResourcesResponse,
  type MetricBreakdownRequest,
  type MetricBreakdownResponse,
  type MetricQueryRequest,
  type MetricQueryResponse,
  type ReplaceDashboardRequest,
  type UpdateDeviceRequest,
  type WorkspaceMetricListResponse,
  acceptInvitationResponseSchema,
  appStoreAnalyticsStatusResponseSchema,
  enableAppStoreAnalyticsRequestSchema,
  enableAppStoreAnalyticsResponseSchema,
  type AppStoreAnalyticsStatusResponse,
  appStoreReviewsStatusResponseSchema,
  type AppStoreReviewsStatusResponse,
  type EnableAppStoreAnalyticsRequest,
  type EnableAppStoreAnalyticsResponse,
  connectionDetailResponseSchema,
  connectionListResponseSchema,
  connectionPreviewResponseSchema,
  connectionResourcesResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  createConnectionRequestSchema,
  createInvitationRequestSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
  deleteConnectionResponseSchema,
  enqueueSyncResponseSchema,
  errorResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  invitationListResponseSchema,
  invitationPreviewResponseSchema,
  invitationResponseSchema,
  meResponseSchema,
  memberListResponseSchema,
  memberResponseSchema,
  observationListResponseSchema,
  previewConnectionRequestSchema,
  projectListResponseSchema,
  projectResponseSchema,
  renameWorkspaceRequestSchema,
  updateMeRequestSchema,
  setupStatusResponseSchema,
  startOAuthAuthorizationRequestSchema,
  startOAuthAuthorizationResponseSchema,
  timeZoneSchema,
  updateConnectionRequestSchema,
  updateMemberRoleRequestSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  type ConnectionDetailResponse,
  type ConnectionListResponse,
  type ConnectionPreviewResponse,
  type ConnectionResourcesResponse,
  type ConnectionResponse,
  type ConnectorListResponse,
  type CreateConnectionRequest,
  type DeleteConnectionResponse,
  type EnqueueSyncResponse,
  type HealthLiveResponse,
  type HealthReadyResponse,
  type InvitationListResponse,
  type InvitationPreviewResponse,
  type InvitationResponse,
  type MemberListResponse,
  type MemberResponse,
  type MeResponse,
  type ObservationListResponse,
  type PreviewConnectionRequest,
  type ProjectListResponse,
  type ProjectResponse,
  type SetupStatusResponse,
  type StartOAuthAuthorizationRequest,
  type StartOAuthAuthorizationResponse,
  type UpdateConnectionRequest,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type WorkspaceRole,
  createThemeRequestSchema,
  themeErrorResponseSchema,
  themeListResponseSchema,
  themeResponseSchema,
  updateThemeRequestSchema,
  type CreateThemeRequest,
  type ThemeErrorResponse,
  type ThemeListResponse,
  type ThemeResponse,
  type UpdateThemeRequest,
} from "@netrics/contracts";
import type { Locale, MessageKey } from "@netrics/domain";

import { apiFetch } from "./api-fetch";
import { webTranslator, type WebMessages } from "./i18n/catalogs";
import { toStudioImage, type StudioImage } from "./studio-widgets";

/**
 * API failures carry a machine-readable code in the response body
 * ({"error":"last_owner"} etc.); ApiError preserves both so the UI can show
 * a plain message instead of failing silently.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** Extra fields some errors carry (theme contrast, dashboards in use). */
    public readonly details: Omit<ThemeErrorResponse, "error"> = {},
  ) {
    super(code);
    this.name = "ApiError";
  }
}

/** API error codes that share one message. */
const API_ERROR_ALIASES: Readonly<Record<string, ApiErrorKey>> = {
  workspace_not_found: "record_not_found",
  member_not_found: "record_not_found",
  project_not_found: "record_not_found",
  connection_not_found: "record_not_found",
  review_not_found: "record_not_found",
  image_type_mismatch: "image_invalid",
  unsupported_media_type: "image_invalid",
  tile_metric_not_found: "metric_not_found",
};

type ApiErrorKey = MessageKey<WebMessages["apiErrors"]>;

/**
 * An error for the user, in their language: API error codes are worded
 * from the catalog (ADR 0016 section 5; the API returns codes, not prose).
 */
export function apiErrorMessage(error: unknown, locale: Locale): string {
  const t = webTranslator(locale, "apiErrors");
  if (error instanceof ApiError) {
    const code = API_ERROR_ALIASES[error.code] ?? error.code;
    if (code === "theme_in_use" || code === "image_in_use") {
      const names = error.details.dashboards?.map((d) => d.name) ?? [];
      if (names.length > 0) {
        return t(`${code}_by`, {
          names: new Intl.ListFormat(locale, { type: "conjunction" }).format(
            names,
          ),
        });
      }
    }
    if (/^[a-z_]+$/.test(code)) {
      return t.has(code) ? t(code) : t("requestFailed", { code });
    }
    // Connector check/preview failures arrive as human-readable,
    // already-redacted messages rather than snake_case codes.
    return error.code;
  }
  if (error instanceof ZodError) {
    return t("invalidInput");
  }
  return error instanceof Error ? error.message : t("generic");
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    return errorResponseSchema.parse(await response.json()).error;
  } catch {
    // Non-JSON or unexpected body: keep the generic code.
    return "request_failed";
  }
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const { error, ...details } = themeErrorResponseSchema.parse(
      await response.json(),
    );
    return new ApiError(response.status, error, details);
  } catch {
    return new ApiError(response.status, "request_failed");
  }
}

async function parseResponse<T>(
  schema: ZodType<T>,
  response: Response,
): Promise<T> {
  if (!response.ok) {
    throw await readError(response);
  }
  return schema.parse(await response.json());
}

// ---------------------------------------------------------------------------
// Server-side fetchers: called from server components/route logic with the
// incoming request's cookie header forwarded to the API. The cookie is pure
// transport — the web app never reads or trusts its contents.
// ---------------------------------------------------------------------------

function serverGet<T>(
  schema: ZodType<T>,
  cookieHeader: string,
  path: string,
): Promise<T> {
  return apiFetch(path, { headers: { cookie: cookieHeader } }).then(
    (response) => parseResponse(schema, response),
  );
}

export function listInvitations(
  cookieHeader: string,
  workspaceId: string,
): Promise<InvitationListResponse> {
  return serverGet(
    invitationListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/invitations`,
  );
}

/** Public (token holder): invitation details, or null for unknown tokens. */
export async function getInvitationPreview(
  token: string,
): Promise<InvitationPreviewResponse | null> {
  const response = await apiFetch(
    `/v1/invitations/${encodeURIComponent(token)}`,
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(invitationPreviewResponseSchema, response);
}

/** Public: whether first-run setup is pending and whether sign-up is open. */
export async function getSetupStatus(): Promise<SetupStatusResponse> {
  const response = await apiFetch("/v1/setup-status");
  return parseResponse(setupStatusResponseSchema, response);
}

/** Returns null on 401 so pages can redirect to /login themselves. */
export async function getMe(cookieHeader: string): Promise<MeResponse | null> {
  const response = await apiFetch("/v1/me", {
    headers: { cookie: cookieHeader },
  });
  if (response.status === 401) {
    return null;
  }
  return parseResponse(meResponseSchema, response);
}

export function listWorkspaces(
  cookieHeader: string,
): Promise<WorkspaceListResponse> {
  return serverGet(workspaceListResponseSchema, cookieHeader, "/v1/workspaces");
}

/** Returns null on 404 (non-member or gone). */
export async function getWorkspace(
  cookieHeader: string,
  workspaceId: string,
): Promise<WorkspaceResponse | null> {
  const response = await apiFetch(`/v1/workspaces/${workspaceId}`, {
    headers: { cookie: cookieHeader },
  });
  if (response.status === 404) {
    return null;
  }
  return parseResponse(workspaceResponseSchema, response);
}

/** Whether amounts can be converted, and into which currencies (#191). */
export function getCurrencyConversion(
  cookieHeader: string,
  workspaceId: string,
): Promise<CurrencyConversionOptionsResponse> {
  return serverGet(
    currencyConversionOptionsResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/currency-conversion`,
  );
}

export function listMembers(
  cookieHeader: string,
  workspaceId: string,
): Promise<MemberListResponse> {
  return serverGet(
    memberListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/members`,
  );
}

export function listProjects(
  cookieHeader: string,
  workspaceId: string,
): Promise<ProjectListResponse> {
  return serverGet(
    projectListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/projects`,
  );
}

export function listConnectors(
  cookieHeader: string,
): Promise<ConnectorListResponse> {
  return serverGet(connectorListResponseSchema, cookieHeader, "/v1/connectors");
}

export function listConnections(
  cookieHeader: string,
  workspaceId: string,
): Promise<ConnectionListResponse> {
  return serverGet(
    connectionListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/connections`,
  );
}

/** Returns null on 404 (gone or from another workspace). */
export async function getConnection(
  cookieHeader: string,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionDetailResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    { headers: { cookie: cookieHeader } },
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(connectionDetailResponseSchema, response);
}

export function listObservations(
  cookieHeader: string,
  workspaceId: string,
  connectionId: string,
  query: { metricKey?: string; limit?: number } = {},
): Promise<ObservationListResponse> {
  const params = new URLSearchParams();
  if (query.metricKey) {
    params.set("metricKey", query.metricKey);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return serverGet(
    observationListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/observations${suffix}`,
  );
}

export interface ApiHealth {
  live: HealthLiveResponse | null;
  ready: HealthReadyResponse | null;
  error: string | null;
}

export async function fetchApiHealth(): Promise<ApiHealth> {
  try {
    const [liveResponse, readyResponse] = await Promise.all([
      apiFetch("/health/live"),
      apiFetch("/health/ready"),
    ]);

    const live = liveResponse.ok
      ? healthLiveResponseSchema.parse(await liveResponse.json())
      : null;
    const readyJson: unknown = await readyResponse.json().catch(() => null);
    const ready = readyJson ? healthReadyResponseSchema.parse(readyJson) : null;

    return { live, ready, error: null };
  } catch (error) {
    return {
      live: null,
      ready: null,
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

// ---------------------------------------------------------------------------
// Browser-side mutations: same-origin relative URLs, proxied to the API by
// the /v1 route handler (lib/api-proxy); the session cookie is attached
// automatically.
// ---------------------------------------------------------------------------

async function browserSend<T>(
  schema: ZodType<T>,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return parseResponse(schema, response);
}

/** The browser's IANA time zone, if the API accepts it. */
function browserTimeZone(): string | undefined {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZoneSchema.safeParse(timeZone).success ? timeZone : undefined;
}

/**
 * New workspaces count "today" in the creator's time zone. With `withDemo`,
 * the API also adds the demo connection and a sample dashboard (#51).
 */
export function createWorkspace(
  name: string,
  withDemo = false,
): Promise<CreateWorkspaceResponse> {
  const timeZone = browserTimeZone();
  return browserSend(
    createWorkspaceResponseSchema,
    "POST",
    "/v1/workspaces",
    createWorkspaceRequestSchema.parse({
      name,
      withDemo,
      ...(timeZone ? { timeZone } : {}),
    }),
  );
}

/**
 * The demo connection and a sample dashboard for an existing workspace
 * (onboarding's "Skip, use demo data", #308). `demoDashboardId` is null
 * when they could not be added.
 */
export function addDemoContent(
  workspaceId: string,
): Promise<AddDemoContentResponse> {
  return browserSend(
    addDemoContentResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/demo`,
  );
}

/** null: the screens follow the instance default (ADR 0016). */
export function setWorkspaceScreenLocale(
  workspaceId: string,
  screenLocale: Locale | null,
): Promise<WorkspaceResponse> {
  return browserSend(
    workspaceResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}`,
    renameWorkspaceRequestSchema.parse({ screenLocale }),
  );
}

/** The signed-in user's language; null follows the instance and browser. */
export function setMyLocale(locale: Locale | null): Promise<MeResponse> {
  return browserSend(
    meResponseSchema,
    "PATCH",
    "/v1/me",
    updateMeRequestSchema.parse({ locale }),
  );
}

export function setWorkspaceTimeZone(
  workspaceId: string,
  timeZone: string,
): Promise<WorkspaceResponse> {
  return browserSend(
    workspaceResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}`,
    renameWorkspaceRequestSchema.parse({ timeZone }),
  );
}

/** null: amounts per currency, exact (#191). */
export function setWorkspaceDisplayCurrency(
  workspaceId: string,
  displayCurrency: string | null,
): Promise<WorkspaceResponse> {
  return browserSend(
    workspaceResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}`,
    renameWorkspaceRequestSchema.parse({ displayCurrency }),
  );
}

export function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<WorkspaceResponse> {
  return browserSend(
    workspaceResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}`,
    renameWorkspaceRequestSchema.parse({ name }),
  );
}

export function createInvitation(
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<InvitationResponse> {
  return browserSend(
    invitationResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/invitations`,
    createInvitationRequestSchema.parse({ email, role }),
  );
}

export async function revokeInvitation(
  workspaceId: string,
  invitationId: string,
): Promise<void> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/invitations/${invitationId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, await readErrorCode(response));
  }
}

export function acceptInvitation(
  token: string,
): Promise<{ workspaceId: string }> {
  return browserSend(
    acceptInvitationResponseSchema,
    "POST",
    `/v1/invitations/${encodeURIComponent(token)}/accept`,
  );
}

export function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<MemberResponse> {
  return browserSend(
    memberResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}/members/${userId}`,
    updateMemberRoleRequestSchema.parse({ role }),
  );
}

export async function removeMember(
  workspaceId: string,
  userId: string,
): Promise<void> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/members/${userId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, await readErrorCode(response));
  }
}

export function createProject(
  workspaceId: string,
  name: string,
): Promise<ProjectResponse> {
  return browserSend(
    projectResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/projects`,
    createProjectRequestSchema.parse({ name }),
  );
}

export function previewConnection(
  workspaceId: string,
  input: PreviewConnectionRequest,
): Promise<ConnectionPreviewResponse> {
  return browserSend(
    connectionPreviewResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/preview`,
    previewConnectionRequestSchema.parse(input),
  );
}

export function createConnection(
  workspaceId: string,
  input: CreateConnectionRequest,
): Promise<ConnectionResponse> {
  return browserSend(
    connectionResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections`,
    createConnectionRequestSchema.parse(input),
  );
}

export function updateConnection(
  workspaceId: string,
  connectionId: string,
  input: UpdateConnectionRequest,
): Promise<ConnectionResponse> {
  return browserSend(
    connectionResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    updateConnectionRequestSchema.parse(input),
  );
}

/**
 * Deletes a connection. For an OAuth connection the answer says what
 * happened to the access at the provider (ADR 0012).
 */
export function deleteConnection(
  workspaceId: string,
  connectionId: string,
): Promise<DeleteConnectionResponse> {
  return browserSend(
    deleteConnectionResponseSchema,
    "DELETE",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
  );
}

/**
 * Starts an OAuth authorization; the caller sends the browser to the
 * returned URL with window.location (a form post would hit the CSP's
 * form-action, ADR 0012).
 */
export function startOAuthAuthorization(
  workspaceId: string,
  input: StartOAuthAuthorizationRequest,
): Promise<StartOAuthAuthorizationResponse> {
  return browserSend(
    startOAuthAuthorizationResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/oauth/authorizations`,
    startOAuthAuthorizationRequestSchema.parse(input),
  );
}

/** What an OAuth connection's account can read (e.g. its properties). */
export function listConnectionResources(
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionResourcesResponse> {
  return browserSend(
    connectionResourcesResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/resources`,
  );
}

/** App Store analytics per app (#174), read with the stored key. */
export function getAppStoreAnalytics(
  workspaceId: string,
  connectionId: string,
): Promise<AppStoreAnalyticsStatusResponse> {
  return browserSend(
    appStoreAnalyticsStatusResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/app-store-analytics`,
  );
}

/**
 * The optional App Store reviews key (#190): stored or not, and whether
 * Apple still accepts it. Added, replaced and removed with updateConnection
 * (`credentials: { reviews }`).
 */
export function getAppStoreReviews(
  workspaceId: string,
  connectionId: string,
): Promise<AppStoreReviewsStatusResponse> {
  return browserSend(
    appStoreReviewsStatusResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/app-store-reviews`,
  );
}

/**
 * Enables App Store analytics with a temporary Admin key, which the API
 * uses once in memory and never stores (ADR 0014, #174).
 */
export function enableAppStoreAnalytics(
  workspaceId: string,
  connectionId: string,
  input: EnableAppStoreAnalyticsRequest,
): Promise<EnableAppStoreAnalyticsResponse> {
  return browserSend(
    enableAppStoreAnalyticsResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/app-store-analytics`,
    enableAppStoreAnalyticsRequestSchema.parse(input),
  );
}

export function triggerConnectionSync(
  workspaceId: string,
  connectionId: string,
): Promise<EnqueueSyncResponse> {
  return browserSend(
    enqueueSyncResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/sync`,
  );
}

// ---------------------------------------------------------------------------
// Dashboards and metrics (#48, #49)
// ---------------------------------------------------------------------------

export function listDashboards(
  cookieHeader: string,
  workspaceId: string,
): Promise<DashboardListResponse> {
  return serverGet(
    dashboardListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/dashboards`,
  );
}

/** Returns null on 404. */
export async function getDashboard(
  cookieHeader: string,
  workspaceId: string,
  dashboardId: string,
): Promise<DashboardResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
    { headers: { cookie: cookieHeader } },
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(dashboardResponseSchema, response);
}

export function listWorkspaceMetrics(
  cookieHeader: string,
  workspaceId: string,
): Promise<WorkspaceMetricListResponse> {
  return serverGet(
    workspaceMetricListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/metrics`,
  );
}

export function createDashboard(
  workspaceId: string,
  body: CreateDashboardRequest,
): Promise<DashboardResponse> {
  return browserSend(
    dashboardResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards`,
    createDashboardRequestSchema.parse(body),
  );
}

/** Throws ApiError "version_conflict" (409) when someone saved first. */
export function saveDashboard(
  workspaceId: string,
  dashboardId: string,
  body: ReplaceDashboardRequest,
): Promise<DashboardResponse> {
  return browserSend(
    dashboardResponseSchema,
    "PUT",
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
    replaceDashboardRequestSchema.parse(body),
  );
}

/** The saved copy, from the browser (the Studio's reload after a conflict). */
export async function loadDashboard(
  workspaceId: string,
  dashboardId: string,
): Promise<DashboardResponse> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
    { cache: "no-store" },
  );
  return parseResponse(dashboardResponseSchema, response);
}

export function duplicateDashboard(
  workspaceId: string,
  dashboardId: string,
): Promise<DashboardResponse> {
  return browserSend(
    dashboardResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}/duplicate`,
    duplicateDashboardRequestSchema.parse({}),
  );
}

export async function deleteDashboard(
  workspaceId: string,
  dashboardId: string,
): Promise<void> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, await readErrorCode(response));
  }
}

// ---------------------------------------------------------------------------
// Dashboard themes (#216)
// ---------------------------------------------------------------------------

export function listThemes(
  cookieHeader: string,
  workspaceId: string,
): Promise<ThemeListResponse> {
  return serverGet(
    themeListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/themes`,
  );
}

/** Returns null on 404. */
export async function getTheme(
  cookieHeader: string,
  workspaceId: string,
  themeId: string,
): Promise<ThemeResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/themes/${themeId}`,
    { headers: { cookie: cookieHeader } },
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(themeResponseSchema, response);
}

export function createTheme(
  workspaceId: string,
  body: CreateThemeRequest,
): Promise<ThemeResponse> {
  return browserSend(
    themeResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/themes`,
    createThemeRequestSchema.parse(body),
  );
}

/** Throws ApiError "version_conflict" (409) when someone saved first. */
export function updateTheme(
  workspaceId: string,
  themeId: string,
  body: UpdateThemeRequest,
): Promise<ThemeResponse> {
  return browserSend(
    themeResponseSchema,
    "PUT",
    `/v1/workspaces/${workspaceId}/themes/${themeId}`,
    updateThemeRequestSchema.parse(body),
  );
}

/** Throws ApiError "theme_in_use" (409) with the dashboards that use it. */
export async function deleteTheme(
  workspaceId: string,
  themeId: string,
): Promise<void> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/themes/${themeId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    throw await readError(response);
  }
}

// ---------------------------------------------------------------------------
// Workspace images (ADR 0015, section 5; #217)
// ---------------------------------------------------------------------------

/** The workspace's images with their quota (metadata, never bytes). */
export function listImages(
  cookieHeader: string,
  workspaceId: string,
): Promise<ImageListResponse> {
  return serverGet(
    imageListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/images`,
  );
}

/** The workspace's images for logos, backgrounds and image widgets. */
export async function listStudioImages(
  cookieHeader: string,
  workspaceId: string,
): Promise<StudioImage[]> {
  const { images } = await listImages(cookieHeader, workspaceId);
  return images.map((image) => toStudioImage(workspaceId, image));
}

/**
 * Uploads an image as its raw bytes (no multipart, ADR 0015 section 5);
 * the display name travels percent-encoded in a header. Throws ApiError
 * image_too_large, image_invalid, image_animated, image_quota_exceeded …
 */
export function uploadImage(
  workspaceId: string,
  file: { name: string; type: ImageContentType; body: Blob },
): Promise<ImageResponse> {
  return fetch(`/v1/workspaces/${workspaceId}/images`, {
    method: "POST",
    headers: {
      "content-type": file.type,
      [IMAGE_NAME_HEADER]: encodeURIComponent(file.name.slice(0, 100)),
    },
    body: file.body,
  }).then((response) => parseResponse(imageResponseSchema, response));
}

/** Resources whose icon can be used as an image (#226), from the browser. */
export function listResourceIcons(
  workspaceId: string,
): Promise<ResourceIconListResponse> {
  return browserSend(
    resourceIconListResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/resource-icons`,
  );
}

/**
 * A resource's icon as a workspace image: fetched by the server through
 * the connector (never by the browser), or the stored one while fresh.
 * Throws ApiError resource_icon_not_found, resource_icon_unavailable …
 */
export function fetchResourceIcon(
  workspaceId: string,
  connectionId: string,
  resourceId: string,
): Promise<ImageResponse> {
  return browserSend(
    imageResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/resource-icons`,
    useResourceIconRequestSchema.parse({ connectionId, resourceId }),
  );
}

/** What the dashboard templates can be built from (#226). */
export function getDashboardTemplates(
  workspaceId: string,
): Promise<DashboardTemplateOptionsResponse> {
  return browserSend(
    dashboardTemplateOptionsResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/dashboard-templates`,
  );
}

/** A new dashboard from the Overview or Brand template. */
export function createDashboardFromTemplate(
  workspaceId: string,
  body: CreateDashboardFromTemplateRequest,
): Promise<DashboardResponse> {
  return browserSend(
    dashboardResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboard-templates`,
    createDashboardFromTemplateRequestSchema.parse(body),
  );
}

/**
 * Deletes an unused image. Throws ApiError image_in_use (with the
 * dashboards that use it in `details.dashboards`) while one still does.
 */
export async function deleteImage(
  workspaceId: string,
  imageId: string,
): Promise<void> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/images/${imageId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    throw await readError(response);
  }
}

/** One tile's numbers (browser; tiles refresh themselves). */
export function queryMetric(
  workspaceId: string,
  body: MetricQueryRequest,
): Promise<MetricQueryResponse> {
  return browserSend(
    metricQueryResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/metrics/query`,
    metricQueryRequestSchema.parse(body),
  );
}

/** A metric by one of its dimensions: a bar widget's groups (ADR 0015). */
export function queryMetricBreakdown(
  workspaceId: string,
  body: MetricBreakdownRequest,
): Promise<MetricBreakdownResponse> {
  return browserSend(
    metricBreakdownResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/metrics/breakdown`,
    metricBreakdownRequestSchema.parse(body),
  );
}

/** A per-currency metric's currencies, largest total first (ADR 0014). */
export function listMetricCurrencies(
  workspaceId: string,
  body: MetricCurrenciesRequest,
): Promise<MetricCurrenciesResponse> {
  return browserSend(
    metricCurrenciesResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/metrics/currencies`,
    metricCurrenciesRequestSchema.parse(body),
  );
}

/** The resources a tile of a metric can show (#194), named first. */
export function listMetricResources(
  workspaceId: string,
  body: MetricResourcesRequest,
): Promise<MetricResourcesResponse> {
  return browserSend(
    metricResourcesResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/metrics/resources`,
    metricResourcesRequestSchema.parse(body),
  );
}

// ---------------------------------------------------------------------------
// Devices (ADR 0011)
// ---------------------------------------------------------------------------

/** Throws ApiError "pairing_not_found" or "too_many_attempts". */
export function approveDevice(
  workspaceId: string,
  body: ApproveDeviceRequest,
): Promise<DeviceResponse> {
  return browserSend(
    deviceResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/devices/approve`,
    approveDeviceRequestSchema.parse(body),
  );
}

export function listDevices(
  cookieHeader: string,
  workspaceId: string,
): Promise<DeviceListResponse> {
  return serverGet(
    deviceListResponseSchema,
    cookieHeader,
    `/v1/workspaces/${workspaceId}/devices`,
  );
}

/** Rename a TV or change the dashboard it shows. */
export function updateDevice(
  workspaceId: string,
  deviceId: string,
  body: UpdateDeviceRequest,
): Promise<DeviceResponse> {
  return browserSend(
    deviceResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}/devices/${deviceId}`,
    updateDeviceRequestSchema.parse(body),
  );
}

/** The TV loses access at once; revoking cannot be undone. */
export function revokeDevice(
  workspaceId: string,
  deviceId: string,
): Promise<DeviceResponse> {
  return browserSend(
    deviceResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/devices/${deviceId}/revoke`,
  );
}
