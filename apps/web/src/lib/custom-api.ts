// Browser client of the custom API builder (milestone 13, #807): drafts,
// test requests, definitions and connections from a definition. Same-origin
// paths through the web app's API proxy, like browserSend.

import type { ZodType } from "zod";

import {
  connectionResponseSchema,
  createCustomApiConnectionRequestSchema,
  customApiDefinitionConnectionsResponseSchema,
  customApiDefinitionResponseSchema,
  customApiDraftResponseSchema,
  customApiErrorResponseSchema,
  customApiExportSchema,
  customApiOAuthInfoResponseSchema,
  customApiTestRequestSchema,
  customApiTestResponseSchema,
  customApiUpdateApplyRequestSchema,
  customApiUpdateErrorResponseSchema,
  customApiUpdatePlanResponseSchema,
  customApiVersionHistorySchema,
  customApiVersionResponseSchema,
  promoteCustomApiDraftRequestSchema,
  promoteCustomApiDraftResponseSchema,
  startOAuthAuthorizationResponseSchema,
  updateCustomApiDraftRequestSchema,
  type ConnectionResponse,
  type CreateCustomApiConnectionRequest,
  type CustomApiDefinition,
  type CustomApiDefinitionConnectionsResponse,
  type CustomApiDefinitionResponse,
  type CustomApiDraft,
  type CustomApiTestRequest,
  type CustomApiTestResponse,
  type CustomApiUpdateApplyRequest,
  type CustomApiUpdateBlocker,
  type CustomApiUpdatePlan,
  type CustomApiVersionHistory,
  type CustomApiVersionResponse,
  type ImportCustomApiDefinitionRequest,
  type PromoteCustomApiDraftRequest,
  type StartOAuthAuthorizationResponse,
  type UpdateCustomApiDraftRequest,
} from "@netrics/contracts";

import { ApiError } from "./api";

