// Configuration and the project listing, shared by check, discover and
// sync.

import type { ConnectionContext } from "@netrics/connector-sdk";
import { z } from "zod";

import {
  VercelInvalidResponseError,
  parseAnswer,
  type Query,
  type VercelGet,
} from "./api.js";

/** Projects per listing request (Vercel's maximum is 100). */
export const PROJECTS_PER_REQUEST = 100;
/** Listing pages check and discover read (1,000 projects); a sync pages on. */
export const MAX_PROJECT_PAGES = 10;

// ─── Configuration ──────────────────────────────────────────────────────────

export function tokenOf(context: ConnectionContext): string | undefined {
  const token = context.credentials.token;
  return typeof token === "string" && token.trim() !== ""
    ? token.trim()
    : undefined;
}

export function teamIdOf(context: ConnectionContext): string | undefined {
  const teamId = context.config.teamId;
  return typeof teamId === "string" && teamId !== "" ? teamId : undefined;
}

/**
 * The stored project selection. Undefined when none is stored (connections
 * from before selections existed, and "all projects"): every project is
 * collected. An explicit empty selection collects nothing (#782).
 */
export function selectionOf(context: ConnectionContext): string[] | undefined {
  const selection = context.config.resourceSelection;
  return Array.isArray(selection) &&
    selection.every((id) => typeof id === "string")
    ? (selection as string[])
    : undefined;
}

/** Requests on behalf of a team need its id; personal accounts do not. */
export function ownerQuery(accountId: string): Query {
  return accountId.startsWith("team_") ? { teamId: accountId } : {};
}

// ─── The project listing ────────────────────────────────────────────────────

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accountId: z.string().min(1),
  webAnalytics: z
    .object({ enabledAt: z.number().optional() })
    .loose()
    .nullish(),
});
const projectsPageSchema = z.object({
  projects: z.array(projectSchema.loose()),
  pagination: z
    .object({ next: z.union([z.number(), z.string()]).nullish() })
    .loose()
    .optional(),
});

export interface VercelProject {
  id: string;
  name: string;
  accountId: string;
  /** Web Analytics is enabled: its datasets can be read. */
  analytics: boolean;
}

/**
 * One page of the project listing. `next` is the continuation Vercel
 * named, null on the last page. A continuation equal to the one asked
 * with would read the same page forever: an invalid answer.
 */
export async function projectsPage(
  get: VercelGet,
  teamId: string | undefined,
  from: string | null,
): Promise<{ projects: VercelProject[]; next: string | null }> {
  const body = parseAnswer(
    projectsPageSchema,
    await get("/v10/projects", {
      limit: String(PROJECTS_PER_REQUEST),
      teamId,
      ...(from !== null ? { from } : {}),
    }),
    "the project list",
  );
  const raw = body.pagination?.next;
  const next = raw === null || raw === undefined ? null : String(raw);
  if (next !== null && (next === from || body.projects.length === 0)) {
    throw new VercelInvalidResponseError("the project list");
  }
  return {
    projects: body.projects.map((project) => ({
      id: project.id,
      name: project.name,
      accountId: project.accountId,
      analytics: typeof project.webAnalytics?.enabledAt === "number",
    })),
    next,
  };
}

/** Every project, up to MAX_PROJECT_PAGES pages (check and discover). */
export async function listProjects(
  get: VercelGet,
  teamId: string | undefined,
): Promise<VercelProject[]> {
  const projects: VercelProject[] = [];
  let from: string | null = null;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const answer = await projectsPage(get, teamId, from);
    projects.push(...answer.projects);
    if (answer.next === null) break;
    from = answer.next;
  }
  return projects;
}
