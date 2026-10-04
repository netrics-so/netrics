import { z } from "zod";

import {
  AGGREGATIONS,
  BUILTIN_THEME_KEYS,
  GRANULARITIES,
  METRIC_KINDS,
  PERIODS,
  BACKGROUND_DIM,
  CUSTOM_LAYOUT_MAX_PAGES,
  FORMAT_WARNING_CODES,
  SCREEN_FORMAT_KEYS,
  SCREEN_FORMAT_MAX_GRID,
  SLIDE_SECONDS,
  SLIDE_TRANSITIONS,
  STUDIO_GRID,
  STUDIO_LIMITS,
  SUPPORTED_LOCALES,
  THEME_COLOR_TOKENS,
  THEME_FONT_SCALES,
  WIDGET_TYPES,
  WORKSPACE_ROLES,
  isValidTimeZone,
  type ThemeColorToken,
} from "@netrics/domain";

import { imageContentTypeSchema } from "./images.js";

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

/** A language netrics speaks (ADR 0016): "en" or "de". */
export const localeSchema = z.enum(SUPPORTED_LOCALES);

export const meResponseSchema = z.object({
  user: z.object({
    id: z.uuid(),
    email: z.string().min(1),
    displayName: z.string().min(1),
    /**
     * The user's language; null follows the instance default
     * (NETRICS_DEFAULT_LOCALE), then the browser (ADR 0016). Defaults to
     * null so a web app deployed before its API still parses the answer.
     */
    locale: localeSchema.nullable().default(null),
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

export const updateMeRequestSchema = z.object({
  /** Null goes back to the instance default and the browser. */
  locale: localeSchema.nullable(),
});
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;

const nameSchema = z.string().trim().min(1).max(100);

/** An ISO 4217 currency code, e.g. EUR. */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: "expected an ISO 4217 code such as EUR" });

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
  /**
   * Amounts in several currencies are converted into this currency with
   * ECB reference rates, approximately (#191). Null: amounts per currency,
   * exact (the default).
   */
  displayCurrency: z.string().length(3).nullable(),
  /**
   * The language of the workspace's screens (kiosk, Apple TV); null
   * follows the instance default (ADR 0016). Defaults to null for an API
   * deployed after its web app.
   */
  screenLocale: localeSchema.nullable().default(null),
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
  .object({
    name: nameSchema.optional(),
    timeZone: timeZoneSchema.optional(),
    /**
     * EUR or a currency the ECB publishes (400 currency_not_covered); null
     * goes back to amounts per currency. 400 currency_conversion_off when
     * the instance does not fetch rates.
     */
    displayCurrency: currencyCodeSchema.nullable().optional(),
    /** The screens' language; null follows the instance default. */
    screenLocale: localeSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.timeZone !== undefined ||
      body.displayCurrency !== undefined ||
      body.screenLocale !== undefined,
    { message: "nothing to update" },
  );
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

/**
 * POST /v1/workspaces/:workspaceId/demo (#308): the demo connection and a
 * sample dashboard for an existing workspace, as `withDemo` adds them to a
 * new one. Null when the demo connector is not installed or they could not
 * be added.
 */
export const addDemoContentResponseSchema = z.object({
  demoDashboardId: z.uuid().nullable(),
});
export type AddDemoContentResponse = z.infer<
  typeof addDemoContentResponseSchema
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
  /**
   * For "signed-key": the provider's display name and the credential
   * fields the wizard asks for, in order (ADR 0014). They are sent as
   * `credentials: { [key]: value }`. A "file" field is chosen with a file
   * picker or pasted; a secret field is never shown again after upload.
   */
  providerName: z.string().min(1).optional(),
  fields: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
        description: z.string().min(1),
        input: z.enum(["text", "file"]),
        secret: z.boolean(),
        placeholder: z.string().min(1).optional(),
        /** Upper bound of the value in UTF-8 bytes. */
        maxBytes: z.number().int().positive(),
      }),
    )
    .optional(),
  /** Steps to create the credential, and the provider page for it. */
  setup: z
    .object({
      steps: z.array(z.string().min(1)),
      url: z.url().optional(),
      /**
       * For "signed-key": deep links shown with a step (`step` is the
       * zero-based index into `steps`), e.g. the keys page or the page
       * that shows the vendor number.
       */
      links: z
        .array(
          z.object({
            step: z.number().int().nonnegative(),
            label: z.string().min(1),
            url: z.url(),
          }),
        )
        .optional(),
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
 * - signed_key_provider_unsupported: this server has no definition for the
 *   signed-key provider the connector names, so it cannot sign its tokens
 *   (ADR 0014).
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

/**
 * Where the catalogue files a connector (the manifest's `category`, SDK
 * 0.2.7, #306); connectors that do not say are "other".
 */
export const connectorCategorySchema = z.enum([
  "seo",
  "web",
  "apps",
  "ads",
  "revenue",
  "other",
]);
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>;

export const connectorCatalogEntrySchema = z.object({
  id: z.string().min(1),
  /**
   * Name, description, and the titles and descriptions in `configSchema`
   * and the auth strategies, in the caller's language, else English (#257).
   */
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  metricsCount: z.number().int().nonnegative(),
  /** Catalogue category; "other" when the manifest does not say (#306). */
  category: connectorCategorySchema,
  /** The icon tile's colour, "#rrggbb", or null for a neutral tile. */
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  /**
   * The metrics a dashboard can show (helpers left out), in manifest order,
   * named in the caller's language: the catalogue's metric chips.
   */
  metrics: z.array(
    z.object({ key: z.string().min(1), name: z.string().min(1) }),
  ),
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

/**
 * Enabling App Store analytics (ADR 0014, #174): a temporary Admin team key
 * (issuer ID, key ID, private key), used in memory for this one request to
 * create the missing ONGOING analytics report requests. Input-only: the key
 * is never stored, enqueued, logged or returned.
 */
export const enableAppStoreAnalyticsRequestSchema = z.object({
  credentials: connectionCredentialsSchema,
});
export type EnableAppStoreAnalyticsRequest = z.infer<
  typeof enableAppStoreAnalyticsRequestSchema
>;

/** Per app: what the enablement did. */
export const appStoreAnalyticsOutcomeSchema = z.object({
  appId: z.string().min(1),
  name: z.string().nullable(),
  /** created: requested now; existing: already requested; failed. */
  outcome: z.enum(["created", "existing", "failed"]),
  message: z.string().nullable(),
});
export type AppStoreAnalyticsOutcome = z.infer<
  typeof appStoreAnalyticsOutcomeSchema
>;

export const enableAppStoreAnalyticsResponseSchema = z.object({
  apps: z.array(appStoreAnalyticsOutcomeSchema),
  /** Where the user revokes the temporary key now. */
  keysUrl: z.string(),
});
export type EnableAppStoreAnalyticsResponse = z.infer<
  typeof enableAppStoreAnalyticsResponseSchema
>;

/**
 * Per app, read with the connection's own key: not_enabled (no ONGOING
 * request), stopped (Apple stopped it: enable again), requested (data
 * pending, the first reports take 1–2 days), available (analytics data
 * stored, `latestDay` the newest), unknown (Apple could not be asked).
 */
export const appStoreAnalyticsAppStatusSchema = z.object({
  appId: z.string().min(1),
  name: z.string().nullable(),
  status: z.enum([
    "not_enabled",
    "stopped",
    "requested",
    "available",
    "unknown",
  ]),
  latestDay: z.string().nullable(),
  message: z.string().nullable(),
});
export type AppStoreAnalyticsAppStatus = z.infer<
  typeof appStoreAnalyticsAppStatusSchema
>;

export const appStoreAnalyticsStatusResponseSchema = z.object({
  apps: z.array(appStoreAnalyticsAppStatusSchema),
  /** Where team keys are created and revoked. */
  keysUrl: z.string(),
});
export type AppStoreAnalyticsStatusResponse = z.infer<
  typeof appStoreAnalyticsStatusResponseSchema
>;

/**
 * The optional reviews key of an App Store Connect connection (ADR 0014
 * decision 2, #190), asked live with its own token: not_configured (no
 * reviews key stored), active (Apple accepts it), paused (Apple refused it:
 * revoked, or its role no longer reads reviews; review metrics pause while
 * sales keep syncing), unknown (Apple could not be asked right now). Added,
 * replaced and removed through PATCH …/connections/:id with
 * `credentials: { reviews: { keyId, privateKey } }` or `{ reviews: null }`.
 * `keyId` is the stored reviews key's (non-secret) key ID.
 */
export const appStoreReviewsStatusResponseSchema = z.object({
  status: z.enum(["not_configured", "active", "paused", "unknown"]),
  keyId: z.string().nullable(),
  message: z.string().nullable(),
  /** Where team keys are created and revoked. */
  keysUrl: z.string(),
});
export type AppStoreReviewsStatusResponse = z.infer<
  typeof appStoreReviewsStatusResponseSchema
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

/**
 * The stored key of a signed-key connection (ADR 0014), by its non-secret
 * fields only (e.g. issuer ID and key ID), so the user can tell which key
 * to revoke after rotating. Secret fields such as the private key are never
 * part of it.
 */
export const connectionSignedKeyViewSchema = z.object({
  provider: z.string().min(1),
  fields: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      value: z.string(),
    }),
  ),
});
export type ConnectionSignedKeyView = z.infer<
  typeof connectionSignedKeyViewSchema
>;

export const connectionDetailSchema = connectionSchema.extend({
  config: connectionConfigSchema,
  /** The stored signed key's non-secret fields; null for other connections. */
  signedKey: connectionSignedKeyViewSchema.nullable(),
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
  /**
   * Name of the observation's resource (its "resource" dimension: an app, a
   * project, a property) as the connector last reported it (#196). Null
   * without a "resource" dimension or before the connector has named it.
   */
  resourceName: z.string().nullable(),
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

// Workspace images (ADR 0015, #217).
export * from "./images.js";
export * from "./goals.js";

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

/**
 * "primary" metrics are shown on their own; a "helper" (e.g. Search
 * Console's position sum) is an input for derived values. Helpers stay
 * queryable, but tile pickers do not offer them.
 */
export const metricRoleSchema = z.enum(["primary", "helper"]);
export type MetricRole = z.infer<typeof metricRoleSchema>;

export const workspaceMetricSchema = z.object({
  connectionId: z.uuid(),
  connectionName: z.string(),
  key: z.string().min(1),
  /** Name and description in the caller's language, else English (#257). */
  name: z.string().min(1),
  description: z.string(),
  kind: z.enum(METRIC_KINDS),
  /**
   * E.g. "count", "percent", "<ISO 4217>_minor" for amounts in one currency
   * (integer minor units, ADR 0008), or "currency_minor" for amounts whose
   * ISO 4217 code is in the "currency" dimension (ADR 0014). A
   * "currency_minor" metric is only queried per currency.
   */
  unit: z.string().min(1),
  granularity: z.enum(GRANULARITIES),
  dimensions: z.array(z.string()),
  /**
   * A display name for each dimension in the caller's language: the
   * connector's translation, else the key in sentence case (#257). Absent
   * from an API older than the field: empty.
   */
  dimensionNames: z.record(z.string(), z.string()).default({}),
  /** Aggregations a tile may use, default first. Empty: not displayable. */
  aggregations: z.array(metricAggregationSchema),
  better: metricBetterSchema,
  role: metricRoleSchema,
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
  /**
   * Only series with these dimension values (at most 10). For a
   * "currency_minor" metric, a "currency" filter (an ISO 4217 code) shows
   * that currency alone, exactly; anything else is 400 currency_required.
   * Without one, the amounts are converted into `displayCurrency` or the
   * workspace's display currency (#191), else the currency with the largest
   * total over the period is shown: amounts in different currencies are
   * never added up unconverted.
   */
  dimensions: z
    .record(z.string().min(1).max(100), z.string().max(200))
    .optional(),
  /**
   * Convert a "currency_minor" metric into this currency instead of the
   * workspace's display currency (#191). Ignored with a "currency" filter,
   * and when the instance does not fetch rates.
   */
  displayCurrency: currencyCodeSchema.optional(),
});
export type MetricQueryRequest = z.infer<typeof metricQueryRequestSchema>;

/** How a converted amount came about (#191); its values are approximate. */
export const currencyConversionSchema = z.object({
  /** The amounts are in this currency, converted. */
  displayCurrency: z.string().length(3),
  /** Always true: show converted values as approximate ("≈"). */
  approximate: z.literal(true),
  /** Cite it next to the values. */
  source: z.object({ name: z.string().min(1), url: z.url() }),
  /**
   * Amounts in currencies without a rate for their day (the ECB does not
   * publish TWD, for example), per currency in its own minor units with the
   * tile's aggregation. They are not part of `value`; show them apart.
   */
  unconverted: z.array(
    z.object({
      currency: z.string().length(3),
      value: z.number().nullable(),
      previousValue: z.number().nullable(),
    }),
  ),
});
export type CurrencyConversion = z.infer<typeof currencyConversionSchema>;

export const metricQueryResponseSchema = z.object({
  metric: workspaceMetricSchema,
  period: metricPeriodSchema,
  timeZone: z.string().min(1),
  aggregation: metricAggregationSchema,
  /**
   * ISO 4217 code of the amounts (in minor units) when the metric is an
   * amount: from a "<ISO>_minor" unit, the "currency" filter, the display
   * currency converted into, or the largest currency shown. Null otherwise.
   */
  currency: z.string().nullable(),
  /**
   * Set when a "currency_minor" amount was converted into a display
   * currency (#191): value, previousValue and series are then approximate.
   * Null for exact values.
   */
  conversion: currencyConversionSchema.nullable(),
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
  /**
   * The previous window's points aligned to `series` (a line chart's dashed
   * comparison, ADR 0015): point i is the same hour, day, week or month of
   * the previous window, formed and converted like `series`, and carries
   * the bucket of `series[i]`. Null where empty.
   */
  previousSeries: z.array(
    z.object({ bucket: z.iso.datetime(), value: z.number().nullable() }),
  ),
});
export type MetricQueryResponse = z.infer<typeof metricQueryResponseSchema>;

/**
 * A metric by one of its dimensions over a period (a bar chart, ADR 0015):
 * one value per dimension value, the largest `limit` of them plus "Others".
 */
export const metricBreakdownRequestSchema = z.object({
  connectionId: z.uuid(),
  metricKey: z.string().min(1).max(200),
  period: metricPeriodSchema,
  /** Defaults to the metric's first compatible aggregation. */
  aggregation: metricAggregationSchema.optional(),
  /**
   * The dimension to group by, one the metric declares (e.g. "resource",
   * "territory", "device"); anything else is 400 unknown_dimension. Not
   * "currency": amounts are grouped within one currency or converted.
   */
  groupBy: z.string().min(1).max(100),
  /** Groups shown before "Others", 3–10. */
  limit: z.number().int().min(3).max(10).default(5),
  /**
   * Only series with these dimension values (at most 10), as in a metric
   * query. For a "currency_minor" metric a "currency" filter shows that
   * currency exactly; without one the amounts are converted into
   * `displayCurrency` or the workspace's display currency (#191), and
   * amounts in more than one currency without either are 400
   * currency_required.
   */
  dimensions: z
    .record(z.string().min(1).max(100), z.string().max(200))
    .optional(),
  displayCurrency: currencyCodeSchema.optional(),
  /**
   * Also each group's value over the previous window (a table's Δ, ADR
   * 0019 section 6): a second grouped query restricted to the groups
   * returned, with the same aggregation, conversion and currency.
   */
  withPrevious: z.boolean().optional(),
});
export type MetricBreakdownRequest = z.infer<
  typeof metricBreakdownRequestSchema
>;

export const metricBreakdownResponseSchema = z.object({
  metric: workspaceMetricSchema,
  period: metricPeriodSchema,
  timeZone: z.string().min(1),
  aggregation: metricAggregationSchema,
  groupBy: z.string().min(1),
  /**
   * The dimension's name in the request's language, for a column head
   * (a table, ADR 0019): the connector's resource noun for "resource"
   * ("Site", "App"), else the dimension's name ("Territory", "Land").
   */
  groupByName: z.string().min(1),
  /** As in a metric query: the amounts' ISO 4217 code, else null. */
  currency: z.string().nullable(),
  /** As in a metric query; `previousValue` of `unconverted` is null. */
  conversion: currencyConversionSchema.nullable(),
  /**
   * The largest groups over the period's current window, largest first,
   * each the metric's aggregation over its own buckets (a total, an
   * average day, the latest reading). Empty without data.
   */
  groups: z.array(
    z.object({
      /** The dimension value (e.g. a resource id, "DE"). */
      key: z.string(),
      /** A resource's name, a territory's name ("Germany"), else the key. */
      label: z.string().min(1),
      value: z.number(),
      /**
       * With `withPrevious` only: the group's value over the previous
       * window (null without data there) and the change against it (null
       * without a previous value or against zero).
       */
      previousValue: z.number().nullable().optional(),
      ratio: z.number().nullable().optional(),
    }),
  ),
  /**
   * The rest added up: smaller groups, series without the dimension and
   * what the connector already folded into "Others". Null when empty.
   */
  others: z
    .object({
      label: z.string().min(1),
      value: z.number(),
      /** Dimension values it holds (the connector's "Others" counts as one). */
      groups: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type MetricBreakdownResponse = z.infer<
  typeof metricBreakdownResponseSchema
>;

/** The currencies of a "currency_minor" metric, for picking one (ADR 0014). */
export const metricCurrenciesRequestSchema = z.object({
  connectionId: z.uuid(),
  metricKey: z.string().min(1).max(200),
  /** The totals cover the period's current window. */
  period: metricPeriodSchema,
  /** Other dimension filters (at most 10); a "currency" filter is ignored. */
  dimensions: z
    .record(z.string().min(1).max(100), z.string().max(200))
    .optional(),
});
export type MetricCurrenciesRequest = z.infer<
  typeof metricCurrenciesRequestSchema
>;

export const metricCurrenciesResponseSchema = z.object({
  /**
   * Each currency with its own total in minor units over the period, largest
   * first (the default for a tile). Currencies seen only before the period
   * have a total of 0. Totals of different currencies are not comparable
   * amounts; they only order the list.
   */
  currencies: z.array(
    z.object({ currency: z.string().length(3), total: z.number() }),
  ),
});
export type MetricCurrenciesResponse = z.infer<
  typeof metricCurrenciesResponseSchema
>;

/**
 * Whether amounts can be converted into a display currency on this
 * instance, and into which currencies (#191).
 */
export const currencyConversionOptionsResponseSchema = z.object({
  /** False when the instance does not fetch ECB rates; tiles stay exact. */
  enabled: z.boolean(),
  /** EUR and the currencies with recent rates, alphabetical. */
  currencies: z.array(z.string().length(3)),
  /** The last publication day stored; null before the first fetch. */
  latestRateDate: z.iso.date().nullable(),
  source: z.object({ name: z.string().min(1), url: z.url() }),
});
export type CurrencyConversionOptionsResponse = z.infer<
  typeof currencyConversionOptionsResponseSchema
>;

/** The resources a tile of a metric can show (#194). */
export const metricResourcesRequestSchema = z.object({
  connectionId: z.uuid(),
  metricKey: z.string().min(1).max(200),
});
export type MetricResourcesRequest = z.infer<
  typeof metricResourcesRequestSchema
>;

export const metricResourcesResponseSchema = z.object({
  /**
   * The connection's resources (apps, projects, properties) for a tile's
   * "resource" dimension filter: those with data for the metric, and those
   * the connector named. Named first, by name; empty for a metric without
   * a "resource" dimension.
   */
  resources: z.array(
    z.object({
      /** The "resource" dimension value. */
      id: z.string().min(1),
      /** As the provider names it; null until the connector has named it. */
      name: z.string().nullable(),
    }),
  ),
  /**
   * What the connector calls its resources ({ singular: "app", plural:
   * "apps" }), "resource"/"resources" when it does not say (#208).
   */
  resourceNoun: z.object({
    singular: z.string().min(1),
    plural: z.string().min(1),
  }),
});
export type MetricResourcesResponse = z.infer<
  typeof metricResourcesResponseSchema
>;

// ─── Dashboard themes (ADR 0015, section 6; #216) ────────────────────────────

/** A colour as `#rrggbb`; accepted in any case, stored and returned lowercase. */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, { message: "expected a colour like #7aa2f7" })
  .toLowerCase();

export const builtinThemeKeySchema = z.enum(BUILTIN_THEME_KEYS);

export const themeColorTokenSchema = z.enum(THEME_COLOR_TOKENS);

/**
 * The tokens every renderer (web, kiosk, tvOS) draws with. All of them are
 * required; unknown keys are refused, so a typo cannot pass silently.
 */
export const themeTokensSchema = z.strictObject({
  ...(Object.fromEntries(
    THEME_COLOR_TOKENS.map((token) => [token, hexColorSchema]),
  ) as Record<ThemeColorToken, typeof hexColorSchema>),
  /** Multiplies text sizes; never lowers a minimum (ADR 0015, section 8). */
  fontScale: z.union(THEME_FONT_SCALES.map((scale) => z.literal(scale))),
});
export type ThemeTokensInput = z.input<typeof themeTokensSchema>;

/** One text pair of a theme with its WCAG contrast ratio. */
export const themeContrastSchema = z.object({
  foreground: themeColorTokenSchema,
  background: themeColorTokenSchema,
  /** Rounded down to two decimals. */
  ratio: z.number(),
  /** fail: below 3:1 (refused); warn: below 4.5:1; pass otherwise. */
  level: z.enum(["pass", "warn", "fail"]),
});
export type ThemeContrast = z.infer<typeof themeContrastSchema>;

export const builtinThemeSchema = z.object({
  key: builtinThemeKeySchema,
  name: z.string().min(1),
  tokens: themeTokensSchema,
});
export type BuiltinThemeView = z.infer<typeof builtinThemeSchema>;

export const workspaceThemeSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  /** The built-in it was copied from. */
  base: builtinThemeKeySchema,
  tokens: themeTokensSchema,
  /** Send it back with PUT; a newer version on the server answers 409. */
  version: z.number().int().min(1),
  /** Pairs below 4.5:1 (saved themes never go below 3:1). */
  warnings: z.array(themeContrastSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkspaceTheme = z.infer<typeof workspaceThemeSchema>;

export const themeListResponseSchema = z.object({
  builtins: z.array(builtinThemeSchema),
  themes: z.array(workspaceThemeSchema),
});
export type ThemeListResponse = z.infer<typeof themeListResponseSchema>;

export const themeResponseSchema = z.object({ theme: workspaceThemeSchema });
export type ThemeResponse = z.infer<typeof themeResponseSchema>;

/** A copy of a built-in; without tokens, the built-in's own. */
export const createThemeRequestSchema = z.object({
  name: nameSchema,
  base: builtinThemeKeySchema,
  tokens: themeTokensSchema.optional(),
});
export type CreateThemeRequest = z.input<typeof createThemeRequestSchema>;

export const updateThemeRequestSchema = z.object({
  version: z.number().int().min(1),
  name: nameSchema,
  tokens: themeTokensSchema,
});
export type UpdateThemeRequest = z.input<typeof updateThemeRequestSchema>;

/**
 * 400 contrast_too_low: the pairs below 3:1. 409 theme_in_use: the
 * dashboards that still show the theme.
 */
export const themeErrorResponseSchema = errorResponseSchema.extend({
  contrast: z.array(themeContrastSchema).optional(),
  dashboards: z.array(z.object({ id: z.uuid(), name: z.string() })).optional(),
});
export type ThemeErrorResponse = z.infer<typeof themeErrorResponseSchema>;

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
  /**
   * Only series with these dimension values. A "resource" filter shows one
   * of the connection's resources (an app, a project) instead of all added
   * up (#194); it must be a resource of the connection (400
   * unknown_resource).
   */
  dimensions: dimensionFilterSchema.optional(),
  /**
   * Shown instead of the metric name (and the resource name, for a tile of
   * one resource).
   */
  title: z.string().trim().min(1).max(100).nullable().optional(),
  /**
   * A "currency_minor" tile converted into this currency instead of the
   * workspace's display currency (#191). Not with a "currency" filter (400
   * currency_choice_conflict). Null or missing: a "currency" filter shows
   * one currency exactly; without one, the tile follows the workspace.
   */
  displayCurrency: currencyCodeSchema.nullable().optional(),
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
  /** The tile's own display currency (#191), else null. */
  displayCurrency: z.string().nullable(),
  /**
   * Name of the resource the tile shows (its "resource" dimension filter,
   * #194), as the connector reported it. Null for a tile of all resources
   * or a resource without a known name. Read-only.
   */
  resourceName: z.string().nullable(),
  /**
   * For a tile of all resources added up, when its connection has more than
   * one for the metric: their scope, "All apps" (#208), shown after the
   * metric name like a resource name. Null otherwise. Read-only.
   */
  allResourcesName: z.string().nullable(),
});
export type DashboardTile = z.infer<typeof dashboardTileSchema>;

// ─── Dashboard Studio (ADR 0015) ────────────────────────────────────────────
//
// A dashboard is an ordered list of slides, each a grid of widgets in the
// dashboard's primary format (ADR 0017: 12 × 8 for 16x9, the default).
// Bounds, minimum sizes and overlaps are checked by the server against the
// primary format's grid (400 widget_out_of_bounds, widget_too_small,
// widgets_overlap); see slideLayoutProblem in @netrics/domain.

export const widgetTypeSchema = z.enum(WIDGET_TYPES);
export type WidgetType = z.infer<typeof widgetTypeSchema>;

export const slideTransitionSchema = z.enum(SLIDE_TRANSITIONS);

const slideSecondsSchema = z
  .number()
  .int()
  .min(SLIDE_SECONDS.min)
  .max(SLIDE_SECONDS.max);

export const dashboardSettingsSchema = z.object({
  /** The band with name, slide name and clock above the grid. */
  showHeader: z.boolean(),
  /** False: screens show only the first enabled slide. */
  autoAdvance: z.boolean(),
  /** How long a slide without its own duration stays on screen. */
  defaultSlideSeconds: slideSecondsSchema,
  transition: slideTransitionSchema,
  /** A built-in theme key, or null when `themeId` names a custom theme. */
  themeBuiltin: z.string().nullable(),
  /** A custom theme of the workspace, or null for a built-in. */
  themeId: z.uuid().nullable(),
  /** Overrides the theme accent (a brand colour), else null. */
  accentColor: z.string().nullable(),
  /** A workspace image shown in the header before the name (#217). */
  logoImageId: z.uuid().nullable(),
});
export type DashboardSettings = z.infer<typeof dashboardSettingsSchema>;

/**
 * Settings sent with a dashboard; a missing field keeps its value (on
 * create: its default). The theme is a built-in key or a custom theme id,
 * exactly one (the other null or omitted); both omitted keep the theme
 * (netrics Dark on create), and a custom theme must be the workspace's (404
 * theme_not_found). The accent is checked against the theme's surface (400
 * contrast_too_low below 3:1); null clears it.
 */
export const dashboardSettingsInputSchema = dashboardSettingsSchema
  .omit({ themeBuiltin: true, themeId: true, accentColor: true })
  .partial()
  .extend({
    themeBuiltin: builtinThemeKeySchema.nullable().optional(),
    themeId: z.uuid().nullable().optional(),
    accentColor: hexColorSchema.nullable().optional(),
  })
  .refine(
    (body) =>
      (body.themeBuiltin === undefined && body.themeId === undefined) ||
      ((body.themeBuiltin ?? null) === null) !==
        ((body.themeId ?? null) === null),
    { message: "set exactly one of themeBuiltin and themeId" },
  );
export type DashboardSettingsInput = z.input<
  typeof dashboardSettingsInputSchema
>;

/** A screen format (ADR 0017 section 1): an aspect-ratio class with its grid. */
export const screenFormatSchema = z.enum(SCREEN_FORMAT_KEYS);
export type ScreenFormatKey = z.infer<typeof screenFormatSchema>;

/**
 * Cells in the grid of a format: bounded here by the largest grid (16 × 14);
 * the server checks the exact grid (16x9: 12 columns × 8 rows).
 */
const widgetPlacementShape = {
  /** Column of the top left cell (16x9: 0–11). */
  x: z.number().int().min(0).max(SCREEN_FORMAT_MAX_GRID.columns),
  /** Row of the top left cell (16x9: 0–7). */
  y: z.number().int().min(0).max(SCREEN_FORMAT_MAX_GRID.rows),
  /** Width in cells. */
  w: z.number().int().min(1).max(SCREEN_FORMAT_MAX_GRID.columns),
  /** Height in cells. */
  h: z.number().int().min(1).max(SCREEN_FORMAT_MAX_GRID.rows),
};

const layoutPlacementShape = {
  /** A widget of the slide. */
  widgetId: z.uuid(),
  /** 0-based page of the slide in this format (continuation pages). */
  page: z
    .number()
    .int()
    .min(0)
    .max(CUSTOM_LAYOUT_MAX_PAGES - 1),
  ...widgetPlacementShape,
  /** Not shown in this format (listed in the Studio, never dropped silently). */
  hidden: z.boolean(),
  /**
   * Placed by the server after an edit of the primary, for the user to
   * review; false when the user moved, resized or confirmed it.
   */
  autoPlaced: z.boolean(),
};

/**
 * A custom layout of a slide in one format other than the primary (ADR 0017
 * section 4): every widget of the slide placed exactly once or hidden,
 * inside the format's grid, at least its minimum size, no overlaps per page.
 */
export const slideLayoutSchema = z.object({
  format: screenFormatSchema,
  /** 1–8 pages. */
  pages: z.number().int().min(1).max(CUSTOM_LAYOUT_MAX_PAGES),
  /** One per widget of the slide, in the slide's widget order. */
  placements: z.array(z.object(layoutPlacementShape)),
});
export type SlideLayout = z.infer<typeof slideLayoutSchema>;

/**
 * A custom layout as sent. Placements name widgets by the ids sent in the
 * slide's `widgets`; `hidden` and `autoPlaced` default to false. The server
 * checks it (400 layout_invalid_page_count, layout_page_out_of_range,
 * layout_widget_duplicated, layout_widget_out_of_bounds,
 * layout_widget_too_small, layout_widgets_overlap; layout_primary_format
 * and layout_duplicate_format for the list), then completes it as after a
 * primary edit: placements of widgets the slide does not have are dropped,
 * and widgets without one (a new widget has no id yet) are placed
 * automatically and flagged `autoPlaced`. The response has the result.
 */
export const slideLayoutInputSchema = z.object({
  format: screenFormatSchema,
  pages: z.number().int().min(1).max(CUSTOM_LAYOUT_MAX_PAGES),
  placements: z
    .array(
      z.object({
        ...layoutPlacementShape,
        hidden: z.boolean().default(false),
        autoPlaced: z.boolean().default(false),
      }),
    )
    .max(STUDIO_LIMITS.widgetsPerSlide),
});
export type SlideLayoutInput = z.input<typeof slideLayoutInputSchema>;

/**
 * A readability warning of a slide in a format (ADR 0017 section 6),
 * computed on every read for every format, auto or custom: label_cut (a
 * data widget's title or resource line needs more than two lines),
 * text_cut (a text widget's text does not fit even at body size),
 * continues (the slide takes `pages` pages), widget_hidden,
 * widget_to_review (placed automatically in a custom layout),
 * widget_too_small (a custom placement below the minimum),
 * header_name_cut (the dashboard name does not fit the header) and
 * clock_parts_hidden (a clock's date or zone line is left out for room,
 * info). Read-only.
 */
export const formatWarningSchema = z.object({
  format: screenFormatSchema,
  code: z.enum(FORMAT_WARNING_CODES),
  /**
   * attention: cut off, too small or to review (the Studio counts the
   * formats with any); info: continuation pages, hidden widgets and clock
   * lines left out.
   */
  severity: z.enum(["attention", "info"]),
  /** The widget concerned, or null for the slide (pages, header). */
  widgetId: z.uuid().nullable(),
  /** continues: the number of pages; else null. */
  pages: z.number().int().min(2).nullable(),
  /**
   * rows_cut (ADR 0019): the rows a table shows in the format of the rows
   * it asks for ("Shows 4 of 8 rows"); else null.
   */
  rows: z
    .object({
      shown: z.number().int().nonnegative(),
      limit: z.number().int().positive(),
    })
    .nullable(),
});
export type FormatWarning = z.infer<typeof formatWarningSchema>;

const widgetTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(STUDIO_LIMITS.widgetTitleLength);

const alignSchema = z.enum(["start", "center", "end"]);

export const metricWidgetOptionsSchema = z.object({
  showSparkline: z.boolean().default(true),
  showChange: z.boolean().default(true),
});
export const lineWidgetOptionsSchema = z.object({
  /** The previous period, dashed. */
  showPrevious: z.boolean().default(true),
  showAxis: z.boolean().default(true),
});
export const barWidgetOptionsSchema = z.object({
  /** A dimension of the metric, e.g. "resource" or "territory". */
  groupBy: z.string().min(1).max(100),
  /** Bars shown, the rest add up to "Other". */
  limit: z.number().int().min(3).max(10).default(5),
});
/** A table (ADR 0019 section 6): one metric by a dimension, ranked. */
export const tableWidgetOptionsSchema = z.object({
  /** A dimension of the metric, e.g. "route" or "territory"; not currency. */
  groupBy: z.string().min(1).max(100),
  /** Rows asked for; a screen shows those that fit and says how many. */
  limit: z.number().int().min(3).max(10).default(5),
  /** The Δ column: each row against the previous period. */
  showChange: z.boolean().default(true),
  /** A last, dimmed "Others" row with the rest added up. */
  showOthers: z.boolean().default(false),
});
export const textWidgetOptionsSchema = z.object({
  size: z.enum(["body", "heading", "display"]).default("body"),
  align: alignSchema.default("start"),
});
export const imageWidgetOptionsSchema = z.object({
  /** contain: the whole image; cover: fills the widget, cropped. */
  fit: z.enum(["contain", "cover"]).default("contain"),
  align: alignSchema.default("center"),
});
export const clockWidgetOptionsSchema = z.object({
  showDate: z.boolean().default(true),
  hour12: z.boolean().default(false),
  /** IANA time zone; null shows the workspace's. */
  timeZone: timeZoneSchema.nullable().default(null),
  /**
   * short: "Sat 4 Oct"; long: "Saturday, 4 October" (ADR 0019 §9). Older
   * screens ignore it and show the short date.
   */
  dateStyle: z.enum(["short", "long"]).default("short"),
  /** A zone line below the date: "Berlin · UTC+2". Older screens ignore it. */
  showZone: z.boolean().default(false),
});

/** The metric a data widget shows, validated like a tile's. */
const dataBindingInputShape = {
  connectionId: z.uuid(),
  metricKey: z.string().min(1).max(200),
  /** Defaults to the metric's first compatible aggregation. */
  aggregation: metricAggregationSchema.optional(),
  period: metricPeriodSchema,
  /** As a tile's; "resource" shows one resource of the connection. */
  dimensions: dimensionFilterSchema.optional(),
  /** As a tile's (#191). */
  displayCurrency: currencyCodeSchema.nullable().optional(),
};

const widgetInputShape = {
  /**
   * A widget of this dashboard keeps its id; a missing or unknown id gets
   * a new one.
   */
  id: z.uuid().optional(),
  ...widgetPlacementShape,
  /** Shown instead of the default label. */
  title: widgetTitleSchema.nullable().optional(),
};

export const dashboardWidgetInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("metric"),
    ...widgetInputShape,
    ...dataBindingInputShape,
    options: metricWidgetOptionsSchema.prefault({}),
  }),
  z.object({
    type: z.literal("line"),
    ...widgetInputShape,
    ...dataBindingInputShape,
    options: lineWidgetOptionsSchema.prefault({}),
  }),
  z.object({
    type: z.literal("bar"),
    ...widgetInputShape,
    ...dataBindingInputShape,
    options: barWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("table"),
    ...widgetInputShape,
    ...dataBindingInputShape,
    options: tableWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("image"),
    ...widgetInputShape,
    /** An image of this workspace (GET /v1/workspaces/:w/images). */
    imageId: z.uuid(),
    options: imageWidgetOptionsSchema.prefault({}),
  }),
  z.object({
    type: z.literal("text"),
    ...widgetInputShape,
    /** Markdown-lite: paragraphs, #/## headings, **bold**, *italic*. */
    text: z.string().min(1).max(STUDIO_LIMITS.textLength),
    options: textWidgetOptionsSchema.prefault({}),
  }),
  z.object({
    type: z.literal("clock"),
    ...widgetInputShape,
    options: clockWidgetOptionsSchema.prefault({}),
  }),
]);
export type DashboardWidgetInput = z.input<typeof dashboardWidgetInputSchema>;
export type DashboardWidgetInputParsed = z.infer<
  typeof dashboardWidgetInputSchema
>;

/** A workspace image behind a slide's widgets, dimmed for contrast. */
export const slideBackgroundSchema = z.object({
  imageId: z.uuid(),
  /** Percent of theme background laid over the image, 0–80. */
  dim: z
    .number()
    .int()
    .min(BACKGROUND_DIM.min)
    .max(BACKGROUND_DIM.max)
    .default(BACKGROUND_DIM.default),
});
export type SlideBackground = z.infer<typeof slideBackgroundSchema>;

export const dashboardSlideInputSchema = z.object({
  /**
   * A slide of this dashboard keeps its id; a missing or unknown id gets a
   * new one.
   */
  id: z.uuid().optional(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(STUDIO_LIMITS.slideNameLength)
    .nullable()
    .optional(),
  /** Null or missing: the dashboard's defaultSlideSeconds. */
  durationSeconds: slideSecondsSchema.nullable().optional(),
  /** Screens skip disabled slides. Default true. */
  enabled: z.boolean().optional(),
  /** A full-slide image behind the widgets; null or missing: none. */
  background: slideBackgroundSchema.nullable().optional(),
  widgets: z
    .array(dashboardWidgetInputSchema)
    .max(STUDIO_LIMITS.widgetsPerSlide),
  /**
   * Custom layouts, one per format other than the primary; formats not
   * listed are auto. Missing: the slide keeps its stored custom layouts (a
   * client from before ADR 0017); an empty list makes every format auto.
   */
  layouts: z
    .array(slideLayoutInputSchema)
    .max(SCREEN_FORMAT_KEYS.length - 1)
    .optional(),
});
export type DashboardSlideInput = z.input<typeof dashboardSlideInputSchema>;

const widgetShape = {
  id: z.uuid(),
  ...widgetPlacementShape,
  title: z.string().nullable(),
};

const dataBindingShape = {
  connectionId: z.uuid(),
  metricKey: z.string().min(1),
  aggregation: metricAggregationSchema,
  period: metricPeriodSchema,
  dimensions: z.record(z.string(), z.string()),
  displayCurrency: z.string().nullable(),
  /** As on a tile (#194). Read-only. */
  resourceName: z.string().nullable(),
  /** As on a tile (#208). Read-only. */
  allResourcesName: z.string().nullable(),
};

export const dashboardWidgetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("metric"),
    ...widgetShape,
    ...dataBindingShape,
    options: metricWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("line"),
    ...widgetShape,
    ...dataBindingShape,
    options: lineWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("bar"),
    ...widgetShape,
    ...dataBindingShape,
    options: barWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("table"),
    ...widgetShape,
    ...dataBindingShape,
    options: tableWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("image"),
    ...widgetShape,
    imageId: z.uuid(),
    options: imageWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("text"),
    ...widgetShape,
    text: z.string(),
    options: textWidgetOptionsSchema,
  }),
  z.object({
    type: z.literal("clock"),
    ...widgetShape,
    options: clockWidgetOptionsSchema,
  }),
]);
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

