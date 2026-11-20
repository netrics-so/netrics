import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import * as authSchema from "./auth-schema.js";
import {
  assertApplicationRoleGrants,
  ensureApplicationRoles,
  provisionRolePasswords,
  type RolePasswords,
} from "./roles.js";
import * as schema from "./schema.js";

export * as authSchema from "./auth-schema.js";
export * as schema from "./schema.js";
export {
  BOOTSTRAP_CONFLICT_SQLSTATE,
  bootstrapWorkspace,
  createWorkspace,
  createWorkspaceInTransaction,
  hasSqlstate,
  isLostConnection,
  isDuplicateMembershipError,
  isLastOwnerError,
  withUserContext,
  withWorkspace,
} from "./context.js";
export type {
  Db,
  TableLockMode,
  TableLocks,
  Transaction,
  UserContext,
  WorkspaceContext,
} from "./context.js";
export {
  claimJobs,
  DEFAULT_BACKFILLS_PER_APP,
  completeJob,
  deferJob,
  deferJobUntil,
  enqueueJob,
  enqueueSyncJob,
  failJob,
  heartbeat,
  DEFAULT_RETENTION,
  listDueConnections,
  pruneHistory,
  renewJobLease,
  latestBackfillFailed,
  requestConnectionBackfill,
  requestConnectionSync,
  setConnectionNextDue,
} from "./jobs.js";
export type {
  DueConnection,
  EnqueueJobInput,
  FailJobResult,
  Job,
  RetentionPolicy,
} from "./jobs.js";
export {
  AUDIT_EVENT_RETENTION_MONTHS,
  EXPIRED_AUTH_RECORD_HOURS,
  pruneRevokedDevices,
  pruneSecurityRecords,
  REVOKED_DEVICE_RETENTION_DAYS,
  SECURITY_RETENTION,
} from "./security-retention.js";
export type {
  SecurityPruneResult,
  SecurityRetentionPolicy,
} from "./security-retention.js";
export {
  APP_REVIEW_LIMITS,
  APP_REVIEW_RETENTION,
  AppReviewStoreError,
  capAppReviewText,
  deleteConnectionAppReviews,
  findLatestAppReview,
  hideAppReview,
  ingestAppReviews,
  pruneAppReviews,
} from "./app-reviews.js";
export type {
  AppReviewInput,
  AppReviewPruneResult,
  AppReviewRetentionPolicy,
  AppReviewWindow,
  LatestAppReview,
} from "./app-reviews.js";
export {
  AcceptInvitationFailure,
  acceptInvitation,
  createInvitation,
  listOpenInvitations,
  previewInvitation,
  revokeInvitation,
} from "./invitations.js";
export type {
  AcceptInvitationError,
  Invitation,
  InvitationDelivery,
  InvitationPreview,
  InvitationStatus,
} from "./invitations.js";
export {
  adminListWorkspaces,
  createServiceToken,
  isInstanceAdmin,
  listPrincipalTokens,
  resolvePrincipalToken,
  revokePrincipalToken,
} from "./principals.js";
export type {
  AdminWorkspace,
  PrincipalKind,
  TokenPrincipal,
} from "./principals.js";
export {
  approvePairing,
  claimPairing,
  countPairingFailures,
  countRecentPairings,
  findDevice,
  findPendingPairing,
  insertDevice,
  insertPairing,
  issueDeviceTokens,
  listDevices,
  pruneStalePairings,
  readPairing,
  recordDeviceHeartbeat,
  recordPairingFailure,
  revokeDevice,
  rotateDeviceRefreshToken,
  touchDevice,
  updateDevice,
} from "./devices.js";
export type {
  DevicePlatformColumn,
  DeviceRow,
  PairingState,
  RefreshOutcome,
} from "./devices.js";
export {
  INSTALLED_COMMIT_KEY,
  INSTALLED_VERSION_KEY,
  consumeSetupToken,
  countUsers,
  findInstallationSetup,
  findInstalledVersion,
  issueSetupToken,
  recordInstalledVersion,
  recordSetupOwner,
} from "./installation.js";
export {
  APPLICATION_ROLES,
  ApplicationRoleGrantsMissingError,
  DEV_ROLE_PASSWORDS,
  PrivilegedDatabaseRoleError,
  assertApplicationRoleGrants,
  ensureApplicationRoles,
  assertUnprivilegedRole,
  findRolesWithDefaultPasswords,
  inspectCurrentRole,
  provisionRolePasswords,
  setRolePassword,
} from "./roles.js";
export type {
  ApplicationRole,
  RolePasswords,
  RolePrivileges,
} from "./roles.js";
export {
  deleteDashboard,
  findDashboard,
  findDashboardVersion,
  dashboardHasModelWidgets,
  insertDashboard,
  listDashboards,
  lockDashboardArchive,
  metricWidgets,
  replaceDashboard,
  schema1Tiles,
} from "./dashboards.js";
export {
  deleteTheme,
  findDashboardsUsingTheme,
  findTheme,
  insertTheme,
  listThemes,
  updateTheme,
} from "./themes.js";
export {
  deleteGoal,
  findDashboardsUsingGoal,
  findGoal,
  findGoalsByIds,
  insertGoal,
  listGoals,
  updateGoal,
} from "./goals.js";
export type {
  DeleteGoalResult,
  GoalInput,
  GoalRow,
  GoalUser,
  InsertGoalResult,
  UpdateGoalResult,
} from "./goals.js";
export type {
  DeleteThemeResult,
  InsertThemeResult,
  ThemeInput,
  ThemeUser,
  UpdateThemeResult,
  WorkspaceThemeRow,
} from "./themes.js";
export type {
  Dashboard,
  DashboardInput,
  DashboardRow,
  DashboardSettings,
  DashboardSlide,
  DashboardSlideRow,
  DashboardSummary,
  DashboardWidgetRow,
  LayoutPlacement,
  PreviewWidget,
  ReplaceResult,
  SlideInput,
  SlideLayout,
  SlideLayoutInput,
  WidgetInput,
} from "./dashboards.js";
export {
  deleteImage,
  findDeviceImage,
  findImage,
  findImageIds,
  findImageUsers,
  findImages,
  findResourceIcon,
  imageUsage,
  insertImageWithinQuota,
  listImages,
  listResourceIcons,
  readImageContent,
  replaceImageReferences,
} from "./images.js";
export type {
  ImageInput,
  ImageQuota,
  ImageQuotaScope,
  ImageRow,
  ImageUsage,
  InsertImageResult,
} from "./images.js";
export {
  CUSTOM_API_IMAGE_GRACE_DAYS,
  findCustomApiImageBySha256,
  findItemImages,
  latestDatasetValues,
  listStreamImages,
  pruneCustomApiItemImages,
  recordStreamImages,
  touchItemImages,
  upsertItemImage,
} from "./custom-api-images.js";
export type { ItemImageRef, StreamImagesRecord } from "./custom-api-images.js";
export {
  BREAKDOWN_TIMEOUT_MS,
  findConnectionMetric,
  listWorkspaceMetrics,
  queryMetricBuckets,
  queryMetricGroupBuckets,
  queryMetricCurrencyBuckets,
  queryMetricCurrencyTotals,
} from "./metrics.js";
export {
  findExchangeRates,
  latestExchangeRateDate,
  listRateCurrencies,
  upsertExchangeRates,
} from "./exchange-rates.js";
export type { StoredExchangeRate } from "./exchange-rates.js";
export type {
  ConnectionMetric,
  MetricBucket,
  MetricBucketQuery,
  MetricCurrencyBucket,
  MetricCurrencyQuery,
  MetricCurrencyTotal,
  MetricGroupBucket,
} from "./metrics.js";
export {
  deleteConnection,
  findBackfillingConnectionIds,
  findConnectionCurrency,
  findConnectionHistory,
  connectionCustomApi,
  customApiPinColumns,
  customApiPinJoin,
  findConnection,
  finishConnectionSetup,
  insertConnection,
  listConnectionIds,
  listConnections,
  latestObservationByResource,
  notDraftConnection,
  listObservations,
  listRecentSyncRuns,
  resetConnectionAuth,
  updateConnection,
} from "./connections.js";
export {
  connectionHasResource,
  connectionResourcesDiscoveredAt,
  findDimensionValueNames,
  findResourceNames,
  listMetricResources,
  findConnectionResourceNoun,
  listNamedResources,
  resourceNameKey,
  resourceTopTerritories,
  upsertConnectionResources,
} from "./resources.js";
export type {
  DiscoveredResourceName,
  MetricResource,
  NamedResource,
} from "./resources.js";
export {
  listConnectionFreshness,
  recordConnectionFreshness,
} from "./freshness.js";
export type {
  ConnectionFreshnessInput,
  ConnectionFreshnessRow,
} from "./freshness.js";
export {
  consumeOAuthAuthorization,
  findConnectionOAuth,
  insertOAuthAuthorization,
  lockConnectionOAuth,
  markNeedsReauthorization,
  releaseOAuthGrant,
  updateConnectionOAuthTokens,
  oauthAccountHasGrant,
  pruneOAuthAuthorizations,
  upsertConnectionOAuth,
  withOAuthGrantLocks,
} from "./oauth.js";
export {
  isSerializationFailure,
  isTransactionHandle,
  retryOnSerializationFailure,
  SERIALIZATION_RETRY_DEFAULTS,
  SERIALIZATION_RETRY_SQLSTATES,
  type SerializationRetryOptions,
} from "./serialization-retry.js";
export {
  isPooledDatabase,
  processSessionLocks,
  SessionLockQueue,
  SessionLockTimeoutError,
  withSessionAdvisoryLock,
  type PooledDb,
} from "./reserved.js";
export type {
  ConnectionOAuthInput,
  ConnectionOAuthRow,
  ConsumedOAuthAuthorization,
  NewOAuthAuthorization,
  OAuthAuthReason,
  OAuthGrantKey,
  OAuthAuthorizationPurpose,
  OAuthTokenUpdate,
  OAuthAuthorizationRow,
} from "./oauth.js";
export {
  deleteSignedKeyToken,
  findSignedKeyToken,
  lockSignedKeyToken,
  storeSignedKeyToken,
} from "./signed-key-tokens.js";
export type { ConnectionSignedKeyTokenRow } from "./signed-key-tokens.js";
export {
  consumePendingKey,
  countActivePendingKeys,
  findPendingKey,
  insertPendingKey,
  prunePendingKeys,
} from "./signed-key-pending-keys.js";
export type {
  PendingKeyOwner,
  SignedKeyPendingKeyRow,
} from "./signed-key-pending-keys.js";
export type {
  ConnectionChanges,
  ConnectionCustomApi,
  ConnectionOAuthAccount,
  ConnectionRow,
  ConnectionStateRow,
  ConnectionWithState,
  FindConnectionOptions,
  NewConnection,
  ObservationFilter,
  ObservationRow,
  SyncRunRow,
} from "./connections.js";
export {
  findUserByAuthUserId,
  findUserByEmail,
  findUserById,
  listMembershipsForUser,
  provisionDomainUser,
  setUserLocale,
} from "./users.js";
export type { DomainUser, MembershipInfo } from "./users.js";
export {
  addMembership,
  createProject,
  createWorkspaceWithOwner,
  deleteMembership,
  deleteProject,
  findMembership,
  findProject,
  findWorkspace,
  insertAuditEvent,
  insertInstallationAuditEvent,
  listAuditEvents,
  listMembers,
  listProjects,
  renameProject,
  updateWorkspace,
  setActiveProject,
  setProjectArchived,
  updateMembershipRole,
} from "./workspaces.js";
export type {
  AuditEvent,
  AuditEventInput,
  MemberDetails,
  Membership,
  Project,
  Workspace,
} from "./workspaces.js";