/** A refused custom API request: the code, the definition's issues and, on 429, the wait. */
export class CustomApiRequestError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly issues: { path: string; code: string; message: string }[] = [],
    /** Seconds from Retry-After (429), else null. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(status, code);
    this.name = "CustomApiRequestError";
  }
}

async function send<T>(
  schema: ZodType<T> | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let code = "request_failed";
    let issues: CustomApiRequestError["issues"] = [];
    try {
      const parsed = customApiErrorResponseSchema.parse(await response.json());
      code = parsed.error;
      issues = parsed.issues ?? [];
    } catch {
      // Not the error shape: keep the generic code.
    }
    const retry = Number(response.headers.get("retry-after"));
    throw new CustomApiRequestError(
      response.status,
      code,
      issues,
      response.status === 429 && Number.isFinite(retry) && retry > 0
        ? Math.ceil(retry)
        : null,
    );
  }
  if (schema === null) return undefined as T;
  return schema.parse(await response.json());
}

const base = (workspaceId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/custom-api`;

export async function createDraft(
  workspaceId: string,
  definitionId?: string,
): Promise<CustomApiDraft> {
  const { draft } = await send(
    customApiDraftResponseSchema,
    "POST",
    `${base(workspaceId)}/drafts`,
    definitionId ? { definitionId } : {},
  );
  return draft;
}

export async function updateDraft(
  workspaceId: string,
  draftId: string,
  body: UpdateCustomApiDraftRequest,
): Promise<CustomApiDraft> {
  const { draft } = await send(
    customApiDraftResponseSchema,
    "PUT",
    `${base(workspaceId)}/drafts/${encodeURIComponent(draftId)}`,
    updateCustomApiDraftRequestSchema.parse(body),
  );
  return draft;
}

export function deleteDraft(
  workspaceId: string,
  draftId: string,
): Promise<void> {
  return send(
    null,
    "DELETE",
    `${base(workspaceId)}/drafts/${encodeURIComponent(draftId)}`,
  );
}

export function testDraft(
  workspaceId: string,
  draftId: string,
  body: CustomApiTestRequest,
): Promise<CustomApiTestResponse> {
  return send(
    customApiTestResponseSchema,
    "POST",
    `${base(workspaceId)}/drafts/${encodeURIComponent(draftId)}/test`,
    customApiTestRequestSchema.parse(body),
  );
}

export function promoteDraft(
  workspaceId: string,
  draftId: string,
  body: PromoteCustomApiDraftRequest,
): Promise<{ connectionId: string }> {
  return send(
    promoteCustomApiDraftResponseSchema,
    "POST",
    `${base(workspaceId)}/drafts/${encodeURIComponent(draftId)}/promote`,
    promoteCustomApiDraftRequestSchema.parse(body),
  );
}

export function createDefinition(
  workspaceId: string,
  body: { document: CustomApiDefinition; projectId?: string },
): Promise<CustomApiDefinitionResponse> {
  return send(
    customApiDefinitionResponseSchema,
    "POST",
    `${base(workspaceId)}/definitions`,
    body,
  );
}

export function saveDefinitionVersion(
  workspaceId: string,
  definitionId: string,
  body: { document: CustomApiDefinition; baseVersion: number },
): Promise<CustomApiDefinitionResponse> {
  return send(
    customApiDefinitionResponseSchema,
    "POST",
    `${base(workspaceId)}/definitions/${encodeURIComponent(definitionId)}/versions`,
    body,
  );
}

export function connectDefinition(
  workspaceId: string,
  definitionId: string,
  body: CreateCustomApiConnectionRequest,
): Promise<ConnectionResponse> {
  return send(
    connectionResponseSchema,
    "POST",
    `${base(workspaceId)}/definitions/${encodeURIComponent(definitionId)}/connections`,
    createCustomApiConnectionRequestSchema.parse(body),
  );
}

// C-G4 (#805): the redirect URL a provider needs, and the sign-in of a
// draft or a pending connection through the existing OAuth start route.

export function getCustomOAuthInfo(
  workspaceId: string,
): Promise<{ redirectUri: string }> {
  return send(
    customApiOAuthInfoResponseSchema,
    "GET",
    `${base(workspaceId)}/oauth`,
  );
}

export function startCustomOAuth(
  workspaceId: string,
  connectionId: string,
): Promise<StartOAuthAuthorizationResponse> {
  return send(
    startOAuthAuthorizationResponseSchema,
    "POST",
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/oauth/authorizations`,
    { connectorId: "custom-api", connectionId },
  );
}

// #808: version history, restore, export and import, connection updates.

const definitionPath = (workspaceId: string, definitionId: string) =>
  `${base(workspaceId)}/definitions/${encodeURIComponent(definitionId)}`;

export function listVersions(
  workspaceId: string,
  definitionId: string,
  before?: number,
): Promise<CustomApiVersionHistory> {
  return send(
    customApiVersionHistorySchema,
    "GET",
    `${definitionPath(workspaceId, definitionId)}/versions${
      before === undefined ? "" : `?before=${before}`
    }`,
  );
}

export function getVersion(
  workspaceId: string,
  definitionId: string,
  version: number,
): Promise<CustomApiVersionResponse> {
  return send(
    customApiVersionResponseSchema,
    "GET",
    `${definitionPath(workspaceId, definitionId)}/versions/${version}`,
  );
}

export function restoreVersion(
  workspaceId: string,
  definitionId: string,
  version: number,
  baseVersion: number,
): Promise<CustomApiDefinitionResponse> {
  return send(
    customApiDefinitionResponseSchema,
    "POST",
    `${definitionPath(workspaceId, definitionId)}/versions/${version}/restore`,
    { baseVersion },
  );
}

/** The export file's text and name (from content-disposition). */
export async function fetchExport(
  workspaceId: string,
  definitionId: string,
  version?: number,
): Promise<{ text: string; filename: string }> {
  // Same-origin through the web app's proxy, like send().
  const path = `${definitionPath(workspaceId, definitionId)}/export${
    version === undefined ? "" : `?version=${version}`
  }`;
  const response = await fetch(path);
  if (!response.ok) {
    let code = "request_failed";
    try {
      code = customApiErrorResponseSchema.parse(await response.json()).error;
    } catch {
      // Not the error shape.
    }
    throw new CustomApiRequestError(response.status, code);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename =
    /filename="([^"]+)"/.exec(disposition)?.[1] ??
    "custom-api.netrics-api.json";
  // Validated, then written as received (pretty-printed).
  const file = customApiExportSchema.parse(await response.json());
  return { text: `${JSON.stringify(file, null, 2)}\n`, filename };
}