export const dashboardSlideSchema = z.object({
  id: z.uuid(),
  position: z.number().int().min(0),
  name: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  enabled: z.boolean(),
  background: slideBackgroundSchema.nullable(),
  /** In reading order: top to bottom, then left to right. */
  widgets: z.array(dashboardWidgetSchema),
  /** Custom layouts by format; formats not listed (and the primary) are auto. */
  layouts: z.array(slideLayoutSchema),
  /**
   * Readability warnings per format, every format in turn (widest first),
   * then the slide's and its widgets' in reading order (ADR 0017 §6).
   * Read-only; ignored on PUT.
   */
  formatWarnings: z.array(formatWarningSchema),
});
export type DashboardSlide = z.infer<typeof dashboardSlideSchema>;

export const dashboardSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  projectId: z.uuid().nullable(),
  /** Send it back with PUT; a newer version on the server answers 409. */
  version: z.number().int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  settings: dashboardSettingsSchema,
  /**
   * The format widgets are placed in (ADR 0017 section 4); every other
   * format is auto or a custom layout of the slide. Default 16x9.
   */
  primaryFormat: screenFormatSchema,
  slides: z.array(dashboardSlideSchema),
  /**
   * The metric widgets of all slides in reading order, as tiles. Kept for
   * one release while clients move to `slides` (ADR 0015 section 3).
   */
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
      /** Metric widgets. */
      tileCount: z.number().int().min(0),
      slideCount: z.number().int().min(0),
      widgetCount: z.number().int().min(0),
      updatedAt: z.iso.datetime(),
      /**
       * The theme shown (#304): a built-in key (named in the reader's
       * language) or a custom theme of the workspace, with its name.
       */
      theme: z.object({
        builtin: builtinThemeKeySchema.nullable(),
        id: z.uuid().nullable(),
        name: z.string().min(1),
      }),
      /** The brand accent, else the theme's accent. */
      accent: hexColorSchema,
      primaryFormat: screenFormatSchema,
      /** Screens (not revoked) that show this dashboard. */
      screenCount: z.number().int().min(0),
      /**
       * A thumbnail of the first enabled slide: the theme's colours and
       * its widgets on the primary format's grid (none without one).
       */
      preview: z.object({
        background: hexColorSchema,
        surface: hexColorSchema,
        border: hexColorSchema,
        widgets: z.array(
          z.object({
            type: widgetTypeSchema,
            x: z.number().int().min(0),
            y: z.number().int().min(0),
            w: z.number().int().min(1),
            h: z.number().int().min(1),
          }),
        ),
      }),
    }),
  ),
});
export type DashboardListResponse = z.infer<typeof dashboardListResponseSchema>;

