// Configuration, listings and reason codes shared by check, discover and
// sync.

import { ConnectorError, type ConnectionContext } from "@netrics/connector-sdk";

import { RailwayApiError, type RailwayQuery } from "./api.js";
import {
  ME_QUERY,
  PROJECTS_QUERY,
  PROJECT_ENVIRONMENTS_QUERY,
  PROJECT_SERVICES_QUERY,
  WORKSPACE_QUERY,
  meSchema,
  projectEnvironmentsSchema,
  projectServicesSchema,
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

/** Services and environments per project in a projects page. */
const SERVICES_PER_REQUEST = 100;
const ENVIRONMENTS_PER_REQUEST = 50;

interface NestedPages {
  /** Where a project's services and environments continue, if they do. */
  services: string | null;
  environments: string | null;
}

/**
 * One page of a workspace's projects. `nested` is how many services and
 * environments to read along: a sync only needs ids and names (1), the
 * discovery all of them (full pages, then `completeProject`).
 */
export async function projectsPage(
  query: RailwayQuery,
  workspaceId: string,
  after: string | null,
  first = PROJECTS_PER_REQUEST,
  nested: "names" | "full" = "names",
): Promise<{
  projects: Array<ProjectListing & { more: NestedPages }>;
  next: string | null;
}> {
  const answer = projectsSchema.parse(
    await query(PROJECTS_QUERY, {
      workspaceId,
      first,
      after,
      servicesFirst: nested === "full" ? SERVICES_PER_REQUEST : 1,
      environmentsFirst: nested === "full" ? ENVIRONMENTS_PER_REQUEST : 1,
    }),
  );
  const { hasNextPage, endCursor } = answer.projects.pageInfo;
  const more = (info: { hasNextPage: boolean; endCursor?: string | null }) =>
    info.hasNextPage && info.endCursor ? info.endCursor : null;
  return {
    projects: answer.projects.edges.map(({ node }) => ({
      id: node.id,
      name: node.name,
      workspaceId,
      services: node.services.edges.map((edge) => edge.node),
      environments: node.environments.edges.map((edge) => edge.node),
      more: {
        services: more(node.services.pageInfo),
        environments: more(node.environments.pageInfo),
      },
    })),
    next: hasNextPage && endCursor ? endCursor : null,
  };
}

/** Reads the rest of a project's services and environments (#881). */
async function completeProject(
  query: RailwayQuery,
  project: ProjectListing,
  more: NestedPages,
): Promise<void> {
  for (let after = more.services; after !== null;) {
    const answer = projectServicesSchema.parse(
      await query(PROJECT_SERVICES_QUERY, {
        projectId: project.id,
        first: SERVICES_PER_REQUEST,
        after,
      }),
    ).project.services;
    project.services.push(...answer.edges.map((edge) => edge.node));
    after =
      answer.pageInfo.hasNextPage && answer.pageInfo.endCursor
        ? answer.pageInfo.endCursor
        : null;
  }
  for (let after = more.environments; after !== null;) {
    const answer = projectEnvironmentsSchema.parse(
      await query(PROJECT_ENVIRONMENTS_QUERY, {
        projectId: project.id,
        first: ENVIRONMENTS_PER_REQUEST,
        after,
      }),
    ).project.environments;
    project.environments.push(...answer.edges.map((edge) => edge.node));
    after =
      answer.pageInfo.hasNextPage && answer.pageInfo.endCursor
        ? answer.pageInfo.endCursor
        : null;
  }
}

/**
 * A workspace's projects. With `complete`, every service and environment
 * of each (discovery names them); otherwise ids and names only.
 */
export async function listProjects(
  query: RailwayQuery,
  workspaceId: string,
  first = PROJECTS_PER_REQUEST,
  maxRequests = MAX_PROJECT_REQUESTS,
  complete = false,
): Promise<ProjectListing[]> {
  const projects: ProjectListing[] = [];
  let after: string | null = null;
  for (let request = 0; request < maxRequests; request += 1) {
    const page = await projectsPage(
      query,
      workspaceId,
      after,
      first,
      complete ? "full" : "names",
    );
    for (const { more, ...project } of page.projects) {
      if (complete) await completeProject(query, project, more);
      projects.push(project);
    }
    if (page.next === null) break;
    after = page.next;
  }
  return projects;
}
