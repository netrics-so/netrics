// Configuration, listings and reason codes shared by check, discover and
// sync.

import {
  ConnectorError,
  configuredHost,
  type ConnectionContext,
} from "@netrics/connector-sdk";

import {
  EU_HOST,
  PostHogApiError,
  US_HOST,
  type PostHogClient,
} from "./api.js";
import {
  LIST_LIMIT,
  nextOffset,
  organizationsSchema,
  projectsSchema,
} from "./queries.js";

/** Listing pages discover reads per organization (2,000 projects). */
const MAX_LIST_REQUESTS = 20;
/** Saved insights a connection reads at most. */
export const MAX_INSIGHTS = 20;

/** The scopes netrics needs, as PostHog names them. */
export const REQUIRED_SCOPES = [
  "organization:read",
  "project:read",
  "query:read",
  "insight:read",
] as const;

// ─── Reason codes of a failed check (#795) ─────────────────────────────────

export const KEY_REJECTED_CODE = "posthog.key_rejected";
export const KEY_REJECTED_MESSAGE =
  "PostHog did not accept the personal API key: it is wrong, was deleted, or belongs to another region or instance. Create a personal API key in PostHog (Settings → Personal API keys) on the host this connection names.";
export const SCOPE_MISSING_CODE = "posthog.scope_missing";
export const SCOPE_MISSING_MESSAGE =
  "The personal API key lacks a scope netrics needs. Give it the read scopes Organization, Project, Query and Insight in PostHog (Settings → Personal API keys), or create a new key with them.";
export const HOST_INVALID_CODE = "posthog.host_invalid";
export const HOST_INVALID_MESSAGE =
  "Enter the host name of your self-hosted PostHog, such as posthog.example.com: a public name reached over https, without a path or port.";
export const INSIGHTS_INVALID_CODE = "posthog.insights_invalid";
export const INSIGHTS_INVALID_MESSAGE =
  "netrics could not read the saved insights. Paste each insight's link from PostHog (…/project/12345/insights/AbCd1234), separated by spaces or commas, at most 20.";

// ─── Configuration ──────────────────────────────────────────────────────────

export const REGIONS = ["us", "eu", "self-hosted"] as const;
export type Region = (typeof REGIONS)[number];

export function apiKeyOf(context: ConnectionContext): string | undefined {
  const key = context.credentials.token;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

export function regionOf(context: ConnectionContext): Region {
  const region = context.config.region;
  return region === "eu" || region === "self-hosted" ? region : "us";
}

/**
 * The API host of the connection: PostHog Cloud US or EU, or the
 * configured self-hosted host (`configuredHost`, the rule the egress
 * allowlist reads it with). Null for a self-hosted connection without a
 * valid host.
 */
export function hostOf(context: ConnectionContext): string | null {
  switch (regionOf(context)) {
    case "us":
      return US_HOST;
    case "eu":
      return EU_HOST;
    default:
      return configuredHost(context.config.host);
  }
}

/** A saved insight a connection reads: its project and short ID. */
export interface InsightRef {
  project: string;
  shortId: string;
}

const INSIGHT_LINK =
  /^(?:https:\/\/[^/\s]+)?\/?project\/(\d{1,20})\/insights\/([A-Za-z0-9]{1,32})(?:\/[a-z]*)?\/?(?:[?#]\S*)?$/;
const INSIGHT_PAIR = /^(\d{1,20})\/([A-Za-z0-9]{1,32})$/;

/**
 * The configured insights: links from PostHog (…/project/12345/insights/
 * AbCd1234) or "12345/AbCd1234", separated by whitespace or commas, without
 * duplicates. `invalid` holds what could not be read.
 */
export function insightsOf(context: ConnectionContext): {
  insights: InsightRef[];
  invalid: number;
} {
  const raw = context.config.insights;
  if (typeof raw !== "string") return { insights: [], invalid: 0 };
  const insights: InsightRef[] = [];
  let invalid = 0;
  for (const token of raw.split(/[\s,]+/).filter((entry) => entry !== "")) {
    const match = INSIGHT_LINK.exec(token) ?? INSIGHT_PAIR.exec(token);
    if (!match) {
      invalid += 1;
      continue;
    }
    const ref = { project: match[1]!, shortId: match[2]! };
    if (
      !insights.some(
        (entry) =>
          entry.project === ref.project && entry.shortId === ref.shortId,
      )
    ) {
      insights.push(ref);
    }
  }
  if (insights.length > MAX_INSIGHTS) {
    invalid += insights.length - MAX_INSIGHTS;
    insights.length = MAX_INSIGHTS;
  }
  return { insights, invalid };
}

/** Auth and scope failures in discover and sync carry the check's code. */
export function rethrow(error: unknown): never {
  if (error instanceof PostHogApiError) {
    if (error.kind === "auth") {
      throw new ConnectorError(KEY_REJECTED_MESSAGE, KEY_REJECTED_CODE);
    }
    if (error.kind === "scope") {
      throw new ConnectorError(SCOPE_MISSING_MESSAGE, SCOPE_MISSING_CODE);
    }
  }
  throw error;
}

// ─── Listings ───────────────────────────────────────────────────────────────

export interface Organization {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  organizationId: string;
}

/** One page of the key's organizations. */
export async function organizationsPage(
  client: PostHogClient,
  offset: number,
): Promise<{ organizations: Organization[]; next: number | null }> {
  const page = organizationsSchema.parse(
    await client.get("/api/organizations/", { limit: LIST_LIMIT, offset }),
  );
  return {
    organizations: page.results.map(({ id, name }) => ({ id, name })),
    next: nextOffset(page, offset),
  };
}

/** One page of an organization's projects. */
export async function projectsPage(
  client: PostHogClient,
  organizationId: string,
  offset: number,
  limit = LIST_LIMIT,
): Promise<{ projects: Project[]; next: number | null }> {
  const page = projectsSchema.parse(
    await client.get(
      `/api/organizations/${encodeURIComponent(organizationId)}/projects/`,
      { limit, offset },
    ),
  );
  return {
    projects: page.results.map((project) => ({
      id: String(project.id),
      name: project.name || String(project.id),
      organizationId,
    })),
    next: nextOffset(page, offset),
  };
}

/** Every organization and project the key sees, for discover. */
export async function listProjects(client: PostHogClient): Promise<Project[]> {
  const organizations: Organization[] = [];
  for (
    let offset: number | null = 0, request = 0;
    offset !== null && request < MAX_LIST_REQUESTS;
    request += 1
  ) {
    const page = await organizationsPage(client, offset);
    organizations.push(...page.organizations);
    offset = page.next;
  }
  const projects: Project[] = [];
  for (const organization of organizations) {
    for (
      let offset: number | null = 0, request = 0;
      offset !== null && request < MAX_LIST_REQUESTS;
      request += 1
    ) {
      const page = await projectsPage(client, organization.id, offset);
      projects.push(...page.projects);
      offset = page.next;
    }
  }
  return projects;
}