const dashboardSlidesInputSchema = z
  .array(dashboardSlideInputSchema)
  .max(STUDIO_LIMITS.slides);

const notTilesAndSlides = (body: { tiles?: unknown; slides?: unknown }) =>
  body.tiles === undefined || body.slides === undefined;

/**
 * A new dashboard from `slides` (without them: one empty slide), or from
 * legacy `tiles`, laid out like the TV grid.
 */
export const createDashboardRequestSchema = z
  .object({
    name: nameSchema,
    projectId: z.uuid().nullable().optional(),
    settings: dashboardSettingsInputSchema.optional(),
    /** The format `slides` are placed in; default 16x9. */
    primaryFormat: screenFormatSchema.optional(),
    slides: dashboardSlidesInputSchema.optional(),
    /** Legacy; not together with `slides`. */
    tiles: z
      .array(dashboardTileInputSchema)
      .max(MAX_DASHBOARD_TILES)
      .optional(),
  })
  .refine(notTilesAndSlides, { message: "tiles or slides, not both" });
export type CreateDashboardRequest = z.infer<
  typeof createDashboardRequestSchema
>;

/**
 * Replaces name, project, settings, slides and widgets in one step. The
 * legacy form sends `tiles` instead of `slides`: it works on a dashboard of
 * metric widgets in the automatic layout and answers 409 studio_dashboard
 * otherwise, so an old client cannot flatten a studio dashboard.
 *
 * Widgets are placed in the dashboard's current primary format. A different
 * `primaryFormat` re-bases the dashboard after the save (ADR 0017 section
 * 4): the old primary layout becomes a custom layout of its format and the
 * chosen format's layout (custom, or auto) becomes the primary; 409
 * format_has_overflow when that layout has continuation pages, or
 * format_has_hidden_widgets when it hides widgets. Missing: unchanged.
 */
