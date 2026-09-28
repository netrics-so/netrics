import { z } from "zod";

import {
  AGGREGATIONS,
  GRANULARITIES,
  METRIC_KINDS,
  PERIODS,
  WORKSPACE_ROLES,
  isValidTimeZone,
} from "@netrics/domain";

export const processRoleSchema = z.enum(["api", "worker", "scheduler"]);
export type ProcessRole = z.infer<typeof processRoleSchema>;

// The role list belongs to the domain; the contract validates it.
export const workspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export type { WorkspaceRole } from "@netrics/domain";

export const versionInfoSchema = z.object({
  version: z.string().min(1),
  commit: z.string().min(1),
});
export type VersionInfo = z.infer<typeof versionInfoSchema>;

export const healthLiveResponseSchema = z
  .object({
    status: z.literal("ok"),
    role: processRoleSchema,
    uptimeSeconds: z.number().nonnegative(),
  })
  .extend(versionInfoSchema.shape);
export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;

export const databaseStatusSchema = z.enum(["up", "down"]);
export type DatabaseStatus = z.infer<typeof databaseStatusSchema>;

export const healthReadyResponseSchema = z
  .object({
    status: z.enum(["ready", "not_ready"]),
    role: processRoleSchema,
    database: databaseStatusSchema,
    checkedAt: z.iso.datetime(),
  })
  .extend(versionInfoSchema.shape);
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.string().min(1),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const bootstrapRequestSchema = z.object({
  workspaceName: z.string().trim().min(1).max(100),
});
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const bootstrapResponseSchema = z.object({
  workspace: z.object({
    id: z.uuid(),
    name: z.string().min(1),
  }),
});
export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

/** Public: whether first-run setup is pending and who may sign up. */
export const setupStatusResponseSchema = z.object({
  setupRequired: z.boolean(),
  signup: z.enum(["open", "closed"]),
});
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string().min(1),
    displayName: z.string().min(1),
  }),
  memberships: z.array(
    z.object({
      workspaceId: z.uuid(),
      workspaceName: z.string().min(1),
      role: workspaceRoleSchema,
    }),
  ),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

const nameSchema = z.string().trim().min(1).max(100);

/** An IANA time zone name, e.g. Europe/Berlin. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { message: "unknown time zone" });

export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** "today" and daily buckets follow this zone. */
  timeZone: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceRequestSchema = z.object({
  name: nameSchema,
  /** Defaults to UTC; the web app sends the creator's browser zone. */
  timeZone: timeZoneSchema.optional(),
});
export type CreateWorkspaceRequest = z.infer<
  typeof createWorkspaceRequestSchema
>;

export const renameWorkspaceRequestSchema = z
  .object({ name: nameSchema.optional(), timeZone: timeZoneSchema.optional() })
  .refine((body) => body.name !== undefined || body.timeZone !== undefined, {
    message: "nothing to update",
  });
export type RenameWorkspaceRequest = z.infer<
  typeof renameWorkspaceRequestSchema
>;

export const workspaceResponseSchema = z.object({
  workspace: workspaceSchema,
});
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().min(1),
      role: workspaceRoleSchema,
      activeProjectId: z.uuid().nullable(),
    }),
  ),
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const memberSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  email: z.string().min(1),
  displayName: z.string().min(1),
  role: workspaceRoleSchema,
  createdAt: z.iso.datetime(),
});
export type Member = z.infer<typeof memberSchema>;

export const memberResponseSchema = z.object({ member: memberSchema });
export type MemberResponse = z.infer<typeof memberResponseSchema>;

export const memberListResponseSchema = z.object({
  members: z.array(memberSchema),
});
export type MemberListResponse = z.infer<typeof memberListResponseSchema>;

// Invitations: membership is granted only when the invitee accepts with the
// token, which proves access to the invited mailbox.
export const createInvitationRequestSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema,
});
export type CreateInvitationRequest = z.infer<
  typeof createInvitationRequestSchema
>;

export const invitationDeliverySchema = z.enum(["email", "manual"]);
export type InvitationDelivery = z.infer<typeof invitationDeliverySchema>;

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string().min(1),
  role: workspaceRoleSchema,
  delivery: invitationDeliverySchema,
  invitedByName: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type Invitation = z.infer<typeof invitationSchema>;

/**
 * `inviteUrl` is returned only for delivery "manual" (no email transport):
 * the admin hands the link over. With email delivery it is never exposed.
 */
export const invitationResponseSchema = z.object({
  invitation: invitationSchema,
  inviteUrl: z.url().nullable(),
});
export type InvitationResponse = z.infer<typeof invitationResponseSchema>;

