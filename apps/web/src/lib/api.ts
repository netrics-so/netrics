import { dataErrorCodeKey } from "./data-errors";
import { projectQueryString } from "./project-scope";
import { ZodError, type ZodType, type z } from "zod";

import {
  customApiDefinitionConnectionsResponseSchema,
  customApiDefinitionListResponseSchema,
  customApiDefinitionResponseSchema,
  customApiUpdatePlanResponseSchema,
  customApiVersionHistorySchema,
  customApiVersionResponseSchema,
  type CustomApiDefinitionConnectionsResponse,
  type CustomApiDefinitionListResponse,
  type CustomApiDefinitionResponse,
  type CustomApiUpdatePlan,
  type CustomApiVersionHistory,
  type CustomApiVersionResponse,
  IMAGE_NAME_HEADER,
  storeTemplateApplyRequestSchema,
  storeTemplateCopyRequestSchema,
  storeTemplateDashboardErrorSchema,
  storeTemplateInstallListSchema,
  storeTemplateOptionsSchema,
  storeTemplatePlanSchema,
  storeTemplateProductsRequestSchema,
  storeTemplateProductsSchema,
  storeTemplateRequestSchema,
  storeTemplateResultSchema,
  storeTemplateScopeRequestSchema,
  storeTemplateScopeSchema,
  storeTemplateUpdateSchema,
  type StoreTemplateProducts,
  type StoreTemplateProductsRequest,
  type StoreTemplateScope,
  type StoreTemplateScopeRequest,
  type StoreTemplateApplyRequest,
  type StoreTemplateInstallList,
  type StoreTemplatePlan,
  type StoreTemplateUpdate,
  type StoreTemplateRequest,
  type StoreTemplateOptions,
  type StoreTemplateResult,
  developerTemplateOptionsSchema,
  developerTemplateRequestSchema,
  developerTemplateResultSchema,
  type DeveloperTemplateOptions,
  type DeveloperTemplateRequest,
  type DeveloperTemplateResult,
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
  lookupPairingRequestSchema,
  lookupPairingResponseSchema,
  dashboardResponseSchema,
  deviceListResponseSchema,
  deviceResponseSchema,
  duplicateDashboardRequestSchema,
  metricCurrenciesRequestSchema,
  metricCurrenciesResponseSchema,
  metricResourcesRequestSchema,
  metricResourcesResponseSchema,
  latestReviewRequestSchema,
  latestReviewResponseSchema,
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
  type LookupPairingResponse,
  type DashboardResponse,
  type DeviceListResponse,
  type DeviceResponse,
  type CurrencyConversionOptionsResponse,
  currencyConversionOptionsResponseSchema,
  type MetricCurrenciesRequest,
  type MetricCurrenciesResponse,
  type MetricResourcesRequest,
  type MetricResourcesResponse,
  type LatestReviewRequest,
  type LatestReviewResponse,
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
  storedConnectionPreviewRequestSchema,
  storedConnectionPreviewResponseSchema,
  type StoredConnectionPreviewRequest,
  type StoredConnectionPreviewResponse,
  connectionResourcesResponseSchema,
  connectionResponseSchema,
  connectionRetentionResponseSchema,
  type ConnectionRetentionResponse,
  updateConnectionRetentionRequestSchema,
  type UpdateConnectionRetentionRequest,
  connectorListResponseSchema,
  connectionsResponseSchema,
  createConnectionRequestSchema,
  createConnectionsRequestSchema,
  createSharedKeyConnectionsRequestSchema,
  createInvitationRequestSchema,
  createProjectRequestSchema,
  renameProjectRequestSchema,
  activeProjectResponseSchema,
  setActiveProjectRequestSchema,
  type ActiveProjectResponse,
  type ProjectFilterQuery,
  createWorkspaceRequestSchema,
  deleteConnectionResponseSchema,
  enqueueSyncResponseSchema,
  historyReloadResponseSchema,
  connectionErrorResponseSchema,
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
  sharedKeyResourcesResponseSchema,
  signedKeyPairResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  renameWorkspaceRequestSchema,
  deleteWorkspaceRequestSchema,
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
  type CreateSharedKeyConnectionsRequest,
  type SharedKeyResourcesResponse,
  type ConnectionResourcesResponse,
  type ConnectionResponse,
  type ConnectorListResponse,
  type ConnectionsResponse,
  type CreateConnectionRequest,
  type CreateConnectionsRequest,
  type DeleteConnectionResponse,
  type EnqueueSyncResponse,
  type HistoryReloadResponse,
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
  type SignedKeyPairResponse,
  type ProjectListResponse,
  type ProjectResponse,
  type SetupStatusResponse,
  type StartOAuthAuthorizationRequest,
  type StartOAuthAuthorizationResponse,
  type UpdateConnectionRequest,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type WorkspaceRole,
  createGoalRequestSchema,
  deleteGoalResponseSchema,
  goalListResponseSchema,
  goalReadResponseSchema,
  goalResponseSchema,
  updateGoalRequestSchema,
  type CreateGoalRequest,
  type DeleteGoalResponse,
  type GoalListResponse,
  type GoalReadResponse,
  type GoalResponse,
  type UpdateGoalRequest,
  createThemeRequestSchema,
  themeErrorResponseSchema,
  dataErrorResponseSchema,
  dataUsersSchema,
  themeListResponseSchema,
  themeResponseSchema,
  updateThemeRequestSchema,
  type CreateThemeRequest,
  type ThemeErrorResponse,
  type DataErrorResponse,
  type DataUsers,
  type ThemeListResponse,
  type ThemeResponse,
  type UpdateThemeRequest,
} from "@netrics/contracts";
import {
  localizedProviderFailure,
  type Locale,
  type MessageKey,
} from "@netrics/domain";

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
    /**
     * Extra fields some errors carry (theme contrast, dashboards in use, the
     * failing preparation step and column).
     */
    public readonly details: Omit<
      ThemeErrorResponse & DataErrorResponse & StoreTemplateErrorDetails,
      "error"
    > & {
      usedBy?: DataUsers;
      /** The reason code of a refused credential check (#795). */
      errorCode?: string;
    } = {},
  ) {
    super(code);
    this.name = "ApiError";
  }
}