/** Downloads the export as a file through an object URL. */
export async function exportDefinition(
  workspaceId: string,
  definitionId: string,
  version?: number,
): Promise<void> {
  const { text, filename } = await fetchExport(
    workspaceId,
    definitionId,
    version,
  );
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function importDefinition(
  workspaceId: string,
  body: ImportCustomApiDefinitionRequest,
): Promise<CustomApiDefinitionResponse> {
  return send(
    customApiDefinitionResponseSchema,
    "POST",
    `${base(workspaceId)}/definitions/import`,
    body,
  );
}

export function listDefinitionConnections(
  workspaceId: string,
  definitionId: string,
): Promise<CustomApiDefinitionConnectionsResponse> {
  return send(
    customApiDefinitionConnectionsResponseSchema,
    "GET",
    `${definitionPath(workspaceId, definitionId)}/connections`,
  );
}

/** A refused update: the plan when stale, the blockers when blocked. */
export class CustomApiUpdateError extends CustomApiRequestError {
  constructor(
    status: number,
    code: string,
    readonly plan: CustomApiUpdatePlan | null,
    readonly blockers: CustomApiUpdateBlocker[],
  ) {
    super(status, code);
    this.name = "CustomApiUpdateError";
  }
}

const updatePath = (workspaceId: string, connectionId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/connections/${encodeURIComponent(connectionId)}/custom-api-update`;

async function sendUpdate<T>(
  schema: ZodType<T>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let parsed = null;
    try {
      parsed = customApiUpdateErrorResponseSchema.parse(await response.json());
    } catch {
      // Not the error shape.
    }
    throw new CustomApiUpdateError(
      response.status,
      parsed?.error ?? "request_failed",
      parsed?.plan ?? null,
      parsed?.blockers ?? [],
    );
  }
  return schema.parse(await response.json());
}

/** The offered update; null when the connection runs the current version. */
export async function getConnectionUpdate(
  workspaceId: string,
  connectionId: string,
  environmentId?: string,
): Promise<CustomApiUpdatePlan | null> {
  try {
    const { plan } = await sendUpdate(
      customApiUpdatePlanResponseSchema,
      "GET",
      `${updatePath(workspaceId, connectionId)}${
        environmentId
          ? `?environmentId=${encodeURIComponent(environmentId)}`
          : ""
      }`,
    );
    return plan;
  } catch (cause) {
    if (
      cause instanceof CustomApiUpdateError &&
      cause.code === "custom_api_update_none"
    )
      return null;
    throw cause;
  }
}

export function applyConnectionUpdate(
  workspaceId: string,
  connectionId: string,
  body: CustomApiUpdateApplyRequest,
): Promise<ConnectionResponse> {
  return sendUpdate(
    connectionResponseSchema,
    "POST",
    updatePath(workspaceId, connectionId),
    customApiUpdateApplyRequestSchema.parse(body),
  );
}

/**
 * The version a connection shows next to its connector (#834): a custom
 * API's definition version ("v2", as the custom APIs list and definition
 * page show it), not the generated connector version ("1.0.2").
 */
export function connectorVersionLabel(connection: {
  connectorVersion: string;
  customApi?: { version: number } | null;
}): string {
  return connection.customApi
    ? `v${connection.customApi.version}`
    : connection.connectorVersion;
}