export const invitationListResponseSchema = z.object({
  invitations: z.array(invitationSchema),
});
export type InvitationListResponse = z.infer<
  typeof invitationListResponseSchema
>;

/** Public (token holder): what the invite page shows before sign-in. */
export const invitationPreviewResponseSchema = z.object({
  workspaceName: z.string().min(1),
  email: z.string().min(1),
  role: workspaceRoleSchema,
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  expiresAt: z.iso.datetime(),
});
export type InvitationPreviewResponse = z.infer<
  typeof invitationPreviewResponseSchema
>;

export const acceptInvitationResponseSchema = z.object({
  workspaceId: z.uuid(),
});
export type AcceptInvitationResponse = z.infer<
  typeof acceptInvitationResponseSchema
>;

export const updateMemberRoleRequestSchema = z.object({
  role: workspaceRoleSchema,
});
export type UpdateMemberRoleRequest = z.infer<
  typeof updateMemberRoleRequestSchema
>;

export const setActiveProjectRequestSchema = z.object({
  projectId: z.uuid().nullable(),
});
export type SetActiveProjectRequest = z.infer<
  typeof setActiveProjectRequestSchema
>;

export const activeProjectResponseSchema = z.object({
  activeProjectId: z.uuid().nullable(),
});
export type ActiveProjectResponse = z.infer<typeof activeProjectResponseSchema>;

export const projectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type Project = z.infer<typeof projectSchema>;

export const createProjectRequestSchema = z.object({ name: nameSchema });
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const renameProjectRequestSchema = z.object({ name: nameSchema });
export type RenameProjectRequest = z.infer<typeof renameProjectRequestSchema>;

export const projectResponseSchema = z.object({ project: projectSchema });
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const projectListResponseSchema = z.object({
  projects: z.array(projectSchema),
});
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;

export const auditEventSchema = z.object({
  id: z.uuid(),
  action: z.string().min(1),
  actorUserId: z.uuid().nullable(),
  target: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const auditEventListResponseSchema = z.object({
  events: z.array(auditEventSchema),
});
export type AuditEventListResponse = z.infer<
  typeof auditEventListResponseSchema
>;

// ---------------------------------------------------------------------------
// Connectors (installation-level catalog) and connections (workspace-scoped)
// ---------------------------------------------------------------------------

export const connectorAuthStrategySchema = z.object({
  strategy: z.enum(["token", "none"]),
});
export type ConnectorAuthStrategy = z.infer<typeof connectorAuthStrategySchema>;

/** The JSON-Schema subset manifests use travels as an opaque record. */
const jsonSchemaObjectSchema = z.record(z.string(), z.unknown());

export const connectorCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  metricsCount: z.number().int().nonnegative(),
  minRefreshIntervalSeconds: z.number().int().positive(),
  supportsBackfill: z.boolean(),
  configSchema: jsonSchemaObjectSchema,
  authStrategies: z.array(connectorAuthStrategySchema),
});
export type ConnectorCatalogEntry = z.infer<typeof connectorCatalogEntrySchema>;

export const connectorListResponseSchema = z.object({
  connectors: z.array(connectorCatalogEntrySchema),
});
export type ConnectorListResponse = z.infer<typeof connectorListResponseSchema>;

const connectionConfigSchema = z.record(z.string(), z.unknown());
// Input-only: credentials must never appear on any response schema.
const connectionCredentialsSchema = z.record(z.string(), z.unknown());

export const createConnectionRequestSchema = z.object({
  connectorId: z.string().min(1),
  name: nameSchema,
  config: connectionConfigSchema.default({}),
  credentials: connectionCredentialsSchema.optional(),
  projectId: z.uuid().optional(),
  resources: z.array(z.string().min(1)).optional(),
});
export type CreateConnectionRequest = z.infer<
  typeof createConnectionRequestSchema
>;

export const previewConnectionRequestSchema = z.object({
  connectorId: z.string().min(1),
  config: connectionConfigSchema.default({}),
  credentials: connectionCredentialsSchema.optional(),
});
export type PreviewConnectionRequest = z.infer<
  typeof previewConnectionRequestSchema
>;

export const connectionCheckResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().min(1).optional(),
});
export type ConnectionCheckResult = z.infer<typeof connectionCheckResultSchema>;

export const discoveredResourceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type DiscoveredResource = z.infer<typeof discoveredResourceSchema>;

export const connectionPreviewResponseSchema = z.object({
  check: connectionCheckResultSchema,
  resources: z.array(discoveredResourceSchema),
});
export type ConnectionPreviewResponse = z.infer<
  typeof connectionPreviewResponseSchema
>;

// "pending" = never synced successfully yet; the other states mirror
// connection_state.auth_state.
export const connectionHealthSchema = z.enum([
  "ok",
  "auth_failed",
  "outage",
  "pending",
]);
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

