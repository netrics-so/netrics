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
  /** Also add the demo connection and a sample dashboard (#51). */
  withDemo: z.boolean().optional(),
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

export const createWorkspaceResponseSchema = workspaceResponseSchema.extend({
  /** The sample dashboard when `withDemo` was set and it could be added. */
  demoDashboardId: z.uuid().nullable(),
});
export type CreateWorkspaceResponse = z.infer<
  typeof createWorkspaceResponseSchema
>;

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
  strategy: z.enum(["token", "none", "oauth2", "signed-key"]),
  /**
   * For "oauth2": the provider the user authorizes at (ADR 0012). For
   * "signed-key": the provider whose key the user uploads and the host signs
   * tokens with (ADR 0014).
   */
  provider: z.string().min(1).optional(),
  /** For "oauth2": the scopes the connector needs, besides identity scopes. */
  scopes: z.array(z.string().min(1)).optional(),
  /** Label and help text for the token field. */
  tokenLabel: z.string().min(1).optional(),
  tokenDescription: z.string().min(1).optional(),
  /** Steps to create the credential, and the provider page for it. */
  setup: z
    .object({
      steps: z.array(z.string().min(1)),
      url: z.url().optional(),
    })
    .optional(),
});
export type ConnectorAuthStrategy = z.infer<typeof connectorAuthStrategySchema>;

/**
 * Why a connector cannot be used on this instance:
 * - oauth_provider_not_configured: the administrator has not set the
 *   provider's NETRICS_OAUTH_<PROVIDER>_CLIENT_ID/_CLIENT_SECRET;
 * - oauth_provider_unsupported: this server has no definition for the
 *   provider the connector names;
 * - signed_key_provider_unsupported: this server cannot sign tokens for the
 *   signed-key provider the connector names (ADR 0014).
 */
export const connectorUnavailableReasonSchema = z.enum([
  "oauth_provider_not_configured",
  "oauth_provider_unsupported",
  "signed_key_provider_unsupported",
]);
export type ConnectorUnavailableReason = z.infer<
  typeof connectorUnavailableReasonSchema
>;

export const connectorUnavailableSchema = z.object({
  reason: connectorUnavailableReasonSchema,
  /** The OAuth or signed-key provider concerned. */
  provider: z.string().min(1),
});
export type ConnectorUnavailable = z.infer<typeof connectorUnavailableSchema>;

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
  /**
   * Whether connections can be created on this instance. False when every
   * auth strategy needs an OAuth provider the instance has not configured
   * (ADR 0012); `unavailable` then says why, for administrators.
   */
  available: z.boolean(),
  unavailable: connectorUnavailableSchema.nullable(),
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

/**
 * What an existing OAuth connection can read at its provider (e.g. the
 * Search Console properties of the linked Google account), discovered with
 * a short-lived access token from the token service (ADR 0012). Used to
 * finish setup and to change the chosen resource.
 */
export const connectionResourcesResponseSchema = z.object({
  resources: z.array(discoveredResourceSchema),
});
export type ConnectionResourcesResponse = z.infer<
  typeof connectionResourcesResponseSchema
>;

// "pending" = never synced successfully yet; the other states mirror
// connection_state.auth_state.
export const connectionHealthSchema = z.enum([
  "ok",
  "auth_failed",
  "needs_reauthorization",
  "outage",
  "pending",
]);
export type ConnectionHealth = z.infer<typeof connectionHealthSchema>;

/**
 * needs_reauthorization (ADR 0012): an OAuth grant no longer works and the
 * user must authorize again; syncing pauses, as for auth_failed.
 */
export const connectionAuthStateSchema = z.enum([
  "ok",
  "auth_failed",
  "needs_reauthorization",
  "outage",
]);
export type ConnectionAuthState = z.infer<typeof connectionAuthStateSchema>;

/**
 * Why a connection needs reauthorization: invalid_grant (revoked, expired,
 * password changed, or the 7-day limit of an OAuth app in testing),
 * scope_missing (the connector now needs scopes the grant lacks).
 */
export const connectionAuthReasonSchema = z.enum([
  "invalid_grant",
  "scope_missing",
]);
export type ConnectionAuthReason = z.infer<typeof connectionAuthReasonSchema>;

export const connectionStateViewSchema = z.object({
  health: connectionHealthSchema,
  authState: connectionAuthStateSchema,
  /** Set only with authState needs_reauthorization. */
  authReason: connectionAuthReasonSchema.nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  nextDueAt: z.iso.datetime().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
  pollIntervalSeconds: z.number().int().positive(),
});
export type ConnectionStateView = z.infer<typeof connectionStateViewSchema>;