export const replaceDashboardRequestSchema = z
  .object({
    version: z.number().int().min(1),
    name: nameSchema,
    projectId: z.uuid().nullable(),
    settings: dashboardSettingsInputSchema.optional(),
    /** Missing: unchanged. See above for a change. */
    primaryFormat: screenFormatSchema.optional(),
    slides: dashboardSlidesInputSchema.optional(),
    /** Legacy; exactly one of `tiles` and `slides`. */
    tiles: z
      .array(dashboardTileInputSchema)
      .max(MAX_DASHBOARD_TILES)
      .optional(),
  })
  .refine(
    (body) =>
      notTilesAndSlides(body) && (body.tiles ?? body.slides) !== undefined,
    { message: "tiles or slides" },
  );
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
// Dashboard templates (ADR 0015 section 9, #226)
// ---------------------------------------------------------------------------

export const DASHBOARD_TEMPLATES = ["overview", "brand"] as const;
export const dashboardTemplateSchema = z.enum(DASHBOARD_TEMPLATES);
export type DashboardTemplate = z.infer<typeof dashboardTemplateSchema>;

/**
 * A new dashboard generated on the server. Overview: the numbers of every
 * connection the workspace has (downloads of all apps, proceeds, reviews
 * with a reviews key, Search Console clicks and impressions, Vercel
 * visitors). Brand: one resource (an app, a project, a property) with its
 * icon as the logo, an accent colour and its own numbers. The result is an
 * ordinary dashboard (409 none_connected when nothing can be shown).
 */