export const connectionAuthStateSchema = z.enum([
  "ok",
  "auth_failed",
  "outage",
]);
export type ConnectionAuthState = z.infer<typeof connectionAuthStateSchema>;

export const connectionStateViewSchema = z.object({
  health: connectionHealthSchema,
  authState: connectionAuthStateSchema,
  lastSuccessAt: z.iso.datetime().nullable(),
  nextDueAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  pollIntervalSeconds: z.number().int().positive(),
});
export type ConnectionStateView = z.infer<typeof connectionStateViewSchema>;

export const connectionSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  connectorId: z.string().min(1),
  connectorName: z.string().min(1),
  connectorVersion: z.string().min(1),
  projectId: z.uuid().nullable(),
  hasCredentials: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  state: connectionStateViewSchema,
});
export type Connection = z.infer<typeof connectionSchema>;

export const connectionListResponseSchema = z.object({
  connections: z.array(connectionSchema),
});
export type ConnectionListResponse = z.infer<
  typeof connectionListResponseSchema
>;

export const connectionDetailSchema = connectionSchema.extend({
  config: connectionConfigSchema,
});
export type ConnectionDetail = z.infer<typeof connectionDetailSchema>;

export const connectionResponseSchema = z.object({
  connection: connectionDetailSchema,
});
export type ConnectionResponse = z.infer<typeof connectionResponseSchema>;

export const syncRunSchema = z.object({
  id: z.uuid(),
  mode: z.enum(["backfill", "incremental"]),
  status: z.enum(["running", "succeeded", "failed"]),
  requestedFrom: z.iso.datetime(),
  requestedTo: z.iso.datetime(),
  cursorBefore: z.string().nullable(),
  cursorAfter: z.string().nullable(),
  attempt: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  errorClass: z.enum(["auth", "transient", "contract", "budget"]).nullable(),
  errorMessage: z.string().nullable(),
  observationsWritten: z.number().int().nonnegative(),
});
export type SyncRun = z.infer<typeof syncRunSchema>;

export const connectionDetailResponseSchema = z.object({
  connection: connectionDetailSchema,
  syncRuns: z.array(syncRunSchema),
});
export type ConnectionDetailResponse = z.infer<
  typeof connectionDetailResponseSchema
>;

export const updateConnectionRequestSchema = z.object({
  name: nameSchema.optional(),
  config: connectionConfigSchema.optional(),
  credentials: connectionCredentialsSchema.optional(),
  projectId: z.uuid().nullable().optional(),
});
export type UpdateConnectionRequest = z.infer<
  typeof updateConnectionRequestSchema
>;

export const enqueueSyncResponseSchema = z.object({
  jobId: z.uuid(),
});
export type EnqueueSyncResponse = z.infer<typeof enqueueSyncResponseSchema>;

export const observationListQuerySchema = z.object({
  metricKey: z.string().min(1).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type ObservationListQuery = z.infer<typeof observationListQuerySchema>;

// Identity: (metricKey, seriesKey, sourceTimestamp) within a connection.
export const observationSchema = z.object({
  metricKey: z.string().min(1),
  seriesKey: z.string().min(1),
  sourceTimestamp: z.iso.datetime(),
  value: z.number(),
  dimensions: z.record(z.string(), z.string()),
  ingestedAt: z.iso.datetime(),
});
export type Observation = z.infer<typeof observationSchema>;

export const observationListResponseSchema = z.object({
  observations: z.array(observationSchema),
});
export type ObservationListResponse = z.infer<
  typeof observationListResponseSchema
>;

// Installation admin API (/v1/admin, ADR 0009).
export const adminWorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  createdAt: z.iso.datetime(),
  memberCount: z.number().int().min(0),
});
export type AdminWorkspace = z.infer<typeof adminWorkspaceSchema>;

export const adminWorkspaceListResponseSchema = z.object({
  workspaces: z.array(adminWorkspaceSchema),
});
export type AdminWorkspaceListResponse = z.infer<
  typeof adminWorkspaceListResponseSchema
>;

export {
  parseConfigSchema,
  validateConnectionConfig,
  type ConfigField,
  type ConfigValidation,
} from "./config-schema.js";

// ─── Metrics (#48) ──────────────────────────────────────────────────────────

export const metricPeriodSchema = z.enum(PERIODS);
export const metricAggregationSchema = z.enum(AGGREGATIONS);

export const workspaceMetricSchema = z.object({
  connectionId: z.uuid(),
  connectionName: z.string(),
  key: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  kind: z.enum(METRIC_KINDS),
  unit: z.string().min(1),
  granularity: z.enum(GRANULARITIES),
  dimensions: z.array(z.string()),
  /** Aggregations a tile may use, default first. Empty: not displayable. */
  aggregations: z.array(metricAggregationSchema),
});
export type WorkspaceMetric = z.infer<typeof workspaceMetricSchema>;