/**
 * The provider account a connection is authorized with ("Connected as …").
 * Never carries token material.
 */
export const connectionOAuthViewSchema = z.object({
  provider: z.string().min(1),
  accountEmail: z.string().nullable(),
  grantedScopes: z.array(z.string().min(1)),
});
export type ConnectionOAuthView = z.infer<typeof connectionOAuthViewSchema>;

/**
 * Why an OAuth authorization was started (ADR 0012): a new connection, or a
 * new grant for an existing one.
 */
export const oauthAuthorizationPurposeSchema = z.enum([
  "connect",
  "reauthorize",
]);
export type OAuthAuthorizationPurpose = z.infer<
  typeof oauthAuthorizationPurposeSchema
>;

/**
 * Where an OAuth flow may return to (ADR 0012): a path of the web app, never
 * a URL. The API also checks it against its allowlist of app routes.
 */
export const oauthReturnPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\/(?!\/)[^\\?#]*$/, "a relative path inside the app");

/**
 * Starts an OAuth authorization (ADR 0012). Without `connectionId` it
 * connects a new connection (role: connections:create); with it, it
 * reauthorizes that connection (connections:update).
 * `allowAccountChange` (reauthorization only) accepts a grant from a
 * different provider account than the linked one.
 */
export const startOAuthAuthorizationRequestSchema = z.object({
  connectorId: z.string().min(1).max(200),
  connectionId: z.uuid().optional(),
  allowAccountChange: z.boolean().optional(),
  returnPath: oauthReturnPathSchema.optional(),
});
export type StartOAuthAuthorizationRequest = z.infer<
  typeof startOAuthAuthorizationRequestSchema
>;

export const startOAuthAuthorizationResponseSchema = z.object({
  /** Where the browser goes next (window.location; not a form post). */
  authorizationUrl: z.url(),
  purpose: oauthAuthorizationPurposeSchema,
  expiresAt: z.iso.datetime(),
});
export type StartOAuthAuthorizationResponse = z.infer<
  typeof startOAuthAuthorizationResponseSchema
>;

/**
 * The provider's redirect query, forwarded by the web app's callback route.
 * Single-use values; the API never echoes or logs them.
 */
export const oauthCallbackRequestSchema = z.object({
  state: z.string().min(1).max(512).optional(),
  code: z.string().min(1).max(4096).optional(),
  error: z.string().min(1).max(256).optional(),
});
export type OAuthCallbackRequest = z.infer<typeof oauthCallbackRequestSchema>;

/**
 * How an OAuth callback ended. The web app shows a message for each:
 * - connected / reauthorized: the grant is stored;
 * - denied: consent was refused at the provider (nothing stored);
 * - invalid_state: unknown, expired or already used (start again);
 * - forbidden: started by another user, or the role is gone;
 * - scope_missing: not every required permission was granted;
 * - account_mismatch: a different provider account than the linked one;
 * - failed: the provider exchange or its ID token was refused.
 */
export const oauthCallbackOutcomeSchema = z.enum([
  "connected",
  "reauthorized",
  "denied",
  "invalid_state",
  "forbidden",
  "scope_missing",
  "account_mismatch",
  "failed",
]);
export type OAuthCallbackOutcome = z.infer<typeof oauthCallbackOutcomeSchema>;

export const oauthCallbackResponseSchema = z.object({
  outcome: oauthCallbackOutcomeSchema,
  /**
   * Relative path in the web app to answer 303 with; carries `oauth=<outcome>`
   * (and `connection=<id>` after connecting) in its query.
   */
  redirectTo: z.string().regex(/^\/(?!\/)[^\\]*$/),
});
export type OAuthCallbackResponse = z.infer<typeof oauthCallbackResponseSchema>;

export const connectionSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  connectorId: z.string().min(1),
  connectorName: z.string().min(1),
  connectorVersion: z.string().min(1),
  projectId: z.uuid().nullable(),
  hasCredentials: z.boolean(),
  /** The linked OAuth account, for connections authorized at a provider. */
  oauth: connectionOAuthViewSchema.nullable(),
  /**
   * Created by an OAuth authorization and not finished yet (ADR 0012): it
   * holds the grant, but its config (e.g. the property) is still to be
   * chosen. Not scheduled until then; the web app shows "Finish setup".
   * A PATCH with a config that passes the connector check finishes it: the
   * connection is scheduled and its backfill queued in the same commit.
   */
  setupPending: z.boolean(),
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

/**
 * What deleting an OAuth connection did with the grant at the provider
 * (ADR 0012):
 * - revoked: this was the last connection on the instance using the
 *   account's grant, and the provider confirmed the revocation;
 * - kept: another connection (in any workspace) still uses the grant, so
 *   only the stored tokens were deleted;
 * - failed: the revocation did not go through; the user can remove access
 *   at `accountPermissionsUrl`.
 * The connection is deleted in every case.
 */
export const connectionRevocationSchema = z.object({
  provider: z.string().min(1),
  status: z.enum(["revoked", "kept", "failed"]),
  accountPermissionsUrl: z.url().nullable(),
});
export type ConnectionRevocation = z.infer<typeof connectionRevocationSchema>;

export const deleteConnectionResponseSchema = z.object({
  /** Null for connections not authorized through OAuth. */
  revocation: connectionRevocationSchema.nullable(),
});
export type DeleteConnectionResponse = z.infer<
  typeof deleteConnectionResponseSchema
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
export type MetricPeriod = z.infer<typeof metricPeriodSchema>;
export type MetricAggregation = z.infer<typeof metricAggregationSchema>;

/**
 * Which way is good for a metric: "higher" (most metrics) or "lower" (e.g.
 * an average position, where 1 is the top). Tiles colour a change by it.
 */
export const metricBetterSchema = z.enum(["higher", "lower"]);
export type MetricBetter = z.infer<typeof metricBetterSchema>;

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
  better: metricBetterSchema,
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

// ---------------------------------------------------------------------------
// Devices and pairing (ADR 0010, ADR 0011)
// ---------------------------------------------------------------------------

/**
 * Version of the device API (pairing, credentials, device dashboard). The
 * tvOS app refuses servers whose version it does not support.
 */
export const DEVICE_API_VERSION = 1;

/** Public server identification for the tvOS app's server check. */
export const serverInfoResponseSchema = z.object({
  product: z.literal("netrics"),
  deviceApiVersion: z.number().int().positive(),
  version: z.string().min(1),
  /** Where a signed-in user approves a pairing code. */
  pairingUrl: z.url(),
});
export type ServerInfoResponse = z.infer<typeof serverInfoResponseSchema>;

export const createPairingResponseSchema = z.object({
  pairingId: z.uuid(),
  /** Shown on the TV as XXXX-XXXX. */
  code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  /** Kept by the device; proves it is the one polling. */
  pollSecret: z.string().min(32),
  expiresAt: z.iso.datetime(),
  pollIntervalSeconds: z.number().int().positive(),
  pairingUrl: z.url(),
  /** pairingUrl with the code filled in, for a QR code. */
  approveUrl: z.url(),
});
export type CreatePairingResponse = z.infer<typeof createPairingResponseSchema>;

export const pollPairingRequestSchema = z.object({
  pairingId: z.uuid(),
  pollSecret: z.string().min(32).max(128),
});
export type PollPairingRequest = z.infer<typeof pollPairingRequestSchema>;

export const deviceCredentialsSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.iso.datetime(),
});
export type DeviceCredentials = z.infer<typeof deviceCredentialsSchema>;