export const createDashboardFromTemplateRequestSchema = z.discriminatedUnion(
  "template",
  [
    z.object({
      template: z.literal("overview"),
      /** Default "Overview". */
      name: nameSchema.optional(),
    }),
    z.object({
      template: z.literal("brand"),
      connectionId: z.uuid(),
      resourceId: z.string().min(1).max(200),
      /** Default: the resource's name. */
      name: nameSchema.optional(),
      /**
       * The brand colour (checked against the theme surface: 400
       * contrast_too_low below 3:1); null or missing: the theme accent.
       */
      accentColor: hexColorSchema.nullable().optional(),
      /**
       * The logo; missing: the resource's icon when its connector has one
       * (fetched now if needed), null: no logo.
       */
      logoImageId: z.uuid().nullable().optional(),
    }),
  ],
);
export type CreateDashboardFromTemplateRequest = z.infer<
  typeof createDashboardFromTemplateRequestSchema
>;

const templateSourceSchema = z.object({
  connectionId: z.uuid(),
  connectionName: z.string(),
  connectorId: z.string(),
});

/** What the templates can be built from in this workspace. */
export const dashboardTemplateOptionsResponseSchema = z.object({
  overview: z.object({
    /** The connections the Overview shows; empty: it cannot be made. */
    sources: z.array(templateSourceSchema),
  }),
  brand: z.object({
    /** Resources a Brand dashboard can be made for. */
    resources: z.array(
      templateSourceSchema.extend({
        resourceId: z.string().min(1),
        name: z.string(),
        kind: z.string(),
        /** The connector can fetch this resource's icon. */
        iconSupported: z.boolean(),
      }),
    ),
  }),
});
export type DashboardTemplateOptionsResponse = z.infer<
  typeof dashboardTemplateOptionsResponseSchema
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
  /**
   * Device dashboard payload schemas this server answers (ADR 0015 section
   * 7). An app asks for `?schema=2` only when 2 is listed; servers before
   * it omit the field and answer schema 1.
   */
  dashboardSchemas: z.array(z.number().int().positive()),
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