/**
 * What store-template update errors carry (11E): the record and items that
 * cannot be merged, the fresh plan records of a changed dashboard, and the
 * screens whose fixed scope a swap cannot keep.
 */
type StoreTemplateErrorDetails = Omit<
  z.infer<typeof storeTemplateDashboardErrorSchema>,
  "error"
>;

/** API error codes that share one message. */
const API_ERROR_ALIASES: Readonly<Record<string, ApiErrorKey>> = {
  workspace_not_found: "record_not_found",
  member_not_found: "record_not_found",
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
    if (
      /^(dashboard_(?:filter|measure|interaction)|data_|model_)/.test(
        error.code,
      )
    )
      return webTranslator(locale, "data.errors")(dataErrorCodeKey(error.code));
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
    // already-redacted messages rather than snake_case codes. A refusal
    // with a reason code is shown in the viewer's language (#795).
    return providerFailureMessage(
      { code: error.details.errorCode, message: error.code },
      locale,
    );
  }
  if (error instanceof ZodError) {
    return t("invalidInput");
  }
  return error instanceof Error ? error.message : t("generic");
}

/**
 * A provider's failure for the user (#795): the text of its reason code in
 * their language; without a known code the recorded English message (found
 * in the catalog by its exact text if it was recorded before codes, #378).
 */
export function providerFailureMessage(
  failure: { code?: string | null | undefined; message: string },
  locale: Locale,
): string;
export function providerFailureMessage(
  failure: { code?: string | null | undefined; message?: string | null },
  locale: Locale,
): string | null;
export function providerFailureMessage(
  failure: { code?: string | null | undefined; message?: string | null },
  locale: Locale,
): string | null {
  return localizedProviderFailure(failure, locale) ?? failure.message ?? null;
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    return errorResponseSchema.parse(await response.json()).error;
  } catch {
    // Non-JSON or unexpected body: keep the generic code.
    return "request_failed";
  }
}

const detailedErrorResponseSchema = themeErrorResponseSchema
  .extend(dataErrorResponseSchema.shape)
  .extend(storeTemplateDashboardErrorSchema.shape)
  .extend({
    usedBy: dataUsersSchema.optional(),
    errorCode: connectionErrorResponseSchema.shape.errorCode,
  });