export {
  countCustomApiConnections,
  countCustomApiDefinitions,
  customApiDatasetVersionHighWater,
  findCustomApiDefinition,
  findCustomApiDefinitionVersion,
  insertCustomApiDefinition,
  insertCustomApiDefinitionVersion,
  listCustomApiDefinitions,
  updateCustomApiDefinition,
} from "./custom-api.js";
export {
  DRAFT_CONNECTION_TTL_HOURS,
  pruneDraftConnections,
} from "./draft-connections.js";
export type {
  CustomApiDefinitionRow,
  CustomApiDefinitionVersionRow,
  CustomApiDefinitionWithVersion,
  NewCustomApiDefinition,
  NewCustomApiDefinitionVersion,
} from "./custom-api.js";
export { projectFilterSql } from "./project-filter.js";
export type { ProjectFilter } from "./project-filter.js";

export type Database = ReturnType<typeof createDatabase>;

// SQL migrations ship inside this package so standalone production images can
// migrate without drizzle-kit (a dev dependency).
export const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

export type { Sql } from "postgres";

/** Raw postgres.js client for tests/tooling that need untyped SQL access. */
export function createRawSqlClient(
  databaseUrl: string,
  options: postgres.Options<Record<string, never>> = {},
) {
  return postgres(databaseUrl, options);
}

