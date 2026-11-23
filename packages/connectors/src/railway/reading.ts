// Configuration, listings and reason codes shared by check, discover and
// sync.

import { ConnectorError, type ConnectionContext } from "@netrics/connector-sdk";

import { RailwayApiError, type RailwayQuery } from "./api.js";
import {
  ME_QUERY,
  PROJECTS_QUERY,
  WORKSPACE_QUERY,
  meSchema,
  projectsSchema,
  workspaceAnswerSchema,
} from "./queries.js";

export const PROJECTS_PER_REQUEST = 50;
/** Listing pages discover reads (1,000 projects); a sync pages without a cap. */
const MAX_PROJECT_REQUESTS = 20;

// ─── Reason codes of a failed check (#795) ─────────────────────────────────

export const TOKEN_REJECTED_CODE = "railway.token_rejected";
export const TOKEN_REJECTED_MESSAGE =
  "Railway did not accept the token: it is wrong, was deleted, or is a project token. Create an account or workspace token in Railway (Account Settings → Tokens). For a workspace token, also enter its workspace ID.";
export const WORKSPACE_DENIED_CODE = "railway.workspace_denied";
export const WORKSPACE_DENIED_MESSAGE =
  "Railway did not accept the token for this connection's workspace ID: the ID is wrong, the token belongs to another workspace, or it was deleted. Check the workspace ID, or create a new token for that workspace.";

// ─── Configuration ──────────────────────────────────────────────────────────

export function tokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.token;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

export function workspaceIdOf(context: ConnectionContext): string | undefined {
  const id = context.config.workspaceId;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
}

/** Auth failures in discover and sync carry the check's reason code. */
export function rethrow(error: unknown, context: ConnectionContext): never {
  if (
    error instanceof RailwayApiError &&
    (error.kind === "auth" ||
      (error.kind === "not_found" && workspaceIdOf(context)))
  ) {
    throw workspaceIdOf(context)
      ? new ConnectorError(WORKSPACE_DENIED_MESSAGE, WORKSPACE_DENIED_CODE)
      : new ConnectorError(TOKEN_REJECTED_MESSAGE, TOKEN_REJECTED_CODE);
  }
  throw error;
}

// ─── Listings ───────────────────────────────────────────────────────────────

export interface ProjectListing {
  id: string;
  name: string;
  workspaceId: string;
  services: Array<{ id: string; name: string }>;
  environments: Array<{ id: string; name: string }>;
}

export async function listWorkspaces(
  query: RailwayQuery,
  configured: string | undefined,
): Promise<Array<{ id: string; name: string }>> {
  if (configured) {
    const answer = workspaceAnswerSchema.parse(
      await query(WORKSPACE_QUERY, { workspaceId: configured }),
    );
    return [answer.workspace];
  }
  return meSchema.parse(await query(ME_QUERY)).me.workspaces;
}

/** One page of a workspace's projects. */
export async function projectsPage(
  query: RailwayQuery,
  workspaceId: string,
  after: string | null,
  first = PROJECTS_PER_REQUEST,
): Promise<{ projects: ProjectListing[]; next: string | null }> {
  const answer = projectsSchema.parse(
    await query(PROJECTS_QUERY, { workspaceId, first, after }),
  );
  const { hasNextPage, endCursor } = answer.projects.pageInfo;
  return {
    projects: answer.projects.edges.map(({ node }) => ({
      id: node.id,
      name: node.name,
      workspaceId,
      services: node.services.edges.map((edge) => edge.node),
      environments: node.environments.edges.map((edge) => edge.node),
    })),
    next: hasNextPage && endCursor ? endCursor : null,
  };
}

export async function listProjects(
  query: RailwayQuery,
  workspaceId: string,
  first = PROJECTS_PER_REQUEST,
  maxRequests = MAX_PROJECT_REQUESTS,
): Promise<ProjectListing[]> {
  const projects: ProjectListing[] = [];
  let after: string | null = null;
  for (let request = 0; request < maxRequests; request += 1) {
    const page = await projectsPage(query, workspaceId, after, first);
    projects.push(...page.projects);
    if (page.next === null) break;
    after = page.next;
  }
  return projects;
}