// Screen settings and reporting (ADR 0017 section 7, #276).

/**
 * Degrees the device turns its whole rendering, clockwise: 90 and 270 for
 * a TV mounted on its side, 180 for one mounted upside down.
 */
export const DEVICE_ROTATIONS = [0, 90, 180, 270] as const;
export const deviceRotationSchema = z.literal(DEVICE_ROTATIONS);
export type DeviceRotation = z.infer<typeof deviceRotationSchema>;

/**
 * "screen": fits the screen, rotates slides, never scrolls (the default,
 * and always on tvOS). "scroll": one scrolling column (browser kiosks).
 */
export const DISPLAY_MODES = ["screen", "scroll"] as const;
export const displayModeSchema = z.enum(DISPLAY_MODES);
export type DisplayMode = z.infer<typeof displayModeSchema>;

/** Largest screen side a device may report, in CSS px or points. */
export const MAX_SCREEN_SIDE = 16_384;

/**
 * A device's screen as it reports it in the heartbeat: the size after its
 * rotation setting (CSS px or points), the device pixel ratio, and the
 * format and mode it shows. Unknown keys are dropped.
 */
export const deviceScreenSchema = z.object({
  width: z.number().int().min(1).max(MAX_SCREEN_SIDE),
  height: z.number().int().min(1).max(MAX_SCREEN_SIDE),
  scale: z.number().min(0.5).max(8),
  /** Absent when the client does not know the formats yet. */
  format: screenFormatSchema.optional(),
  mode: displayModeSchema,
});
export type DeviceScreen = z.infer<typeof deviceScreenSchema>;

export const deviceSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  dashboardId: z.uuid().nullable(),
  rotation: deviceRotationSchema,
  displayMode: displayModeSchema,
  /** The screen of the latest heartbeat that reported one; null before. */
  screen: deviceScreenSchema.nullable(),
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
    /** Screen settings (#276); older apps ignore them. */
    rotation: deviceRotationSchema,
    displayMode: displayModeSchema,
  }),
});
export type DeviceSelfResponse = z.infer<typeof deviceSelfResponseSchema>;