export const workspaceMetricListResponseSchema = z.object({
  metrics: z.array(workspaceMetricSchema),
});
export type WorkspaceMetricListResponse = z.infer<
  typeof workspaceMetricListResponseSchema
>;

export const metricQueryRequestSchema = z.object({
  connectionId: z.uuid(),
  metricKey: z.string().min(1).max(200),
  period: metricPeriodSchema,
  /** Defaults to the metric's first compatible aggregation. */
  aggregation: metricAggregationSchema.optional(),
  /** Only series with these dimension values (at most 10). */
  dimensions: z
    .record(z.string().min(1).max(100), z.string().max(200))
    .optional(),
});
export type MetricQueryRequest = z.infer<typeof metricQueryRequestSchema>;

export const metricQueryResponseSchema = z.object({
  metric: workspaceMetricSchema,
  period: metricPeriodSchema,
  timeZone: z.string().min(1),
  aggregation: metricAggregationSchema,
  /** Null when the window has no data. */
  value: z.number().nullable(),
  previousValue: z.number().nullable(),
  /** value − previousValue. */
  delta: z.number().nullable(),
  /** delta ÷ |previousValue|; null against zero or missing data. */
  ratio: z.number().nullable(),
  /** One point per bucket of the current window; null where empty. */
  series: z.array(
    z.object({ bucket: z.iso.datetime(), value: z.number().nullable() }),
  ),
});
export type MetricQueryResponse = z.infer<typeof metricQueryResponseSchema>;

// ─── Dashboards (#49) ───────────────────────────────────────────────────────

/** Most tiles one dashboard may hold. */
export const MAX_DASHBOARD_TILES = 24;

const dimensionFilterSchema = z
  .record(z.string().min(1).max(100), z.string().max(200))
  .refine((dimensions) => Object.keys(dimensions).length <= 10, {
    message: "at most 10 dimension filters",
  });

export const dashboardTileInputSchema = z.object({
  connectionId: z.uuid(),
  metricKey: z.string().min(1).max(200),
  /** Defaults to the metric's first compatible aggregation. */
  aggregation: metricAggregationSchema.optional(),
  period: metricPeriodSchema,
  dimensions: dimensionFilterSchema.optional(),
  /** Shown instead of the metric name. */
  title: z.string().trim().min(1).max(100).nullable().optional(),
});
export type DashboardTileInput = z.infer<typeof dashboardTileInputSchema>;

export const dashboardTileSchema = z.object({
  id: z.uuid(),
  position: z.number().int().min(0),
  connectionId: z.uuid(),
  metricKey: z.string().min(1),
  aggregation: metricAggregationSchema,
  period: metricPeriodSchema,
  dimensions: z.record(z.string(), z.string()),
  title: z.string().nullable(),
});
export type DashboardTile = z.infer<typeof dashboardTileSchema>;

export const dashboardSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  projectId: z.uuid().nullable(),
  /** Send it back with PUT; a newer version on the server answers 409. */
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  tiles: z.array(dashboardTileSchema),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const dashboardResponseSchema = z.object({ dashboard: dashboardSchema });
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export const dashboardListResponseSchema = z.object({
  dashboards: z.array(
    z.object({
      id: z.uuid(),
      name: z.string().min(1),
      projectId: z.uuid().nullable(),
      version: z.number().int().min(1),
      tileCount: z.number().int().min(0),
      updatedAt: z.iso.datetime(),
    }),
  ),
});
export type DashboardListResponse = z.infer<typeof dashboardListResponseSchema>;

export const createDashboardRequestSchema = z.object({
  name: nameSchema,
  projectId: z.uuid().nullable().optional(),
  tiles: z.array(dashboardTileInputSchema).max(MAX_DASHBOARD_TILES).optional(),
});
export type CreateDashboardRequest = z.infer<
  typeof createDashboardRequestSchema
>;

/** Replaces name, project and the ordered tiles in one step. */
export const replaceDashboardRequestSchema = z.object({
  version: z.number().int().min(1),
  name: nameSchema,
  projectId: z.uuid().nullable(),
  tiles: z.array(dashboardTileInputSchema).max(MAX_DASHBOARD_TILES),
});
export type ReplaceDashboardRequest = z.infer<
  typeof replaceDashboardRequestSchema
>;

export const duplicateDashboardRequestSchema = z.object({
  /** Defaults to "<name> (copy)". */
  name: nameSchema.optional(),
});
export type DuplicateDashboardRequest = z.infer<
  typeof duplicateDashboardRequestSchema
>;
