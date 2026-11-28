// Configuration, listings and reason codes shared by check, discover and
// sync.

import {
  ConnectorError,
  configuredHost,
  type ConfigOptionsResult,
  type ConnectionContext,
} from "@netrics/connector-sdk";

import { PostHogApiError, US_HOST, type PostHogClient } from "./api.js";
import {
  LIST_LIMIT,
  insightListSchema,
  nextOffset,
  organizationsSchema,
  projectsSchema,
} from "./queries.js";

/** Listing pages discover reads per organization (2,000 projects). */
const MAX_LIST_REQUESTS = 20;
/** Saved insights a connection reads at most. */
export const MAX_INSIGHTS = 20;
/** The config field of the saved insights (a picker since #891). */
export const INSIGHTS_KEY = "insights";
/**
 * Insights the picker lists per project at most: five listing pages. A
 * project with more says so (`truncated`); its other insights can still
 * be chosen by an older pasted link.
 */
export const MAX_INSIGHT_OPTIONS = 500;
/** Longest insight name the picker shows, in characters. */
const MAX_INSIGHT_LABEL = 300;
/** Project IDs a project-scoped key's connection names at most. */
export const MAX_PROJECT_IDS = 50;

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
  "Enter your PostHog's host: us.posthog.com, eu.posthog.com, or your own instance's host name such as posthog.example.com: a public name reached over https, without a path or port.";
export const INSIGHTS_INVALID_CODE = "posthog.insights_invalid";
export const INSIGHTS_INVALID_MESSAGE =
  "netrics could not read the saved insights of this connection. Choose them again under Saved insights, per project, at most 20.";
export const INSIGHTS_UNAVAILABLE_CODE = "posthog.insights_unavailable";
export const INSIGHTS_UNAVAILABLE_MESSAGE =
  "PostHog did not let the personal API key list this project's saved insights. Check that the key may read the project and has the scope Insight: Read.";
export const PROJECTS_REQUIRED_CODE = "posthog.projects_required";
export const PROJECTS_REQUIRED_MESSAGE =
  "The personal API key is limited to some projects, so PostHog does not list them. Enter their project IDs under Project IDs (PostHog: Project settings → Project ID).";
export const PROJECTS_INVALID_CODE = "posthog.projects_invalid";
export const PROJECTS_INVALID_MESSAGE =
  "netrics could not read every project ID with this key. Enter the numeric IDs of projects the key may read (PostHog: Project settings → Project ID), separated by spaces or commas, at most 50.";

// ─── Configuration ──────────────────────────────────────────────────────────

export function apiKeyOf(context: ConnectionContext): string | undefined {
  const key = context.credentials.token;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

/**
 * The API host of the connection: the configured `host` (us.posthog.com
 * when none is set), read by `configuredHost`, the rule the egress
 * allowlist and the credential binding read it with. Null when the value
 * is no valid host.
 */
export function hostOf(context: ConnectionContext): string | null {
  const host = context.config.host;
  return host === undefined ||
    host === null ||
    (typeof host === "string" && host.trim() === "")
    ? US_HOST
    : configuredHost(host);
}

/**
 * A numeric project ID as PostHog names it: without leading zeros, so
 * `01000` and `1000` are the same project (#888 item 5). It compares and
 * deduplicates IDs, and goes into request paths; anything else passes
 * through unchanged.
 */
export function canonicalProjectId(id: string): string {
  return /^\d+$/.test(id) ? id.replace(/^0+(?=\d)/, "") : id;
}

/**
 * The resource ID a project is reported under, by its canonical ID: the
 * first of `spellings` (the stored selection, then the configured Project
 * IDs) that names it, so a connection keeps the identity its selection,
 * project links and history are stored under; the canonical ID for a
 * project the connection never named (#888 review). The spellings are
 * indexed once, so a large selection is not scanned per project (#914).
 */
export function resourceIdsOf(
  spellings: readonly string[],
): (canonical: string) => string {
  const first = new Map<string, string>();
  for (const id of spellings) {
    const canonical = canonicalProjectId(id);
    if (!first.has(canonical)) first.set(canonical, id);
  }
  return (canonical) => first.get(canonical) ?? canonical;
}

/** The saved resource selection the host passes in `resourceSelection`. */
export function storedSelectionOf(
  context: ConnectionContext,
): string[] | undefined {
  const selection = context.config.resourceSelection;
  return Array.isArray(selection) &&
    selection.every((id) => typeof id === "string")
    ? (selection as string[])
    : undefined;
}

/**
 * The project IDs a connection names for a key limited to projects
 * (PostHog's `scoped_teams`): then netrics reads those projects through
 * project endpoints and lists no organization. `undefined` when none are
 * configured; `invalid` counts what is no ID, or above MAX_PROJECT_IDS.
 * IDs keep the spelling they were first written with; a later spelling of
 * the same project (`1000` after `01000`) is a duplicate.
 */
export function projectIdsOf(context: ConnectionContext): {
  ids: string[] | undefined;
  invalid: number;
} {
  const raw = context.config.projects;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ids: undefined, invalid: 0 };
  }
  const ids: string[] = [];
  let invalid = 0;
  for (const token of raw.split(/[\s,]+/).filter((entry) => entry !== "")) {
    if (!/^\d{1,20}$/.test(token)) invalid += 1;
    else if (
      !ids.some((id) => canonicalProjectId(id) === canonicalProjectId(token))
    ) {
      ids.push(token);
    }
  }
  if (ids.length > MAX_PROJECT_IDS) {
    invalid += ids.length - MAX_PROJECT_IDS;
    ids.length = MAX_PROJECT_IDS;
  }
  // A value that names no ID at all (",,,") is no list of projects: it
  // would make the check run no query (#884 review 2).
  if (ids.length === 0) invalid += 1;
  return { ids, invalid };
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
    const ref = { project: canonicalProjectId(match[1]!), shortId: match[2]! };
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