export interface RunMigrationsOptions {
  /**
   * Passwords to assign to the application login roles after migrating.
   * Migrations never set credentials themselves.
   */
  rolePasswords?: RolePasswords;
}

export async function runMigrations(
  databaseUrl: string,
  options: RunMigrationsOptions = {},
): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    // Roles first, whatever the journal says: a restored database may
    // reference roles this server never had (#642).
    await ensureApplicationRoles(client);
    await migrate(drizzle(client), { migrationsFolder });
    if (options.rolePasswords) {
      await provisionRolePasswords(client, options.rolePasswords);
    }
    await assertApplicationRoleGrants(client);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export interface DatabaseOptions {
  /** Pool size (postgres.js default: 10). */
  max?: number;
  /** Called with every statement the pool sends; tests count queries. */
  onQuery?: (query: string) => void;
}

export function createDatabase(
  databaseUrl: string,
  options: DatabaseOptions = {},
) {
  const onQuery = options.onQuery;
  const client = postgres(databaseUrl, {
    ...(options.max === undefined ? {} : { max: options.max }),
    ...(onQuery ? { debug: (_connection, query) => onQuery(query) } : {}),
  });
  // The drizzle instance carries the domain tables and the generated
  // better-auth tables (schema "auth") so the server auth adapter can share
  // one connection.
  return drizzle(client, { schema: { ...schema, ...authSchema } });
}

