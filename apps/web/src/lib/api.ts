import { ZodError, type ZodType } from "zod";

import {
  addMemberRequestSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
  errorResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  meResponseSchema,
  memberListResponseSchema,
  memberResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  renameWorkspaceRequestSchema,
  updateMemberRoleRequestSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  type HealthLiveResponse,
  type HealthReadyResponse,
  type MemberListResponse,
  type MemberResponse,
  type MeResponse,
  type ProjectListResponse,
  type ProjectResponse,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type WorkspaceRole,
} from "@netrics/contracts";

function apiBaseUrl(): string {
  return process.env.NETRICS_API_URL ?? "http://localhost:3001";
}

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
      case "user_not_found":
        return "No account exists with that email address.";
      case "membership_exists":
        return "That user is already a member of this workspace.";
      case "workspace_already_exists":
        return "A workspace already exists for this installation.";
      case "forbidden":
        return "Your role does not allow this action.";
      case "unauthorized":
        return "Your session has expired — sign in again.";
      case "workspace_not_found":
      case "member_not_found":
      case "project_not_found":
        return "That record no longer exists.";
      case "invalid_request":
        return "The request was invalid — check your input.";
      default:
        return `Request failed (${error.code}).`;
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

export function createWorkspace(name: string): Promise<WorkspaceResponse> {
  return browserSend(
    workspaceResponseSchema,
    "POST",
    "/v1/workspaces",
    createWorkspaceRequestSchema.parse({ name }),
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

export function addMember(
  workspaceId: string,
  email: string,
  role: WorkspaceRole,
): Promise<MemberResponse> {
  return browserSend(
    memberResponseSchema,
    "POST",
    `/v1/workspaces/${workspaceId}/members`,
    addMemberRequestSchema.parse({ email, role }),
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