/**
 * An organization or project the key may not read (any more): 403 or 404,
 * not a wrong key, a missing scope or a key limited to projects.
 */
export function isRefused(error: unknown): boolean {
  return (
    error instanceof PostHogApiError &&
    (error.kind === "forbidden" || error.kind === "not_found")
  );
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
    if (error.kind === "project_scoped") {
      throw new ConnectorError(
        PROJECTS_REQUIRED_MESSAGE,
        PROJECTS_REQUIRED_CODE,
      );
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

/**
 * Every organization and project the key sees, for discover; for a
 * connection that names project IDs, those projects (PostHog has no
 * project endpoint that names a project for a project-scoped key, so the
 * ID is the name).
 */
export async function listProjects(
  client: PostHogClient,
  projectIds?: readonly string[],
  selection: readonly string[] = [],
): Promise<Project[]> {
  const resourceIdOf = resourceIdsOf([...selection, ...(projectIds ?? [])]);
  if (projectIds) {
    return projectIds.map((configured) => {
      const id = resourceIdOf(canonicalProjectId(configured));
      return { id, name: id, organizationId: "" };
    });
  }
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
      let page;
      try {
        page = await projectsPage(client, organization.id, offset);
      } catch (error) {
        // An organization whose projects the key may not read (403, 404)
        // is skipped, as the sync skips it, so the readable ones can be
        // connected (#888 item 2). A wrong key or a missing scope fails.
        if (!isRefused(error)) throw error;
        break;
      }
      projects.push(
        ...page.projects.map((project) => ({
          ...project,
          id: resourceIdOf(project.id),
        })),
      );
      offset = page.next;
    }
  }
  return projects;
}

// ─── Insight picker (#891) ──────────────────────────────────────────────────

/** An insight's value in the `insights` field: "project/shortId". */
export function insightValue(ref: InsightRef): string {
  return `${ref.project}/${ref.shortId}`;
}

/**
 * The saved trends insights of one project, for the picker, and what the
 * draft config chooses now. Reads PostHog's insight list (`basic=true`,
 * saved insights only), a page of LIST_LIMIT per request and at most
 * MAX_INSIGHT_OPTIONS: never one request per insight, and never a query.
 * An insight whose listed query is not a trends insight is left out; one
 * listed without its query is offered (the sync reports it as
 * `unsupported` if it is none). A project the key may not read fails with
 * INSIGHTS_UNAVAILABLE_CODE.
 */
export async function listInsightOptions(
  client: PostHogClient,
  context: ConnectionContext,
  resourceId: string,
): Promise<ConfigOptionsResult> {
  const resourceIdOf = resourceIdsOf([
    ...(storedSelectionOf(context) ?? []),
    ...(projectIdsOf(context).ids ?? []),
  ]);
  const selected = insightsOf(context).insights.map((ref) => ({
    value: insightValue(ref),
    resourceId: resourceIdOf(ref.project),
  }));
  if (!/^\d{1,20}$/.test(resourceId)) {
    throw new ConnectorError(
      INSIGHTS_UNAVAILABLE_MESSAGE,
      INSIGHTS_UNAVAILABLE_CODE,
    );
  }
  const project = canonicalProjectId(resourceId);
  const options: ConfigOptionsResult["options"] = [];
  let truncated = false;
  for (let offset: number | null = 0; offset !== null;) {
    if (options.length >= MAX_INSIGHT_OPTIONS) {
      truncated = true;
      break;
    }
    let page;
    try {
      page = insightListSchema.parse(
        await client.get(`/api/projects/${project}/insights/`, {
          basic: "true",
          saved: "true",
          limit: LIST_LIMIT,
          offset,
        }),
      );
    } catch (error) {
      if (!isRefused(error)) throw error;
      throw new ConnectorError(
        INSIGHTS_UNAVAILABLE_MESSAGE,
        INSIGHTS_UNAVAILABLE_CODE,
      );
    }
    for (const insight of page.results) {
      if (insight.deleted === true) continue;
      const query = insight.query;
      if (
        query &&
        (query.kind !== "InsightVizNode" ||
          query.source?.kind !== "TrendsQuery")
      ) {
        continue;
      }
      if (!/^[A-Za-z0-9]{1,32}$/.test(insight.short_id)) continue;
      if (options.length >= MAX_INSIGHT_OPTIONS) {
        truncated = true;
        break;
      }
      const name = (insight.name || insight.derived_name || "").trim();
      options.push({
        value: insightValue({ project, shortId: insight.short_id }),
        label: name
          ? [...name].slice(0, MAX_INSIGHT_LABEL).join("")
          : insight.short_id,
        ...(name ? { description: insight.short_id } : {}),
      });
    }
    offset = nextOffset(page, offset);
  }
  return { options, selected, ...(truncated ? { truncated: true } : {}) };
}