export const pollPairingResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    status: z.literal("approved"),
    device: z.object({ id: z.uuid(), name: z.string().min(1) }),
    credentials: deviceCredentialsSchema,
  }),
]);
export type PollPairingResponse = z.infer<typeof pollPairingResponseSchema>;

export const approveDeviceRequestSchema = z.object({
  /** As shown on the TV; case, spaces and dashes are ignored. */
  code: z.string().trim().min(8).max(20),
  name: nameSchema,
  dashboardId: z.uuid().nullable(),
});
export type ApproveDeviceRequest = z.infer<typeof approveDeviceRequestSchema>;

export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  dashboardId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  /** The latest heartbeat; null until the device sends one. */
  heartbeat: z
    .object({
      at: z.iso.datetime(),
      appVersion: z.string(),
      uptimeSeconds: z.number().int().nonnegative(),
      /** As the device reported it; untrusted text. */
      lastError: z.string().nullable(),
    })
    .nullable(),
});
export type Device = z.infer<typeof deviceSchema>;

export const deviceResponseSchema = z.object({ device: deviceSchema });
export type DeviceResponse = z.infer<typeof deviceResponseSchema>;

export const deviceListResponseSchema = z.object({
  devices: z.array(deviceSchema),
});
export type DeviceListResponse = z.infer<typeof deviceListResponseSchema>;