export async function readError(response: Response): Promise<ApiError> {
  try {
    const { error, ...details } = detailedErrorResponseSchema.parse(
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
// incoming request's headers forwarded to the API (forwardedHeaders in
// lib/api-fetch): the cookie, pure transport the web app never reads or
// trusts, and Accept-Language, so the API answers in the page's language.
// ---------------------------------------------------------------------------

function serverGet<T>(
  schema: ZodType<T>,
  forwarded: Headers,
  path: string,
): Promise<T> {
  return apiFetch(path, { headers: forwarded }).then((response) =>
    parseResponse(schema, response),
  );
}

export function listInvitations(
  forwarded: Headers,
  workspaceId: string,
): Promise<InvitationListResponse> {
  return serverGet(
    invitationListResponseSchema,
    forwarded,
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
export async function getMe(forwarded: Headers): Promise<MeResponse | null> {
  const response = await apiFetch("/v1/me", {
    headers: forwarded,
  });
  if (response.status === 401) {
    return null;
  }
  return parseResponse(meResponseSchema, response);
}

export function listWorkspaces(
  forwarded: Headers,
): Promise<WorkspaceListResponse> {
  return serverGet(workspaceListResponseSchema, forwarded, "/v1/workspaces");
}

/** Returns null on 404 (non-member or gone). */
export async function getWorkspace(
  forwarded: Headers,
  workspaceId: string,
): Promise<WorkspaceResponse | null> {
  const response = await apiFetch(`/v1/workspaces/${workspaceId}`, {
    headers: forwarded,
  });
  if (response.status === 404) {
    return null;
  }
  return parseResponse(workspaceResponseSchema, response);
}

/** Whether amounts can be converted, and into which currencies (#191). */
export function getCurrencyConversion(
  forwarded: Headers,
  workspaceId: string,
): Promise<CurrencyConversionOptionsResponse> {
  return serverGet(
    currencyConversionOptionsResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/currency-conversion`,
  );
}

export function listMembers(
  forwarded: Headers,
  workspaceId: string,
): Promise<MemberListResponse> {
  return serverGet(
    memberListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/members`,
  );
}

export function listProjects(
  forwarded: Headers,
  workspaceId: string,
): Promise<ProjectListResponse> {
  return serverGet(
    projectListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/projects`,
  );
}

export function listConnectors(
  forwarded: Headers,
): Promise<ConnectorListResponse> {
  return serverGet(connectorListResponseSchema, forwarded, "/v1/connectors");
}

/** All connections, or those of a project scope (#573). */
export function listConnections(
  forwarded: Headers,
  workspaceId: string,
  query?: ProjectFilterQuery,
): Promise<ConnectionListResponse> {
  return serverGet(
    connectionListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/connections${projectQueryString(query)}`,
  );
}

/** The workspace's custom API definitions (milestone 13), archived ones aside. */
export function listCustomApiDefinitions(
  forwarded: Headers,
  workspaceId: string,
): Promise<CustomApiDefinitionListResponse> {
  return serverGet(
    customApiDefinitionListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/custom-api/definitions`,
  );
}

/** One custom API definition with its current document; null on 404. */
export async function getCustomApiDefinition(
  forwarded: Headers,
  workspaceId: string,
  definitionId: string,
): Promise<CustomApiDefinitionResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/custom-api/definitions/${definitionId}`,
    { headers: forwarded },
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(customApiDefinitionResponseSchema, response);
}

/** One version of a definition; null on 404. */
export async function getCustomApiDefinitionVersion(
  forwarded: Headers,
  workspaceId: string,
  definitionId: string,
  version: number,
): Promise<CustomApiVersionResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/custom-api/definitions/${definitionId}/versions/${version}`,
    { headers: forwarded },
  );
  if (response.status === 404 || response.status === 409) {
    return null;
  }
  return parseResponse(customApiVersionResponseSchema, response);
}

/** The first page of a definition's versions (#808). */
export async function listCustomApiVersions(
  forwarded: Headers,
  workspaceId: string,
  definitionId: string,
): Promise<CustomApiVersionHistory> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/custom-api/definitions/${definitionId}/versions`,
    { headers: forwarded },
  );
  return parseResponse(customApiVersionHistorySchema, response);
}

/** The connections of a definition with their update state (#808). */
export async function listCustomApiDefinitionConnections(
  forwarded: Headers,
  workspaceId: string,
  definitionId: string,
): Promise<CustomApiDefinitionConnectionsResponse> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/custom-api/definitions/${definitionId}/connections`,
    { headers: forwarded },
  );
  return parseResponse(customApiDefinitionConnectionsResponseSchema, response);
}

/** A connection's offered definition update; null when there is none. */
export async function getCustomApiConnectionUpdate(
  forwarded: Headers,
  workspaceId: string,
  connectionId: string,
): Promise<CustomApiUpdatePlan | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/custom-api-update`,
    { headers: forwarded },
  );
  if (response.status === 404) {
    return null;
  }
  return (await parseResponse(customApiUpdatePlanResponseSchema, response))
    .plan;
}

/** Returns null on 404 (gone or from another workspace). */
export async function getConnection(
  forwarded: Headers,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionDetailResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    { headers: forwarded },
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(connectionDetailResponseSchema, response);
}

/** A connection's dataset retention (#492); null when it does not exist. */
export async function getConnectionRetention(
  forwarded: Headers,
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionRetentionResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/retention`,
    { headers: forwarded },
  );
  if (response.status === 404 || response.status === 403) {
    return null;
  }
  return parseResponse(connectionRetentionResponseSchema, response);
}

export function listObservations(
  forwarded: Headers,
  workspaceId: string,
  connectionId: string,
  query: { metricKey?: string; limit?: number; nonZero?: boolean } = {},
): Promise<ObservationListResponse> {
  const params = new URLSearchParams();
  if (query.nonZero) {
    params.set("nonZero", "true");
  }
  if (query.metricKey) {
    params.set("metricKey", query.metricKey);
  }
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return serverGet(
    observationListResponseSchema,
    forwarded,
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

export async function browserSend<T>(
  schema: ZodType<T>,
  method: string,
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(path, {
    ...(options?.signal ? { signal: options.signal } : {}),
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

/**
 * Deletes the workspace for good (#839, owners only). `name` is its name as
 * the user typed it to confirm; the server compares it again.
 */
export async function deleteWorkspace(
  workspaceId: string,
  name: string,
): Promise<void> {
  const response = await fetch(`/v1/workspaces/${workspaceId}/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deleteWorkspaceRequestSchema.parse({ name })),
  });
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorCode(response));
  }
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

