// Browser client of the custom API builder (milestone 13, #807): drafts,
// test requests, definitions and connections from a definition. Same-origin
// paths through the web app's API proxy, like browserSend.

import type { ZodType } from "zod";

import {
  connectionResponseSchema,
  createCustomApiConnectionRequestSchema,
  customApiDefinitionResponseSchema,
  customApiDraftResponseSchema,
  customApiErrorResponseSchema,
  customApiOAuthInfoResponseSchema,
  customApiTestRequestSchema,
  customApiTestResponseSchema,
  promoteCustomApiDraftRequestSchema,
  promoteCustomApiDraftResponseSchema,
  startOAuthAuthorizationResponseSchema,
  updateCustomApiDraftRequestSchema,
  type ConnectionResponse,
  type CreateCustomApiConnectionRequest,
  type CustomApiDefinition,
  type CustomApiDefinitionResponse,
  type CustomApiDraft,
  type CustomApiTestRequest,
  type CustomApiTestResponse,
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