export const updateDeviceRequestSchema = z
  .object({
    name: nameSchema.optional(),
    dashboardId: z.uuid().nullable().optional(),
    rotation: deviceRotationSchema.optional(),
    displayMode: displayModeSchema.optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.dashboardId !== undefined ||
      body.rotation !== undefined ||
      body.displayMode !== undefined,
    { message: "nothing to change" },
  );
export type UpdateDeviceRequest = z.infer<typeof updateDeviceRequestSchema>;

// The device dashboard read model and heartbeat (ADR 0007, #57).

/** How often a device should ask again (ADR 0007: 60 s refresh target). */
export const DEVICE_REFRESH_AFTER_SECONDS = 60;

/**
 * How a tile's numbers can be trusted:
 * ok (fresh), stale (last sync too long ago, or none yet), auth_failed and
 * outage (the connection is failing), no_data (nothing to show),
 * backfilling (nothing to show yet: the connection's first sync or a
 * backfill of its history is queued or running; #311).
 *
 * `backfilling` is newer than the first screens. Clients decode a status
 * they do not know without failing (tvOS since its first release, #120:
 * OpenAPIEnum falls back to `ok`, which renders exactly as `no_data`: no
 * notice, no value), so every schema carries it.
 */
export const deviceTileStatusSchema = z.enum([
  "ok",
  "stale",
  "auth_failed",
  "outage",
  "no_data",
  "backfilling",
]);
export type DeviceTileStatus = z.infer<typeof deviceTileStatusSchema>;

export const deviceTileSchema = z.object({
  id: z.uuid(),
  /**
   * The tile title, else the metric name, followed by the resource name for
   * a tile of one resource ("Downloads · Wurfel", #194) or by the scope of a
   * tile that adds up several ("Downloads · All apps", #208).
   */
  label: z.string().min(1),
  period: metricPeriodSchema,
  aggregation: metricAggregationSchema,
  /** Raw number; the client formats it with `unit`. Null without data. */
  value: z.number().nullable(),
  /**
   * E.g. "count", "percent", or "<ISO 4217>_minor" for currency amounts in
   * integer minor units (ADR 0008). A tile of a "currency_minor" metric
   * reports its currency's "<ISO 4217>_minor" here (ADR 0014), so screens
   * need nothing new. Null when the tile could not load.
   */
  unit: z.string().nullable(),
  /**
   * Set when the amounts were converted into a display currency (#191):
   * screens show the value as approximate ("≈") and cite the source. The
   * label is not changed. Null for exact values.
   */
  conversion: z
    .object({
      displayCurrency: z.string().length(3),
      source: z.string().min(1),
      /** Amounts left unconverted, in their own minor units. */
      unconverted: z.array(
        z.object({
          currency: z.string().length(3),
          value: z.number().nullable(),
        }),
      ),
    })
    .nullable(),
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

/**
 * The language of a device payload's labels (ADR 0016 section 3), a
 * language tag such as "de". Screens format numbers, dates and their own
 * text in it, and fall back to English for a language they do not know.
 */
export const deviceLocaleSchema = z.string().regex(/^[a-z]{2,3}$/);

export const deviceDashboardResponseSchema = z.object({
  /** Hash of the content below; also the ETag. */
  version: z.string().min(1),
  refreshAfterSec: z.number().int().positive(),
  /** The workspace's time zone, which the buckets follow. */
  timeZone: z.string().min(1),
  /** Null when no dashboard is assigned; tiles is then empty. */
  dashboard: z.object({ id: z.uuid(), name: z.string().min(1) }).nullable(),
  tiles: z.array(deviceTileSchema),
  /**
   * The language the labels are in (ADR 0016): the workspace's screen
   * language. Present only when it is not English, so an English payload
   * stays byte for byte what screens got before; absent means "en".
   */
  locale: deviceLocaleSchema.optional(),
});
export type DeviceDashboardResponse = z.infer<
  typeof deviceDashboardResponseSchema
>;

// ─── Device payload schema 2 (ADR 0015, section 7; #219) ────────────────────
//
// GET /v1/device/dashboard?schema=2. Everything a screen needs to render the
// dashboard's enabled slides without further calls, except the image bytes
// (GET /v1/device/images/:id?v=<sha256>). Without the parameter the endpoint
// answers schema 1 (`deviceDashboardResponseSchema`), unchanged.

/** The payload schemas this server answers (`dashboardSchemas` in server info). */
export const DEVICE_DASHBOARD_SCHEMAS = [1, 2, 3] as const;

export const deviceDashboardQuerySchema = z.object({
  /** "3" for schema 3, "2" for schema 2; missing or "1" for schema 1. */
  schema: z.enum(["1", "2", "3"]).optional(),
});
export type DeviceDashboardQuery = z.infer<typeof deviceDashboardQuerySchema>;

/** As a tile's `conversion` (#191). */
const deviceConversionSchema = deviceTileSchema.shape.conversion;

/** What every data widget reports about its metric, as a tile does. */
const deviceWidgetDataShape = {
  period: metricPeriodSchema,
  aggregation: metricAggregationSchema,
  /** As a tile's: "count", "<ISO 4217>_minor", …; null when it failed. */
  unit: z.string().nullable(),
  conversion: deviceConversionSchema,
  kind: z.enum(METRIC_KINDS).nullable(),
  granularity: z.enum(GRANULARITIES).nullable(),
  better: metricBetterSchema,
  /**
   * As a tile's. A widget whose query failed is `no_data` (or its
   * connection's failure) and never fails the payload.
   */
  status: deviceTileStatusSchema,
  /** The connection's last successful sync. */
  updatedAt: z.iso.datetime().nullable(),
};

/** A metric widget's data: a schema 1 tile without id and label. */
export const deviceMetricDataSchema = z.object({
  ...deviceWidgetDataShape,
  value: z.number().nullable(),
  change: deviceTileSchema.shape.change,
  /** One point per bucket of the current period, oldest first; null = gap. */
  spark: z.array(z.number().nullable()),
});
export type DeviceMetricData = z.infer<typeof deviceMetricDataSchema>;

/**
 * A line widget's data: the period's points and the previous period's,
 * aligned. `buckets[i]` starts point i (hour, day, week or month, at most
 * 31 points); `values[i]` is its value and `previous[i]` the same bucket of
 * the previous period (empty when the widget hides it). Null is a gap.
 */
export const deviceLineDataSchema = z.object({
  ...deviceWidgetDataShape,
  value: z.number().nullable(),
  change: deviceTileSchema.shape.change,
  buckets: z.array(z.iso.datetime()),
  values: z.array(z.number().nullable()),
  previous: z.array(z.number().nullable()),
});
export type DeviceLineData = z.infer<typeof deviceLineDataSchema>;

/** A bar widget's data: the largest groups, largest first, and the rest. */
export const deviceBarDataSchema = z.object({
  ...deviceWidgetDataShape,
  /** The dimension grouped by (e.g. "resource", "territory"). */
  groupBy: z.string().min(1),
  bars: z.array(
    z.object({
      /** The dimension value. */
      key: z.string(),
      /** A resource's or territory's name, else the key. */
      label: z.string().min(1),
      value: z.number(),
    }),
  ),
  /** The rest added up ("Others"); null when there is none. */
  others: z
    .object({
      label: z.string().min(1),
      value: z.number(),
      groups: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type DeviceBarData = z.infer<typeof deviceBarDataSchema>;

/**
 * A table widget's data (ADR 0019 section 6): the largest groups, largest
 * first, each with its value over the previous window, and the rest.
 */
export const deviceTableDataSchema = z.object({
  ...deviceWidgetDataShape,
  /** The dimension grouped by (e.g. "route", "territory"). */
  groupBy: z.string().min(1),
  /** The column heads in the payload's language: dimension and metric. */
  columns: z.object({ label: z.string().min(1), value: z.string().min(1) }),
  rows: z.array(
    z.object({
      /** The dimension value. */
      key: z.string(),
      /** A resource's or territory's name, else the key. */
      label: z.string().min(1),
      value: z.number(),
      /** Over the previous window; null without data there. */
      previousValue: z.number().nullable(),
      /** The change; null without a previous value, or against zero. */
      ratio: z.number().nullable(),
    }),
  ),
  /** The rest added up ("Others") with `showOthers`; else null. */
  others: z
    .object({
      label: z.string().min(1),
      value: z.number(),
      groups: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type DeviceTableData = z.infer<typeof deviceTableDataSchema>;

/** A widget's id and placement in a grid of `columns` × `rows`. */
function deviceWidgetPlacementShape(grid: { columns: number; rows: number }) {
  return {
    id: z.uuid(),
    /** Grid cell of the top left corner and size in cells. */
    x: z.number().int().min(0).max(grid.columns),
    y: z.number().int().min(0).max(grid.rows),
    w: z.number().int().min(1).max(grid.columns),
    h: z.number().int().min(1).max(grid.rows),
  };
}

/**
 * A data widget's label: its title, else the metric name with the
 * resource ("Downloads · Wurfel", #194) or scope ("Downloads · All apps",
 * #208), exactly as a schema 1 tile's.
 */
const deviceDataLabelSchema = z.string().min(1);

/**
 * A widget type's minimum size (schema 3, ADR 0019 section 2): a screen
 * that does not know the type reflows it with this one.
 */
const deviceWidgetMinSchema = z.object({
  w: z.number().int().min(1),
  h: z.number().int().min(1),
});

/**
 * The widget union with placements in the given grid, every widget with
 * the `extra` fields (schema 3: its type's minimum size).
 */
function deviceWidgetUnion<E extends z.ZodRawShape>(
  grid: { columns: number; rows: number },
  extra: E,
) {
  const deviceWidgetShape = {
    ...deviceWidgetPlacementShape(grid),
    ...extra,
  };
  return z.discriminatedUnion("type", [
    z.object({
      type: z.literal("metric"),
      ...deviceWidgetShape,
      label: deviceDataLabelSchema,
      options: metricWidgetOptionsSchema,
      data: deviceMetricDataSchema,
    }),
    z.object({
      type: z.literal("line"),
      ...deviceWidgetShape,
      label: deviceDataLabelSchema,
      options: lineWidgetOptionsSchema,
      data: deviceLineDataSchema,
    }),
    z.object({
      type: z.literal("bar"),
      ...deviceWidgetShape,
      label: deviceDataLabelSchema,
      options: barWidgetOptionsSchema,
      data: deviceBarDataSchema,
    }),
    z.object({
      type: z.literal("table"),
      ...deviceWidgetShape,
      label: deviceDataLabelSchema,
      options: tableWidgetOptionsSchema,
      data: deviceTableDataSchema,
    }),
    z.object({
      type: z.literal("image"),
      ...deviceWidgetShape,
      /** The widget's title (alternative text), else null. */
      label: z.string().nullable(),
      /** One of the payload's `images`. */
      imageId: z.uuid(),
      options: imageWidgetOptionsSchema,
    }),
    z.object({
      type: z.literal("text"),
      ...deviceWidgetShape,
      label: z.string().nullable(),
      /** Markdown-lite (ADR 0015 section 2); never interpreted as HTML. */
      text: z.string(),
      options: textWidgetOptionsSchema,
    }),
    z.object({
      type: z.literal("clock"),
      ...deviceWidgetShape,
      label: z.string().nullable(),
      /**
       * `timeZone` resolved: the widget's, else the workspace's.
       * `dateStyle` and `showZone` are sent only when set (long, true), so
       * the payload and its version of an existing clock stay as they were;
       * absent means short and false.
       */
      options: clockWidgetOptionsSchema.extend({
        timeZone: z.string().min(1),
        dateStyle: z.enum(["short", "long"]).optional(),
        showZone: z.boolean().optional(),
      }),
    }),
  ]);
}

/** A schema 2 widget: placed in the 12 × 8 grid of the `16x9` layout. */
export const deviceWidgetSchema = deviceWidgetUnion(STUDIO_GRID, {});
export type DeviceWidget = z.infer<typeof deviceWidgetSchema>;

export const deviceSlideSchema = z.object({
  /** Stable across saves: keep showing it when a new payload still has it. */
  id: z.uuid(),
  /** Shown in the header; null for none. */
  name: z.string().nullable(),
  /** The slide's duration, else the dashboard default. */
  durationSec: z.number().int().positive(),
  /** One of the payload's `images`, dimmed by `dim` % of `background`. */
  background: z
    .object({
      imageId: z.uuid(),
      dim: z.number().int().min(BACKGROUND_DIM.min).max(BACKGROUND_DIM.max),
    })
    .nullable(),
  /** In reading order: top to bottom, then left to right. */
  widgets: z.array(deviceWidgetSchema),
});
export type DeviceSlide = z.infer<typeof deviceSlideSchema>;

/** An image the payload references; fetch `url` with the device token. */
export const deviceImageSchema = z.object({
  id: z.uuid(),
  /** Cache key: the bytes never change under one hash. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: imageContentTypeSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
  /** Relative: /v1/device/images/:id?v=<sha256>. */
  url: z.string().min(1),
});
export type DeviceImage = z.infer<typeof deviceImageSchema>;

export const deviceDashboardV2ResponseSchema = z.object({
  /** Hash of the content below (schema included); also the ETag. */
  version: z.string().min(1),
  schema: z.literal(2),
  refreshAfterSec: z.number().int().positive(),
  /** The workspace's time zone, which the buckets follow. */
  timeZone: z.string().min(1),
  /**
   * The language the labels are in: the workspace's screen language, else
   * the instance default, else "en" (ADR 0016). Servers before it omit it.
   */
  locale: deviceLocaleSchema.optional(),
  /** Null when no dashboard is assigned; `slides` is then empty. */
  dashboard: z
    .object({
      id: z.uuid(),
      name: z.string().min(1),
      /** The band with name, slide name and clock above the grid. */
      showHeader: z.boolean(),
      /** Shown in the header before the name; one of `images`. */
      logo: z.object({ imageId: z.uuid() }).nullable(),
    })
    .nullable(),
  /**
   * The resolved theme (built-in or custom), with a brand accent already
   * applied to `accent`. Screens draw with these tokens only.
   */
  theme: z.object({ name: z.string().min(1), tokens: themeTokensSchema }),
  rotation: z.object({
    /** False: show only the first slide. */
    autoAdvance: z.boolean(),
    transition: slideTransitionSchema,
  }),
  grid: z.object({
    columns: z.literal(STUDIO_GRID.columns),
    rows: z.literal(STUDIO_GRID.rows),
  }),
  /** Enabled slides only, in order. */
  slides: z.array(deviceSlideSchema),
  /** Exactly the images the dashboard, its slides and widgets reference. */
  images: z.array(deviceImageSchema),
});
export type DeviceDashboardV2Response = z.infer<
  typeof deviceDashboardV2ResponseSchema
>;

// ─── Device payload schema 3 (ADR 0017, section 9; #277) ────────────────────
//
// GET /v1/device/dashboard?schema=3. Schema 2's content for every screen
// alike: the primary layout and the custom layouts of other formats. Each
// screen picks its format (`formatFor`) and lays a slide out itself
// (`slideLayoutFor` / `reflowSlide`), so the payload does not depend on the
// screen and a screen that turns re-lays out offline. Schema 2 is the same
// dashboard reduced to the `16x9` layout, for screens that know no formats.

/** A widget placed in the primary format's grid. */
export const deviceWidgetV3Schema = deviceWidgetUnion(SCREEN_FORMAT_MAX_GRID, {
  min: deviceWidgetMinSchema,
});
export type DeviceWidgetV3 = z.infer<typeof deviceWidgetV3Schema>;

/** A widget's place in a custom layout, as screens get it. */
export const deviceLayoutPlacementSchema = z.object({
  /** One of the slide's `widgets`. */
  widgetId: z.uuid(),
  /** 0-based page (continuation pages). */
  page: z
    .number()
    .int()
    .min(0)
    .max(CUSTOM_LAYOUT_MAX_PAGES - 1),
  ...widgetPlacementShape,
  /** Not shown in this format. */
  hidden: z.boolean(),
});
export type DeviceLayoutPlacement = z.infer<typeof deviceLayoutPlacementSchema>;

/**
 * A slide's custom layout in one format other than the primary. Formats
 * not listed are auto: the screen reflows the primary placements.
 */
export const deviceSlideLayoutSchema = z.object({
  format: screenFormatSchema,
  pages: z.number().int().min(1).max(CUSTOM_LAYOUT_MAX_PAGES),
  /** For the slide's widgets in this payload, in the slide's widget order. */
  placements: z.array(deviceLayoutPlacementSchema),
});
export type DeviceSlideLayout = z.infer<typeof deviceSlideLayoutSchema>;

export const deviceSlideV3Schema = deviceSlideSchema.extend({
  /** In reading order of the primary layout, placed in its grid. */
  widgets: z.array(deviceWidgetV3Schema),
  /** Custom formats only, in the fixed format order. */
  layouts: z.array(deviceSlideLayoutSchema),
});
export type DeviceSlideV3 = z.infer<typeof deviceSlideV3Schema>;

/** A format's grid and reference canvas ([width, height], ADR 0017 §1). */
export const deviceFormatSchema = z.object({
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  reference: z.tuple([
    z.number().int().positive(),
    z.number().int().positive(),
  ]),
});
export type DeviceFormat = z.infer<typeof deviceFormatSchema>;

const v2Shape = deviceDashboardV2ResponseSchema.shape;

export const deviceDashboardV3ResponseSchema = z.object({
  /** Hash of the content below (device settings included); also the ETag. */
  version: z.string().min(1),
  schema: z.literal(3),
  refreshAfterSec: v2Shape.refreshAfterSec,
  timeZone: v2Shape.timeZone,
  /** The language the labels are in (ADR 0016). */
  locale: deviceLocaleSchema,
  /** The format the dashboard is designed in; widgets are placed in it. */
  primaryFormat: screenFormatSchema,
  /** Every format's grid, so screens need no table of their own. */
  formats: z.object({
    "16x9": deviceFormatSchema,
    "21x9": deviceFormatSchema,
    "4x3": deviceFormatSchema,
    "3x4": deviceFormatSchema,
    "9x16": deviceFormatSchema,
  }),
  /**
   * This device's settings (#276): the screen rotates its whole rendering
   * by `rotation` degrees before choosing its format; `displayMode` is for
   * kiosks (tvOS is always screen view).
   */
  device: z.object({
    rotation: deviceRotationSchema,
    displayMode: displayModeSchema,
  }),
  dashboard: v2Shape.dashboard,
  theme: v2Shape.theme,
  rotation: v2Shape.rotation,
  /** Enabled slides only, in order. */
  slides: z.array(deviceSlideV3Schema),
  images: v2Shape.images,
});
export type DeviceDashboardV3Response = z.infer<
  typeof deviceDashboardV3ResponseSchema
>;

export const deviceHeartbeatRequestSchema = z.object({
  appVersion: z.string().trim().min(1).max(50),
  uptimeSeconds: z.number().int().min(0).max(2_147_483_647),
  lastError: z.string().max(500).nullable().optional(),
  /** The device's screen (#276); older apps send none. */
  screen: deviceScreenSchema.optional(),
});
export type DeviceHeartbeatRequest = z.infer<
  typeof deviceHeartbeatRequestSchema
>;