/** Renames a project (#640); its items keep it. */
export function renameProject(
  workspaceId: string,
  projectId: string,
  name: string,
): Promise<ProjectResponse> {
  return browserSend(
    projectResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}/projects/${projectId}`,
    renameProjectRequestSchema.parse({ name }),
  );
}

/** The user's active project in the workspace; null is "All projects". */
export function setActiveProject(
  workspaceId: string,
  projectId: string | null,
): Promise<ActiveProjectResponse> {
  return browserSend(
    activeProjectResponseSchema,
    "PATCH",
    `/v1/workspaces/${workspaceId}/active-project`,
    setActiveProjectRequestSchema.parse({ projectId }),
  );
}

/** Hides a project and its items from lists and pickers (#572). */
export function archiveProject(
  workspaceId: string,
  projectId: string,
): Promise<ProjectResponse> {
  return browserSend(
    projectResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/projects/${projectId}/archive`,
  );
}

export function unarchiveProject(
  workspaceId: string,
  projectId: string,
): Promise<ProjectResponse> {
  return browserSend(
    projectResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/projects/${projectId}/unarchive`,
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

export function previewStoredConnection(
  workspaceId: string,
  connectionId: string,
  input: StoredConnectionPreviewRequest,
): Promise<StoredConnectionPreviewResponse> {
  return browserSend(
    storedConnectionPreviewResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/preview`,
    storedConnectionPreviewRequestSchema.parse(input),
  );
}

/**
 * Generates a key pair for a signed-key provider with `generatedKeyPair`
 * (ADR 0020 §3): the answer has the public key to paste at the provider and
 * the pending key's id; the private key stays on the server.
 */
