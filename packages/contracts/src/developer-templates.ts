import { z } from "zod";

/**
 * The connectors the Developer Portfolio template (#876) reads: operations
 * (Railway, Vercel, Hetzner Cloud, HTTP checks), product analytics
 * (PostHog, Vercel Web Analytics, Search Console) and the stores (App
 * Store, Google Play). Any subset installs; a source not chosen leaves its
 * widgets out.
 */
export const DEVELOPER_TEMPLATE_CONNECTORS = [
  "railway",
  "vercel",
  "hetzner-cloud",
  "http-check",
  "posthog",
  "google-search-console",
  "app-store-connect",
  "google-play",
] as const;
export type DeveloperTemplateConnector =
  (typeof DEVELOPER_TEMPLATE_CONNECTORS)[number];

/** The most connections one install reads (one append per family). */
export const DEVELOPER_TEMPLATE_CONNECTIONS_MAX = 80;

/** A resource of a chosen connection linked to a workspace project. */
const link = z.strictObject({
  connectionId: z.uuid(),
  resourceId: z.string().trim().min(1).max(1024),
  projectId: z.uuid(),
});

/**
 * Installing the Developer Portfolio: its name, the connections it reads
 * and, optionally, links of their resources to workspace projects. Without
 * a link, a resource belongs to its connection's project (when the
 * connection has one); a link wins over that.
 */
export const developerTemplateRequestSchema = z.strictObject({
  requestId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  connections: z.array(z.uuid()).min(1).max(DEVELOPER_TEMPLATE_CONNECTIONS_MAX),
  links: z.array(link).max(1000).default([]),
  /** The project the dashboard, preparations and models start in. */
  projectId: z.uuid().nullable().optional(),
});
export type DeveloperTemplateRequest = z.infer<
  typeof developerTemplateRequestSchema
>;

export const developerTemplateResultSchema = z.object({
  dashboardId: z.uuid(),
  /** The install's resource → project links table (a manual dataset). */
  linksDatasetId: z.uuid(),
  /** The install's projects table (project id → name). */
  projectsDatasetId: z.uuid(),
  /** Model id per family the install reads (`state`, `deploys`, …). */
  models: z.record(z.string(), z.uuid()),
  preparationIds: z.array(z.uuid()),
  /**
   * Projects without a slide of their own: a dashboard has at most 12
   * slides and 48 data widgets, so past them a project shows in the
   * overview only. Missing when every linked project has its slide.
   */
  omittedProjects: z.array(z.string()).optional(),
});
export type DeveloperTemplateResult = z.infer<
  typeof developerTemplateResultSchema
>;

/**
 * What an install can read: the workspace's set-up connections of the
 * template's connectors with their resources and assigned project, and the
 * workspace's projects (not archived).
 */
export const developerTemplateOptionsSchema = z.object({
  connections: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      connectorId: z.enum(DEVELOPER_TEMPLATE_CONNECTORS),
      setupPending: z.boolean(),
      projectId: z.uuid().nullable(),
      resources: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
  projects: z.array(z.object({ id: z.uuid(), name: z.string() })),
});
export type DeveloperTemplateOptions = z.infer<
  typeof developerTemplateOptionsSchema
>;
