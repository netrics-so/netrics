import { ZodError, type ZodType } from "zod";

import {
  createWorkspaceResponseSchema,
  type CreateWorkspaceResponse,
  createDashboardRequestSchema,
  dashboardListResponseSchema,
  dashboardResponseSchema,
  duplicateDashboardRequestSchema,
  metricQueryRequestSchema,
  metricQueryResponseSchema,
  replaceDashboardRequestSchema,
  workspaceMetricListResponseSchema,
  type CreateDashboardRequest,
  type DashboardListResponse,
  type DashboardResponse,
  type MetricQueryRequest,
  type MetricQueryResponse,
  type ReplaceDashboardRequest,
  type WorkspaceMetricListResponse,
  acceptInvitationResponseSchema,
  connectionDetailResponseSchema,
  connectionListResponseSchema,
  connectionPreviewResponseSchema,
  connectionResponseSchema,
  connectorListResponseSchema,
  createConnectionRequestSchema,
  createInvitationRequestSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
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
  setupStatusResponseSchema,
  timeZoneSchema,
  updateConnectionRequestSchema,
  updateMemberRoleRequestSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  type ConnectionDetailResponse,
  type ConnectionListResponse,
  type ConnectionPreviewResponse,
  type ConnectionResponse,
  type ConnectorListResponse,
  type CreateConnectionRequest,
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
  type UpdateConnectionRequest,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type WorkspaceRole,
} from "@netrics/contracts";

import { apiBaseUrl } from "./api-proxy";

/**
 * API failures carry a machine-readable code in the response body
 * ({"error":"last_owner"} etc.); ApiError preserves both so the UI can show
 * a plain message instead of failing silently.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "last_owner":
        return "The last owner of a workspace cannot be demoted or removed.";
      case "membership_exists":
        return "That person is already a member of this workspace.";
      case "email_delivery_failed":
        return "The invitation email could not be sent. Try again later.";
      case "invitation_not_found":
        return "This invitation link is not valid.";
      case "invitation_revoked":
        return "This invitation was withdrawn. Ask for a new one.";
      case "invitation_used":
        return "This invitation has already been used.";
      case "invitation_expired":
        return "This invitation has expired. Ask for a new one.";
      case "invitation_email_mismatch":
        return "This invitation is for a different email address.";
      case "workspace_already_exists":
        return "A workspace already exists for this installation.";
      case "forbidden":
        return "Your role does not allow this action.";
      case "unauthorized":
        return "Your session has expired — sign in again.";
      case "workspace_not_found":
      case "member_not_found":
      case "project_not_found":
      case "connection_not_found":
        return "That record no longer exists.";
      case "invalid_request":
        return "The request was invalid — check your input.";
      case "version_conflict":
        return "Someone else saved this dashboard in the meantime. Reload to see their changes, then edit again.";
      case "dashboard_not_found":
        return "This dashboard no longer exists.";
      case "tile_metric_not_found":
      case "metric_not_found":
        return "A tile's metric is no longer available from its connection.";
      case "aggregation_not_supported":
        return "That aggregation does not fit the metric.";
      case "unknown_dimension":
        return "A tile filters on a dimension the metric does not have.";
      default:
        // Connector check/preview failures arrive as human-readable,
        // already-redacted messages rather than snake_case codes.
        return /^[a-z_]+$/.test(error.code)
          ? `Request failed (${error.code}).`
          : error.code;
    }
  }
  if (error instanceof ZodError) {
    return "Check your input — a field is missing or invalid.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    return errorResponseSchema.parse(await response.json()).error;
  } catch {
    // Non-JSON or unexpected body: keep the generic code.
    return "request_failed";
  }
}

async function parseResponse<T>(
  schema: ZodType<T>,
  response: Response,
): Promise<T> {
  if (!response.ok) {
    throw new ApiError(response.status, await readErrorCode(response));
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
  return fetch(`${apiBaseUrl()}${path}`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  }).then((response) => parseResponse(schema, response));
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
  const response = await fetch(
    `${apiBaseUrl()}/v1/invitations/${encodeURIComponent(token)}`,
    { cache: "no-store" },
  );
  if (response.status === 404) {
    return null;
  }
  return parseResponse(invitationPreviewResponseSchema, response);
}

/** Public: whether first-run setup is pending and whether sign-up is open. */
export async function getSetupStatus(): Promise<SetupStatusResponse> {
  const response = await fetch(`${apiBaseUrl()}/v1/setup-status`, {
    cache: "no-store",
  });
  return parseResponse(setupStatusResponseSchema, response);
}

/** Returns null on 401 so pages can redirect to /login themselves. */
export async function getMe(cookieHeader: string): Promise<MeResponse | null> {
  const response = await fetch(`${apiBaseUrl()}/v1/me`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
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
  const response = await fetch(`${apiBaseUrl()}/v1/workspaces/${workspaceId}`, {
    headers: { cookie: cookieHeader },
    cache: "no-store",
  });
  if (response.status === 404) {
    return null;
  }
  return parseResponse(workspaceResponseSchema, response);
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
  const response = await fetch(
    `${apiBaseUrl()}/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    { headers: { cookie: cookieHeader }, cache: "no-store" },
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
      fetch(`${apiBaseUrl()}/health/live`, { cache: "no-store" }),
      fetch(`${apiBaseUrl()}/health/ready`, { cache: "no-store" }),
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
// the Next rewrites; the session cookie is attached automatically.
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

export async function deleteConnection(
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  const response = await fetch(
    `/v1/workspaces/${workspaceId}/connections/${connectionId}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 204) {
    throw new ApiError(response.status, await readErrorCode(response));
  }
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
  const response = await fetch(
    `${apiBaseUrl()}/v1/workspaces/${workspaceId}/dashboards/${dashboardId}`,
    { headers: { cookie: cookieHeader }, cache: "no-store" },
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