export function generateKeyPair(
  workspaceId: string,
  provider: string,
): Promise<SignedKeyPairResponse> {
  return browserSend(
    signedKeyPairResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/signed-keys/${encodeURIComponent(provider)}/key-pairs`,
    {},
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

/**
 * Several connections with one credential, all or none (#375): one Apple
 * Ads key for several ad accounts.
 */
export function createConnections(
  workspaceId: string,
  input: CreateConnectionsRequest,
): Promise<ConnectionsResponse> {
  return browserSend(
    connectionsResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/batch`,
    createConnectionsRequestSchema.parse(input),
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

/** Saves a connection's dataset retention (#492); applies at once. */
export function updateConnectionRetention(
  workspaceId: string,
  connectionId: string,
  input: UpdateConnectionRetentionRequest,
): Promise<ConnectionRetentionResponse> {
  return browserSend(
    connectionRetentionResponseSchema,
    "PUT",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/retention`,
    updateConnectionRetentionRequestSchema.parse(input),
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

/**
 * What the stored key of a connection reads (#395): e.g. the Apple Ads
 * API user's ad accounts, and which of them this workspace has connected.
 * The key stays on the server.
 */
export function listSharedKeyResources(
  workspaceId: string,
  connectionId: string,
): Promise<SharedKeyResourcesResponse> {
  return browserSend(
    sharedKeyResourcesResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/shared-key/resources`,
  );
}

/** New connections with the stored key of a connection (#395), all or none. */
export function createSharedKeyConnections(
  workspaceId: string,
  connectionId: string,
  input: CreateSharedKeyConnectionsRequest,
): Promise<ConnectionsResponse> {
  return browserSend(
    connectionsResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/shared-key/connections`,
    createSharedKeyConnectionsRequestSchema.parse(input),
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

/** "Reload history" (#617): queues a backfill of the whole window. */
export function requestHistoryReload(
  workspaceId: string,
  connectionId: string,
): Promise<HistoryReloadResponse> {
  return browserSend(
    historyReloadResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/backfill`,
  );
}

// ---------------------------------------------------------------------------
// Dashboards and metrics (#48, #49)
// ---------------------------------------------------------------------------

/** All dashboards, or those of a project scope (#573). */
export function listDashboards(
  forwarded: Headers,
  workspaceId: string,
  query?: ProjectFilterQuery & { archived?: "include" },
): Promise<DashboardListResponse> {
  return serverGet(
    dashboardListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/dashboards${projectQueryString(query)}`,
  );
}

/** Returns null on 404. */
export async function getDashboard(
  forwarded: Headers,
  workspaceId: string,
  dashboardId: string,
): Promise<DashboardResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
    { headers: forwarded },
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(dashboardResponseSchema, response);
}

export function listWorkspaceMetrics(
  forwarded: Headers,
  workspaceId: string,
): Promise<WorkspaceMetricListResponse> {
  return serverGet(
    workspaceMetricListResponseSchema,
    forwarded,
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
  forwarded: Headers,
  workspaceId: string,
): Promise<ThemeListResponse> {
  return serverGet(
    themeListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/themes`,
  );
}

/** Returns null on 404. */
export async function getTheme(
  forwarded: Headers,
  workspaceId: string,
  themeId: string,
): Promise<ThemeResponse | null> {
  const response = await apiFetch(
    `/v1/workspaces/${workspaceId}/themes/${themeId}`,
    { headers: forwarded },
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
// Goals (ADR 0019 section 4, #335)
// ---------------------------------------------------------------------------

/** The workspace's goals with their current progress. */
export function listGoals(
  forwarded: Headers,
  workspaceId: string,
): Promise<GoalListResponse> {
  return serverGet(
    goalListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/goals`,
  );
}

/**
 * One goal with its current progress, from the browser (a goal widget in
 * the Studio and signed-in views, ADR 0019 section 5), with its metric's
 * freshness and an overdue "stale" (#727); null when it was deleted.
 */
export async function fetchGoal(
  workspaceId: string,
  goalId: string,
): Promise<GoalReadResponse | null> {
  try {
    return await browserSend(
      goalReadResponseSchema,
      "GET",
      `/v1/workspaces/${workspaceId}/goals/${goalId}`,
    );
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null;
    throw cause;
  }
}

/** The workspace's goals with their progress, from the browser. */
export function fetchGoals(workspaceId: string): Promise<GoalListResponse> {
  return browserSend(
    goalListResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/goals`,
  );
}

export function createGoal(
  workspaceId: string,
  body: CreateGoalRequest,
): Promise<GoalResponse> {
  return browserSend(
    goalResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/goals`,
    createGoalRequestSchema.parse(body),
  );
}

/** Throws ApiError "version_conflict" (409) when someone saved first. */
export function updateGoal(
  workspaceId: string,
  goalId: string,
  body: UpdateGoalRequest,
): Promise<GoalResponse> {
  return browserSend(
    goalResponseSchema,
    "PUT",
    `/v1/workspaces/${workspaceId}/goals/${goalId}`,
    updateGoalRequestSchema.parse(body),
  );
}

/** Deletes a goal; answers the dashboards whose gauges used it. */
export function deleteGoal(
  workspaceId: string,
  goalId: string,
): Promise<DeleteGoalResponse> {
  return browserSend(
    deleteGoalResponseSchema,
    "DELETE",
    `/v1/workspaces/${workspaceId}/goals/${goalId}`,
  );
}

// ---------------------------------------------------------------------------
// Workspace images (ADR 0015, section 5; #217)
// ---------------------------------------------------------------------------

/** The workspace's images with their quota (metadata, never bytes). */
export function listImages(
  forwarded: Headers,
  workspaceId: string,
): Promise<ImageListResponse> {
  return serverGet(
    imageListResponseSchema,
    forwarded,
    `/v1/workspaces/${workspaceId}/images`,
  );
}

/** The workspace's images for logos, backgrounds and image widgets. */
export async function listStudioImages(
  forwarded: Headers,
  workspaceId: string,
): Promise<StudioImage[]> {
  const { images } = await listImages(forwarded, workspaceId);
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

/**
 * A latest-review widget's review (ADR 0019 section 12, browser): the
 * newest that matches and is not hidden, with its id for "Hide this
 * review". One review; there is no list.
 */
export function queryLatestReview(
  workspaceId: string,
  connectionId: string,
  body: LatestReviewRequest,
): Promise<LatestReviewResponse> {
  return browserSend(
    latestReviewResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/reviews/latest`,
    latestReviewRequestSchema.parse(body),
  );
}

/**
 * A connection's freshness streams (ADR 0025), from the browser: the
 * `freshness` of its detail. Empty for connectors that declare none.
 */
export async function fetchConnectionFreshness(
  workspaceId: string,
  connectionId: string,
): Promise<ConnectionDetailResponse["freshness"]> {
  const detail = await browserSend(
    connectionDetailResponseSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
  );
  return detail.freshness;
}

/** "Hide this review": no widget shows it again (dashboards:update). */
export async function hideReview(
  workspaceId: string,
  connectionId: string,
  reviewId: string,
): Promise<void> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}/reviews/${encodeURIComponent(reviewId)}/hide`,
    { method: "POST" },
  );
  if (!response.ok && response.status !== 204) {
    throw await readError(response);
  }
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

/**
 * The platform a pending code's device reported (#406), to suggest a name.
 * Throws ApiError "pairing_not_found" (counted as a failed approval) or
 * "too_many_attempts".
 */
export function lookupPairing(code: string): Promise<LookupPairingResponse> {
  return browserSend(
    lookupPairingResponseSchema,
    "POST",
    "/v1/device-pairings/lookup",
    lookupPairingRequestSchema.parse({ code }),
  );
}

export function listDevices(
  forwarded: Headers,
  workspaceId: string,
): Promise<DeviceListResponse> {
  return serverGet(
    deviceListResponseSchema,
    forwarded,
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

export function listStoreTemplateOptions(
  workspaceId: string,
): Promise<StoreTemplateOptions> {
  return browserSend(
    storeTemplateOptionsSchema,
    "GET",
    `/v1/workspaces/${workspaceId}/dashboard-templates/stores`,
  );
}
export function installStoreTemplate(
  workspaceId: string,
  input: StoreTemplateRequest,
): Promise<StoreTemplateResult> {
  return browserSend(
    storeTemplateResultSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/dashboard-templates/stores`,
    storeTemplateRequestSchema.parse(input),
  );
}

// ─── Store-template updates (11E) ─────────────────────────────────────────

/**
 * The templates that are installed, updated and swapped alike (11E): the
 * App Portfolio (`stores`) and the Developer Portfolio (`developer`, #876).
 * Their update routes are the same under each template's path.
 */
export type TemplateKind = "stores" | "developer";
const storesPath = (workspaceId: string, template: TemplateKind = "stores") =>
  `/v1/workspaces/${workspaceId}/dashboard-templates/${template}`;

/** The workspace's store-template installs and their updates (server). */
export function listStoreTemplateInstalls(
  forwarded: Headers,
  workspaceId: string,
  template: TemplateKind = "stores",
): Promise<StoreTemplateInstallList> {
  return serverGet(
    storeTemplateInstallListSchema,
    forwarded,
    `${storesPath(workspaceId, template)}/installs`,
  );
}
/**
 * The installs of both templates (server), each Developer Portfolio
 * install marked with its template, so update links lead to its review.
 * A list that cannot be read is left out: pages work without updates.
 */
export async function listTemplateInstalls(
  forwarded: Headers,
  workspaceId: string,
): Promise<
  (StoreTemplateInstallList["installs"][number] & {
    template?: "developer";
  })[]
> {
  const [stores, developer] = await Promise.all(
    (["stores", "developer"] as const).map((template) =>
      listStoreTemplateInstalls(forwarded, workspaceId, template).then(
        ({ installs }) => installs,
        () => [],
      ),
    ),
  );
  return [
    ...stores!,
    ...developer!.map((install) => ({
      ...install,
      template: "developer" as const,
    })),
  ];
}
/** The same list in the browser, to reload it after a change. */
export function readStoreTemplateInstalls(
  workspaceId: string,
  template: TemplateKind = "stores",
): Promise<StoreTemplateInstallList> {
  return browserSend(
    storeTemplateInstallListSchema,
    "GET",
    `${storesPath(workspaceId, template)}/installs`,
  );
}
/** The three-way plan of an install's update, item by item. */
export function getStoreTemplatePlan(
  workspaceId: string,
  requestId: string,
  template: TemplateKind = "stores",
): Promise<StoreTemplatePlan> {
  return browserSend(
    storeTemplatePlanSchema,
    "GET",
    `${storesPath(workspaceId, template)}/installs/${requestId}/update`,
  );
}
/**
 * Applies a reviewed plan as data drafts; 409 store_update_stale when the
 * plan changed since it was loaded.
 */
export function applyStoreTemplateUpdate(
  workspaceId: string,
  requestId: string,
  body: StoreTemplateApplyRequest,
  template: TemplateKind = "stores",
): Promise<StoreTemplateUpdate> {
  return browserSend(
    storeTemplateUpdateSchema,
    "POST",
    `${storesPath(workspaceId, template)}/installs/${requestId}/update`,
    storeTemplateApplyRequestSchema.parse(body),
  );
}
/** What a Developer Portfolio can read (server). */
export function readDeveloperTemplateOptions(
  forwarded: Headers,
  workspaceId: string,
): Promise<DeveloperTemplateOptions> {
  return serverGet(
    developerTemplateOptionsSchema,
    forwarded,
    storesPath(workspaceId, "developer"),
  );
}
/** Installs the Developer Portfolio (#876). */
export function installDeveloperTemplate(
  workspaceId: string,
  input: DeveloperTemplateRequest,
): Promise<DeveloperTemplateResult> {
  return browserSend(
    developerTemplateResultSchema,
    "POST",
    storesPath(workspaceId, "developer"),
    developerTemplateRequestSchema.parse(input),
  );
}
/** The store connections and their apps a template can use (server). */
export function readStoreTemplateOptions(
  forwarded: Headers,
  workspaceId: string,
): Promise<StoreTemplateOptions> {
  return serverGet(
    storeTemplateOptionsSchema,
    forwarded,
    storesPath(workspaceId),
  );
}
/** The connections and app scope an install is built from (server). */
export function readStoreTemplateScope(
  forwarded: Headers,
  workspaceId: string,
  requestId: string,
): Promise<StoreTemplateScope> {
  return serverGet(
    storeTemplateScopeSchema,
    forwarded,
    `${storesPath(workspaceId)}/installs/${requestId}/scope`,
  );
}
/** An install's products: icon, paid or free and website (server). */
export function readStoreTemplateProducts(
  forwarded: Headers,
  workspaceId: string,
  requestId: string,
): Promise<StoreTemplateProducts> {
  return serverGet(
    storeTemplateProductsSchema,
    forwarded,
    `${storesPath(workspaceId)}/installs/${requestId}/products`,
  );
}
/** An install's products, from the browser. */
export function getStoreTemplateProducts(
  workspaceId: string,
  requestId: string,
): Promise<StoreTemplateProducts> {
  return browserSend(
    storeTemplateProductsSchema,
    "GET",
    `${storesPath(workspaceId)}/installs/${requestId}/products`,
  );
}
/**
 * Fetches the icons the install's apps lack (#740), the same validated
 * fetch as an install; answers the products afterwards.
 */
export function retryStoreTemplateIcons(
  workspaceId: string,
  requestId: string,
): Promise<StoreTemplateProducts> {
  return browserSend(
    storeTemplateProductsSchema,
    "POST",
    `${storesPath(workspaceId)}/installs/${requestId}/products/icons`,
  );
}
/**
 * Sets paid or free and the website of the listed products; 400
 * store_website_invalid or store_product_unknown.
 */
export function saveStoreTemplateProducts(
  workspaceId: string,
  requestId: string,
  body: StoreTemplateProductsRequest,
): Promise<StoreTemplateProducts> {
  return browserSend(
    storeTemplateProductsSchema,
    "PUT",
    `${storesPath(workspaceId)}/installs/${requestId}/products`,
    storeTemplateProductsRequestSchema.parse(body),
  );
}
/** The plan of changing an install's connections or app scope. */
export function getStoreTemplateScopePlan(
  workspaceId: string,
  requestId: string,
  scope: Pick<StoreTemplateScopeRequest, "connections" | "appScope">,
): Promise<StoreTemplatePlan> {
  const query = new URLSearchParams({
    connections: scope.connections.join(","),
  });
  if (scope.appScope)
    query.set(
      "appScope",
      `${scope.appScope.connectionId}:${scope.appScope.appId}`,
    );
  return browserSend(
    storeTemplatePlanSchema,
    "GET",
    `${storesPath(workspaceId)}/installs/${requestId}/scope-plan?${query.toString()}`,
  );
}
/**
 * Changes an install's connections or app scope as data drafts and an
 * updated dashboard copy; 409 store_update_stale when the plan changed.
 */
export function changeStoreTemplateScope(
  workspaceId: string,
  requestId: string,
  body: StoreTemplateScopeRequest,
): Promise<StoreTemplateUpdate> {
  return browserSend(
    storeTemplateUpdateSchema,
    "PUT",
    `${storesPath(workspaceId)}/installs/${requestId}/scope`,
    storeTemplateScopeRequestSchema.parse(body),
  );
}
/** Closes an applied update; its drafts stay as ordinary drafts. */
export async function closeStoreTemplateUpdate(
  workspaceId: string,
  requestId: string,
  updateId: string,
  template: TemplateKind = "stores",
): Promise<void> {
  const path = `${storesPath(workspaceId, template)}/installs/${requestId}/updates/${updateId}/close`;
  const response = await fetch(path, { method: "POST" });
  if (!response.ok) throw await readError(response);
}
const updateDashboardPath = (
  workspaceId: string,
  updateId: string,
  key: string,
  action: "copy" | "swap" | "swap-back",
  template: TemplateKind,
) =>
  `${storesPath(workspaceId, template)}/updates/${updateId}/dashboards/${encodeURIComponent(key)}/${action}`;
/** Creates the updated dashboard copy, unassigned from screens. */
export function createStoreTemplateCopy(
  workspaceId: string,
  updateId: string,
  key: string,
  options: { replace?: boolean; discardCopyEdits?: boolean } = {},
  template: TemplateKind = "stores",
): Promise<StoreTemplateUpdate> {
  return browserSend(
    storeTemplateUpdateSchema,
    "POST",
    updateDashboardPath(workspaceId, updateId, key, "copy", template),
    storeTemplateCopyRequestSchema.parse(options),
  );
}
/** Puts the copy on every screen of the original; archives the original. */
export function swapStoreTemplateDashboard(
  workspaceId: string,
  updateId: string,
  key: string,
  template: TemplateKind = "stores",
): Promise<StoreTemplateUpdate> {
  return browserSend(
    storeTemplateUpdateSchema,
    "POST",
    updateDashboardPath(workspaceId, updateId, key, "swap", template),
  );
}
/** Puts the archived original back on the copy's screens. */
export function swapBackStoreTemplateDashboard(
  workspaceId: string,
  updateId: string,
  key: string,
  template: TemplateKind = "stores",
): Promise<StoreTemplateUpdate> {
  return browserSend(
    storeTemplateUpdateSchema,
    "POST",
    updateDashboardPath(workspaceId, updateId, key, "swap-back", template),
  );
}