export async function checkDatabaseConnection(
  databaseUrl: string,
  timeoutMs = 2000,
): Promise<boolean> {
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    idle_timeout: 1,
  });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 0 }).catch(() => undefined);
  }
}

export {
  ingestDatasetPage,
  pruneDatasetHistory,
  pruneDatasetHistoryBatch,
  replayDatasetRefresh,
  listObservationDatasets,
  listObservationCatalog,
  readObservationDataset,
  previewDataset,
  DatasetStoreError,
} from "./datasets.js";
export {
  receiveEmptySourceDataset,
  registerSourceDataset,
} from "./datasets.js";
export type { IngestDatasetPageInput } from "./datasets.js";
export {
  connectionDatasetRetentionDays,
  findConnectionRetention,
  lockWorkspaceIngestion,
  lockWorkspaceStaging,
  setConnectionRetention,
} from "./connection-retention.js";
export type {
  ConnectionRetentionRecord,
  SetConnectionRetentionInput,
} from "./connection-retention.js";
export { resolveDataPolicy, adminSetDataPolicy } from "./data-policy.js";

export {
  CONNECTOR_STAGE_DRAFT_TTL_MS,
  DatasetStageUnavailableError,
  abortConnectorStage,
  appendConnectorStagePages,
  beginConnectorStage,
  commitConnectorStage,
  connectorStageDigest,
  connectorStagePageDigest,
  findConnectorStage,
  matchConnectorStage,
  prepareConnectorStagePages,
  readConnectorStagePage,
  storeConnectorStage,
  connectorStageProvenance,
} from "./connector-staging.js";
export {
  activeBackfillConnections,
  AUTOMATIC_BACKFILL_RETRY_MS,
  AUTOMATIC_BACKFILLS_PER_SET,
  connectionBackfillState,
  datasetVersions,
  datasetsMissingBackfill,
  deriveBackfilledDatasets,
  intersectDatasetVersions,
  lockHistoryReload,
  lockWorkspaceBackfills,
  markHistoryReloadRequested,
  queueDatasetBackfill,
  sourceHistoryIncomplete,
  storedDatasetsMissingBackfill,
} from "./dataset-backfill.js";
export type {
  DatasetBackfillOutcome,
  DatasetVersions,
} from "./dataset-backfill.js";