export const refreshDeviceTokenRequestSchema = z.object({
  refreshToken: z.string().min(1).max(200),
});
export type RefreshDeviceTokenRequest = z.infer<
  typeof refreshDeviceTokenRequestSchema
>;

export const refreshDeviceTokenResponseSchema = z.object({
  credentials: deviceCredentialsSchema,
});
export type RefreshDeviceTokenResponse = z.infer<
  typeof refreshDeviceTokenResponseSchema
>;

/** The calling device, as it sees itself. */
export const deviceSelfResponseSchema = z.object({
  device: z.object({
    id: z.uuid(),
    name: z.string().min(1),
    dashboardId: z.uuid().nullable(),
  }),
});
export type DeviceSelfResponse = z.infer<typeof deviceSelfResponseSchema>;

export const updateDeviceRequestSchema = z
  .object({
    name: nameSchema.optional(),
    dashboardId: z.uuid().nullable().optional(),
  })
  .refine((body) => body.name !== undefined || body.dashboardId !== undefined, {
    message: "nothing to change",
  });
export type UpdateDeviceRequest = z.infer<typeof updateDeviceRequestSchema>;

// The device dashboard read model and heartbeat (ADR 0007, #57).

/** How often a device should ask again (ADR 0007: 60 s refresh target). */
export const DEVICE_REFRESH_AFTER_SECONDS = 60;

/**
 * How a tile's numbers can be trusted:
 * ok (fresh), stale (last sync too long ago, or none yet), auth_failed and
 * outage (the connection is failing), no_data (nothing to show).
 */
export const deviceTileStatusSchema = z.enum([
  "ok",
  "stale",
  "auth_failed",
  "outage",
  "no_data",
]);
export type DeviceTileStatus = z.infer<typeof deviceTileStatusSchema>;

export const deviceTileSchema = z.object({
  id: z.uuid(),
  /** The tile title, else the metric name. */
  label: z.string().min(1),
  period: metricPeriodSchema,
  aggregation: metricAggregationSchema,
  /** Raw number; the client formats it with `unit`. Null without data. */
  value: z.number().nullable(),
  /**
   * E.g. "count", "percent", or "<ISO 4217>_minor" for currency amounts in
   * integer minor units (ADR 0008). Null when the tile could not load.
   */
  unit: z.string().nullable(),
  /** Against the previous period of the same length. */
  change: z.object({
    previousValue: z.number().nullable(),
    /** value − previousValue; null when there is nothing to compare. */
    delta: z.number().nullable(),
    /** delta ÷ |previousValue|; null against zero or missing data. */
    ratio: z.number().nullable(),
  }),
  /** One point per bucket of the current period, oldest first; null = gap. */
  spark: z.array(z.number().nullable()),
  /**
   * The metric's kind and granularity (a daily gauge reads "Latest day"),
   * null when the tile could not load; and which way is good for a change.
   */
  kind: z.enum(METRIC_KINDS).nullable(),
  granularity: z.enum(GRANULARITIES).nullable(),
  better: metricBetterSchema,
  status: deviceTileStatusSchema,
  /** The connection's last successful sync. */
  updatedAt: z.iso.datetime().nullable(),
});
export type DeviceTile = z.infer<typeof deviceTileSchema>;

export const deviceDashboardResponseSchema = z.object({
  /** Hash of the content below; also the ETag. */
  version: z.string().min(1),
  refreshAfterSec: z.number().int().positive(),
  /** The workspace's time zone, which the buckets follow. */
  timeZone: z.string().min(1),
  /** Null when no dashboard is assigned; tiles is then empty. */
  dashboard: z.object({ id: z.uuid(), name: z.string().min(1) }).nullable(),
  tiles: z.array(deviceTileSchema),
});
export type DeviceDashboardResponse = z.infer<
  typeof deviceDashboardResponseSchema
>;

export const deviceHeartbeatRequestSchema = z.object({
  appVersion: z.string().trim().min(1).max(50),
  uptimeSeconds: z.number().int().min(0).max(2_147_483_647),
  lastError: z.string().max(500).nullable().optional(),
});
export type DeviceHeartbeatRequest = z.infer<
  typeof deviceHeartbeatRequestSchema
>;
