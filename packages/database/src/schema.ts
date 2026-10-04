import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// drizzle-orm has no built-in bytea column; postgres.js maps it to Buffer.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const schemaInfo = pgTable("schema_info", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// users is installation-level: no tenant RLS (see migration 0001).
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authUserId: text("auth_user_id").unique(),
    email: text("email").notNull().unique(),
    displayName: text("display_name").notNull(),
    // May use the installation admin API (/v1/admin/*). The first-run setup
    // account is one; installation-level, never granted by a workspace role.
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    // The user's language (ADR 0016); null follows the instance default and
    // the browser. The API validates against SUPPORTED_LOCALES; the check
    // only guards the shape, so adding a language needs no migration.
    locale: text("locale"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "users_locale_format",
      sql`${table.locale} is null or ${table.locale} ~ '^[a-z]{2,3}$'`,
    ),
  ],
);

// Bearer tokens for non-session principals (ADR 0009): installation service
// accounts ("service") and, later, paired screens ("device"). Only the
// SHA-256 of the token is stored. Installation-level; the application role
// has no grant on this table and resolves tokens only through
// resolve_principal_token().
export const principalTokens = pgTable(
  "principal_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").array().notNull(),
    // Devices belong to one workspace; service accounts to none.
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // The device a "device" token belongs to (ADR 0011).
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "cascade",
    }),
    // Device refresh rotation (ADR 0011): the refresh token a token pair was
    // issued for, and when a refresh token was exchanged for a new pair.
    parentId: uuid("parent_id"),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "principal_tokens_kind_valid",
      sql`${table.kind} in ('service', 'device')`,
    ),
    check(
      "principal_tokens_device_workspace",
      sql`(${table.kind} = 'device') = (${table.workspaceId} is not null)`,
    ),
    check(
      "principal_tokens_device_id",
      sql`(${table.kind} = 'device') = (${table.deviceId} is not null)`,
    ),
    index("principal_tokens_device_idx").on(table.deviceId),
    index("principal_tokens_parent_idx").on(table.parentId),
  ],
);

// Installation-level, single row: the one-time token that authorizes creating
// the first account while public sign-up is closed (see apps/server/src/setup.ts).
// Only the SHA-256 of the token is stored.
export const installationSetup = pgTable(
  "installation_setup",
  {
    id: smallint("id").primaryKey().default(1),
    tokenHash: text("token_hash").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (table) => [check("installation_setup_singleton", sql`${table.id} = 1`)],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    // IANA zone for "today" and daily buckets (#48); validated by the API.
    timeZone: text("time_zone").notNull().default("UTC"),
    // Amounts of "currency_minor" metrics converted into this ISO 4217 code
    // with ECB reference rates (#191); null shows them per currency (exact).
    displayCurrency: text("display_currency"),
    // The language of the workspace's screens (kiosk, Apple TV; ADR 0016);
    // null follows the instance default.
    screenLocale: text("screen_locale"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "workspaces_screen_locale_format",
      sql`${table.screenLocale} is null or ${table.screenLocale} ~ '^[a-z]{2,3}$'`,
    ),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    activeProjectId: uuid("active_project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.workspaceId, table.userId),
    check(
      "memberships_role_valid",
      sql`${table.role} in ('owner', 'admin', 'editor', 'viewer')`,
    ),
  ],
);

// Workspace invitations. Membership is granted only when the invited person
// accepts with the token, which proves access to the invited mailbox (or,
// with delivery "manual", that the inviting admin handed it over). Only the
// SHA-256 of the token is stored. Rows are never deleted: revoked/accepted
// invitations stay as history.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Stored lowercase; compared case-insensitively with account emails.
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    // "email": the link was mailed to the invitee; "manual": shown to the
    // inviting admin to hand over (no email transport configured).
    delivery: text("delivery").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "invitations_role_valid",
      sql`${table.role} in ('owner', 'admin', 'editor', 'viewer')`,
    ),
    check(
      "invitations_delivery_valid",
      sql`${table.delivery} in ('email', 'manual')`,
    ),
    check(
      "invitations_email_lowercase",
      sql`${table.email} = lower(${table.email})`,
    ),
    // At most one open invitation per address and workspace.
    uniqueIndex("invitations_open_email")
      .on(table.workspaceId, table.email)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
  ],
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// audit_events is append-only: netrics_app gets SELECT/INSERT only, and the
// RLS policies (migration 0001) grant no UPDATE/DELETE path. Events older
// than AUDIT_EVENT_RETENTION_MONTHS are deleted by the scheduler through the
// owner-role prune_security_records (migration 0029).
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    target: text("target").notNull().default(""),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("audit_events_created_at_idx").on(table.createdAt)],
);

// Installation-level connector catalog (synced from the bundle at boot): no
// tenant RLS.
export const connectors = pgTable("connectors", {
  id: text("id").primaryKey(),
  version: text("version").notNull(),
  manifest: jsonb("manifest").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ECB euro reference rates (#191): installation-level reference data, no
// tenant RLS. netrics_app only reads; the scheduler's rate job writes.
export const exchangeRates = pgTable(
  "exchange_rates",
  {
    rateDate: date("rate_date", { mode: "string" }).notNull(),
    currency: text("currency").notNull(),
    // Units of the currency per euro, exact (numeric, never a float).
    unitsPerEur: numeric("units_per_eur").notNull(),
    source: text("source").notNull().default("ecb"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "exchange_rates_pk",
      columns: [table.source, table.rateDate, table.currency],
    }),
    check(
      "exchange_rates_currency_valid",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check("exchange_rates_rate_positive", sql`${table.unitsPerEur} > 0`),
  ],
);

// Installation-level metric catalog: no tenant RLS.
export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    kind: text("kind").notNull(),
    unit: text("unit").notNull(),
    // Time resolution (see the connector SDK): "day"/"hour" values are
    // stamped at the UTC bucket start, "instant" values are point readings.
    granularity: text("granularity").notNull(),
    dimensions: jsonb("dimensions").notNull(),
    aggregations: jsonb("aggregations").notNull(),
    // Which way is good for the metric: "higher" or "lower" (#136).
    better: text("better").notNull().default("higher"),
    // "primary" or "helper": helpers feed derived values and are not offered
    // for tiles (#166).
    role: text("role").notNull().default("primary"),
  },
  (table) => [
    unique().on(table.connectorId, table.key),
    check(
      "metric_definitions_better_valid",
      sql`${table.better} in ('higher', 'lower')`,
    ),
    check(
      "metric_definitions_role_valid",
      sql`${table.role} in ('primary', 'helper')`,
    ),
    check(
      "metric_definitions_kind_valid",
      sql`${table.kind} in ('gauge', 'delta', 'counter')`,
    ),
    check(
      "metric_definitions_granularity_valid",
      sql`${table.granularity} in ('day', 'hour', 'instant')`,
    ),
  ],
);

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    name: text("name").notNull(),
    config: jsonb("config").notNull().default({}),
    // AES-256-GCM envelope (apps/server/src/credentials.ts). Only code paths
    // that decrypt may read this; never select it into API responses.
    credentialsEncrypted: bytea("credentials_encrypted"),
    // Created by an OAuth callback and not finished yet (ADR 0012): it holds
    // the grant but not the connector config (e.g. the property), so it is
    // not scheduled and the web app shows "Finish setup".
    setupPending: boolean("setup_pending").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // Target of composite foreign keys that pin rows to the connection's
  // workspace (dashboard_tiles).
  (table) => [
    unique("connections_id_workspace_unique").on(table.id, table.workspaceId),
  ],
);

export const connectionState = pgTable(
  "connection_state",
  {
    connectionId: uuid("connection_id")
      .primaryKey()
      .references(() => connections.id, { onDelete: "cascade" }),
    // Denormalized from connections so RLS can scope without a join.
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    // Denormalized from the connector manifest's minRefreshIntervalSeconds by
    // the API at connection-creation time: the scheduler plans due syncs from
    // connection_state alone (it has no grant on connections, so manifest
    // lookups are impossible by design). See migration 0006.
    pollIntervalSeconds: integer("poll_interval_seconds")
      .notNull()
      .default(300),
    cursor: text("cursor"),
    // The connection.backfill job whose window the cursor continues (#153).
    // A backfill job starts at its window start unless this is its own id,
    // so a new backfill reads the whole window while a retried or reclaimed
    // one resumes from its checkpoint. No foreign key: job rows are pruned.
    backfillJobId: uuid("backfill_job_id"),
    authState: text("auth_state").notNull().default("ok"),
    // Why the connection needs reauthorization (ADR 0012); set only with
    // auth_state needs_reauthorization.
    authReason: text("auth_reason"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  },
  (table) => [
    check(
      "connection_state_auth_state_valid",
      sql`${table.authState} in ('ok', 'auth_failed', 'needs_reauthorization', 'outage')`,
    ),
    check(
      "connection_state_auth_reason_valid",
      sql`${table.authReason} in ('invalid_grant', 'scope_missing')`,
    ),
    check(
      "connection_state_auth_reason_state",
      sql`${table.authReason} is null or ${table.authState} = 'needs_reauthorization'`,
    ),
  ],
);

// What a connection's provider calls its resources (#194): the names of the
// apps, projects or properties that observations carry in their `resource`
// dimension, from the connector's discover. Refreshed by the sync engine at
// most daily; a resource that disappears keeps its last name, since its
// history stays. Only names are kept, never credentials or metadata.
export const connectionResources = pgTable(
  "connection_resources",
  {
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    resourceId: text("resource_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.resourceId] }),
    foreignKey({
      name: "connection_resources_connection_fk",
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete("cascade"),
    index("connection_resources_workspace_idx").on(table.workspaceId),
  ],
);

// Recent customer reviews with their text (ADR 0019 §11, #334), for the
// latest-review widget. The nickname is personal data and the text user
// content: lengths are capped in the database, the hourly maintenance keeps
// the newest 50 per app and none older than 90 days (prune_app_reviews),
// and the rows go with the connection, its workspace or its reviews key.
// Keyed by connection and provider id, so a second review source (Google
// Play) uses the same table.
export const appReviews = pgTable(
  "app_reviews",
  {
    connectionId: uuid("connection_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    providerReviewId: text("provider_review_id").notNull(),
    resourceId: text("resource_id").notNull(),
    rating: smallint("rating").notNull(),
    title: text("title"),
    body: text("body"),
    author: text("author"),
    territory: text("territory"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.providerReviewId] }),
    foreignKey({
      name: "app_reviews_connection_fk",
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete("cascade"),
    index("app_reviews_workspace_idx").on(table.workspaceId),
    index("app_reviews_resource_created_idx").on(
      table.connectionId,
      table.resourceId,
      table.createdAt.desc(),
    ),
    index("app_reviews_created_at_idx").on(table.createdAt),
    check("app_reviews_rating", sql`${table.rating} between 1 and 5`),
    check("app_reviews_title_length", sql`char_length(${table.title}) <= 300`),
    check("app_reviews_body_length", sql`char_length(${table.body}) <= 4000`),
    check(
      "app_reviews_author_length",
      sql`char_length(${table.author}) <= 100`,
    ),
    check("app_reviews_territory", sql`${table.territory} ~ '^[A-Z]{2}$'`),
  ],
);

// (connection_id, source_identity) is the idempotency key: re-ingesting the
// same source observation is a no-op (ON CONFLICT DO NOTHING).
// One value of one series at one time (ADR 0008). The key (connection,
// metric, series, timestamp) includes the timestamp so the table can be
// range-partitioned by time; series_key is derived by the database from the
// canonical jsonb text of the dimensions, so no code path can compute it
// differently. Re-ingesting a key with a different value is a revision and
// updates the row; an identical value is a no-op.
export const observations = pgTable(
  "observations",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    metricDefinitionId: uuid("metric_definition_id")
      .notNull()
      .references(() => metricDefinitions.id),
    dimensions: jsonb("dimensions").notNull().default({}),
    seriesKey: text("series_key")
      .notNull()
      .generatedAlwaysAs(sql`md5(dimensions::text)`),
    sourceTimestamp: timestamp("source_timestamp", {
      withTimezone: true,
    }).notNull(),
    value: doublePrecision("value").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "observations_pkey",
      columns: [
        table.connectionId,
        table.metricDefinitionId,
        table.seriesKey,
        table.sourceTimestamp,
      ],
    }),
    index("observations_workspace_metric_time_idx").on(
      table.workspaceId,
      table.metricDefinitionId,
      table.sourceTimestamp,
    ),
  ],
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    requestedFrom: timestamp("requested_from", {
      withTimezone: true,
    }).notNull(),
    requestedTo: timestamp("requested_to", { withTimezone: true }).notNull(),
    cursorBefore: text("cursor_before"),
    cursorAfter: text("cursor_after"),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorClass: text("error_class"),
    // Already redacted by the writer; must never carry credential material.
    errorMessage: text("error_message"),
    observationsWritten: integer("observations_written").notNull().default(0),
  },
  (table) => [
    check(
      "sync_runs_mode_valid",
      sql`${table.mode} in ('backfill', 'incremental')`,
    ),
    check(
      "sync_runs_status_valid",
      sql`${table.status} in ('running', 'succeeded', 'failed')`,
    ),
    check(
      "sync_runs_error_class_valid",
      sql`${table.errorClass} in ('auth', 'transient', 'contract', 'budget')`,
    ),
    index("sync_runs_connection_started_idx").on(
      table.connectionId,
      table.startedAt.desc(),
    ),
  ],
);

// Installation-level ops data (no tenant RLS): which worker/scheduler
// processes are alive. netrics_app is read-only (admin UI); only the
// scheduler role writes (migration 0006).
export const workerHeartbeats = pgTable(
  "worker_heartbeats",
  {
    workerId: text("worker_id").primaryKey(),
    role: text("role").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => [
    check(
      "worker_heartbeats_role_valid",
      sql`${table.role} in ('worker', 'scheduler')`,
    ),
  ],
);

// Durable job queue (ADR 0006). RLS: netrics_app is tenant-scoped (enqueue +
// retry within its workspace), netrics_scheduler claims across all workspaces.
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    // Deleting a connection keeps its (cancelled) jobs as history, detached;
    // retention prunes them later (migration 0016).
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    status: text("status").notNull().default("pending"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.idempotencyKey),
    check(
      "jobs_status_valid",
      sql`${table.status} in ('pending', 'running', 'succeeded', 'failed', 'dead')`,
    ),
    index("jobs_claim_idx")
      .on(table.status, table.runAt)
      .where(sql`${table.status} = 'pending'`),
    // At most one waiting sync per connection: scheduler ticks and manual
    // "sync now" requests coalesce instead of piling up behind an outage.
    uniqueIndex("jobs_one_pending_sync")
      .on(table.connectionId)
      .where(
        sql`${table.kind} = 'connection.sync' and ${table.status} = 'pending'`,
      ),
    // At most one waiting backfill per connection: a newly requested one
    // supersedes the waiting one (#153).
    uniqueIndex("jobs_one_pending_backfill")
      .on(table.connectionId)
      .where(
        sql`${table.kind} = 'connection.backfill' and ${table.status} = 'pending'`,
      ),
    // claim_jobs skips a connection that already has a running job
    // (migration 0011).
    index("jobs_running_connection")
      .on(table.connectionId)
      .where(sql`${table.status} = 'running'`),
    // prune_history deletes finished jobs by age (migration 0016).
    index("jobs_finished_created_idx")
      .on(table.createdAt)
      .where(sql`${table.status} in ('succeeded', 'failed', 'dead')`),
  ],
);

// Custom dashboard themes (ADR 0015, section 6): a copy of a built-in
// (`base`) with edited tokens, validated by the contracts. Workspace table
// under RLS; names are unique per workspace regardless of case.
export const workspaceThemes = pgTable(
  "workspace_themes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The built-in theme key it was copied from. */
    base: text("base").notNull(),
    tokens: jsonb("tokens").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("workspace_themes_id_workspace_unique").on(
      table.id,
      table.workspaceId,
    ),
    uniqueIndex("workspace_themes_name_unique").on(
      table.workspaceId,
      sql`lower(${table.name})`,
    ),
    check("workspace_themes_version_positive", sql`${table.version} >= 1`),
    check(
      "workspace_themes_tokens_object",
      sql`jsonb_typeof(${table.tokens}) = 'object'`,
    ),
  ],
);

// Tile dashboards (#49). A dashboard is saved as a whole: its name and
// ordered tiles change together, guarded by `version` (optimistic
// concurrency). Composite foreign keys keep every tile in the workspace of
// its dashboard and of its connection, independent of application code.
// Workspace images (ADR 0015, section 5; #217): raster images stored in the
// database, metadata already stripped. `content` is already compressed, so
// the migration sets its storage to EXTERNAL (no TOAST compression). List
// queries never select it. `id, workspace_id` is unique so dashboards,
// slides and widgets can reference an image of their own workspace.
export const workspaceImages = pgTable(
  "workspace_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    sha256: text("sha256").notNull(),
    content: bytea("content").notNull(),
    origin: text("origin").notNull().default("upload"),
    // Provenance of a resource icon; no foreign key, so an icon outlives
    // its connection as an ordinary image.
    connectionId: uuid("connection_id"),
    resourceId: text("resource_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("workspace_images_id_workspace_unique").on(
      table.id,
      table.workspaceId,
    ),
    index("workspace_images_workspace_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    check(
      "workspace_images_content_type_valid",
      sql`${table.contentType} in ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check(
      "workspace_images_bytes_valid",
      sql`${table.bytes} > 0 and ${table.bytes} <= 1048576 and ${table.bytes} = octet_length(${table.content})`,
    ),
    check(
      "workspace_images_dimensions_valid",
      sql`${table.width} between 1 and 4096 and ${table.height} between 1 and 4096 and ${table.width}::bigint * ${table.height} <= 16777216`,
    ),
    check(
      "workspace_images_sha256_valid",
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workspace_images_origin_valid",
      sql`(${table.origin} = 'upload' and ${table.connectionId} is null and ${table.resourceId} is null) or (${table.origin} = 'resource_icon' and ${table.connectionId} is not null and ${table.resourceId} is not null)`,
    ),
    check(
      "workspace_images_name_valid",
      sql`char_length(${table.name}) <= 100`,
    ),
  ],
);

export const dashboards = pgTable(
  "dashboards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    // Studio settings (ADR 0015 section 1): the header band above the
    // grid, and how screens rotate through the slides.
    showHeader: boolean("show_header").notNull().default(true),
    /** False: screens show only the first enabled slide. */
    autoAdvance: boolean("auto_advance").notNull().default(true),
    defaultSlideSeconds: integer("default_slide_seconds").notNull().default(20),
    transition: text("transition").notNull().default("fade"),
    // The theme (ADR 0015, section 6): a built-in key or a custom theme,
    // exactly one of the two.
    themeBuiltin: text("theme_builtin").default("netrics_dark"),
    themeId: uuid("theme_id"),
    /** `#rrggbb`; overrides the theme accent (a brand dashboard). */
    accentColor: text("accent_color"),
    /** Shown in the header before the name (#217). */
    logoImageId: uuid("logo_image_id"),
    /**
     * The format the widgets' x, y, w, h are designed in (ADR 0017 section
     * 4); every other format is auto or a custom layout.
     */
    primaryFormat: text("primary_format").notNull().default("16x9"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("dashboards_id_workspace_unique").on(table.id, table.workspaceId),
    index("dashboards_workspace_idx").on(table.workspaceId),
    check("dashboards_version_positive", sql`${table.version} >= 1`),
    check(
      "dashboards_default_slide_seconds_valid",
      sql`${table.defaultSlideSeconds} between 5 and 3600`,
    ),
    check(
      "dashboards_transition_valid",
      sql`${table.transition} in ('none', 'fade')`,
    ),
    // NO ACTION, not RESTRICT: deleting a theme in use still fails, but a
    // workspace deletion that cascades to both dashboards and themes is
    // checked at the end of the statement and succeeds.
    foreignKey({
      name: "dashboards_theme_fk",
      columns: [table.themeId, table.workspaceId],
      foreignColumns: [workspaceThemes.id, workspaceThemes.workspaceId],
    }),
    index("dashboards_theme_idx")
      .on(table.themeId)
      .where(sql`${table.themeId} is not null`),
    check(
      "dashboards_one_theme",
      sql`(${table.themeBuiltin} is null) <> (${table.themeId} is null)`,
    ),
    check(
      "dashboards_theme_builtin_format",
      sql`${table.themeBuiltin} ~ '^[a-z][a-z0-9_]{0,39}$'`,
    ),
    check(
      "dashboards_accent_color_format",
      sql`${table.accentColor} ~ '^#[0-9a-f]{6}$'`,
    ),
    // Image references (#217): migration 0035 makes these keys deferred,
    // so deleting a workspace (images and dashboards in one statement)
    // works; deleteImage checks them immediately.
    foreignKey({
      name: "dashboards_logo_image_fk",
      columns: [table.logoImageId, table.workspaceId],
      foreignColumns: [workspaceImages.id, workspaceImages.workspaceId],
    }),
    index("dashboards_logo_image_idx").on(table.logoImageId),
    check(
      "dashboards_primary_format_valid",
      sql`${table.primaryFormat} in ('16x9', '21x9', '4x3', '3x4', '9x16')`,
    ),
  ],
);

// Dashboard Studio (ADR 0015): a dashboard is an ordered list of slides,
// each a 12 × 8 grid of widgets. Composite foreign keys keep every slide in
// the workspace of its dashboard, and every widget on a slide of its own
// dashboard and in the workspace of its connection. Migration 0033 also
// adds the deferrable unique (dashboard_id, position) on slides, which
// drizzle cannot express.
export const dashboardSlides = pgTable(
  "dashboard_slides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    position: integer("position").notNull(),
    /** Shown in the header and the editor. */
    name: text("name"),
    /** Null: the dashboard's default_slide_seconds. */
    durationSeconds: integer("duration_seconds"),
    /** Screens skip disabled slides. */
    enabled: boolean("enabled").notNull().default(true),
    /** A full-slide image behind the widgets (#217). */
    backgroundImageId: uuid("background_image_id"),
    /** 0–80 %: a theme-background overlay that keeps contrast. */
    backgroundDim: smallint("background_dim").notNull().default(0),
  },
  (table) => [
    foreignKey({
      name: "dashboard_slides_dashboard_fk",
      columns: [table.dashboardId, table.workspaceId],
      foreignColumns: [dashboards.id, dashboards.workspaceId],
    }).onDelete("cascade"),
    unique("dashboard_slides_id_dashboard_workspace_unique").on(
      table.id,
      table.dashboardId,
      table.workspaceId,
    ),
    index("dashboard_slides_workspace_idx").on(table.workspaceId),
    check("dashboard_slides_position_valid", sql`${table.position} >= 0`),
    check(
      "dashboard_slides_name_valid",
      sql`${table.name} is null or char_length(${table.name}) between 1 and 60`,
    ),
    check(
      "dashboard_slides_duration_valid",
      sql`${table.durationSeconds} is null or ${table.durationSeconds} between 5 and 3600`,
    ),
    check(
      "dashboard_slides_background_dim_valid",
      sql`${table.backgroundDim} between 0 and 80`,
    ),
    foreignKey({
      name: "dashboard_slides_background_image_fk",
      columns: [table.backgroundImageId, table.workspaceId],
      foreignColumns: [workspaceImages.id, workspaceImages.workspaceId],
    }),
    index("dashboard_slides_background_image_idx").on(table.backgroundImageId),
  ],
);

export const dashboardWidgets = pgTable(
  "dashboard_widgets",
  {
    // Stable across saves (ADR 0015 section 3); a migrated tile keeps its id.
    id: uuid("id").primaryKey().defaultRandom(),
    slideId: uuid("slide_id").notNull(),
    dashboardId: uuid("dashboard_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    type: text("type").notNull(),
    x: smallint("x").notNull(),
    y: smallint("y").notNull(),
    w: smallint("w").notNull(),
    h: smallint("h").notNull(),
    /** Overrides the default label when set. */
    title: text("title"),
    // Data widgets (metric, line, bar), as dashboard_tiles.
    connectionId: uuid("connection_id"),
    metricKey: text("metric_key"),
    aggregation: text("aggregation"),
    period: text("period"),
    dimensions: jsonb("dimensions").notNull().default({}),
    displayCurrency: text("display_currency"),
    /** Text widgets: markdown-lite, never HTML. */
    text: text("text"),
    /** Image widgets (#217). */
    imageId: uuid("image_id"),
    /** Type-specific style, validated per type by the API contract. */
    options: jsonb("options").notNull().default({}),
  },
  (table) => [
    foreignKey({
      name: "dashboard_widgets_slide_fk",
      columns: [table.slideId, table.dashboardId, table.workspaceId],
      foreignColumns: [
        dashboardSlides.id,
        dashboardSlides.dashboardId,
        dashboardSlides.workspaceId,
      ],
    }).onDelete("cascade"),
    // A widget goes with its connection, like a tile.
    foreignKey({
      name: "dashboard_widgets_connection_fk",
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete("cascade"),
    // Custom layouts reference a widget together with its slide (#275).
    unique("dashboard_widgets_id_slide_workspace_unique").on(
      table.id,
      table.slideId,
      table.workspaceId,
    ),
    index("dashboard_widgets_slide_idx").on(table.slideId),
    index("dashboard_widgets_dashboard_idx").on(table.dashboardId),
    index("dashboard_widgets_connection_idx").on(table.connectionId),
    foreignKey({
      name: "dashboard_widgets_image_fk",
      columns: [table.imageId, table.workspaceId],
      foreignColumns: [workspaceImages.id, workspaceImages.workspaceId],
    }),
    index("dashboard_widgets_image_idx").on(table.imageId),
    check(
      "dashboard_widgets_type_valid",
      sql`${table.type} in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table')`,
    ),
    // An image widget names its image; no other widget does.
    check(
      "dashboard_widgets_image_valid",
      sql`(${table.imageId} is not null) = (${table.type} = 'image')`,
    ),
    // The largest grid of any format (ADR 0017 section 8); the service
    // checks the exact grid of the dashboard's primary format.
    check(
      "dashboard_widgets_grid_valid",
      sql`${table.x} >= 0 and ${table.y} >= 0 and ${table.w} >= 1 and ${table.h} >= 1 and ${table.x} + ${table.w} <= 16 and ${table.y} + ${table.h} <= 14`,
    ),
    check(
      "dashboard_widgets_title_valid",
      sql`${table.title} is null or char_length(${table.title}) between 1 and 100`,
    ),
    check(
      "dashboard_widgets_text_valid",
      sql`${table.text} is null or char_length(${table.text}) <= 500`,
    ),
    check(
      "dashboard_widgets_aggregation_valid",
      sql`${table.aggregation} is null or ${table.aggregation} in ('sum', 'avg', 'min', 'max', 'last')`,
    ),
    check(
      "dashboard_widgets_period_valid",
      sql`${table.period} is null or ${table.period} in ('today', 'last_7_days', 'last_30_days', 'this_month', 'last_90_days', 'last_12_months', 'this_week', 'this_quarter', 'this_year')`,
    ),
    // Data widgets have a metric binding and no text; the others neither.
    check(
      "dashboard_widgets_type_columns",
      sql`case when ${table.type} in ('metric', 'line', 'bar', 'table') then ${table.connectionId} is not null and ${table.metricKey} is not null and ${table.aggregation} is not null and ${table.period} is not null and ${table.text} is null else ${table.connectionId} is null and ${table.metricKey} is null and ${table.aggregation} is null and ${table.period} is null and ${table.displayCurrency} is null and ${table.dimensions} = '{}'::jsonb and (${table.text} is not null) = (${table.type} = 'text') end`,
    ),
  ],
);

// Custom layouts (ADR 0017 sections 4 and 8): per slide and non-primary
// format, either auto (no rows, computed by reflowSlide) or custom (one
// slide layout row and one placement per widget of the slide). Composite
// foreign keys keep a layout on a slide of its own dashboard and workspace,
// and every placement on a widget of that slide; both go with the slide,
// the widget or the layout (cascade).
export const dashboardSlideLayouts = pgTable(
  "dashboard_slide_layouts",
  {
    slideId: uuid("slide_id").notNull(),
    format: text("format").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    dashboardId: uuid("dashboard_id").notNull(),
    /** Continuation pages included, 1–8. */
    pages: smallint("pages").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "dashboard_slide_layouts_pk",
      columns: [table.slideId, table.format],
    }),
    unique("dashboard_slide_layouts_slide_format_workspace_unique").on(
      table.slideId,
      table.format,
      table.workspaceId,
    ),
    foreignKey({
      name: "dashboard_slide_layouts_slide_fk",
      columns: [table.slideId, table.dashboardId, table.workspaceId],
      foreignColumns: [
        dashboardSlides.id,
        dashboardSlides.dashboardId,
        dashboardSlides.workspaceId,
      ],
    }).onDelete("cascade"),
    index("dashboard_slide_layouts_workspace_idx").on(table.workspaceId),
    index("dashboard_slide_layouts_dashboard_idx").on(table.dashboardId),
    check(
      "dashboard_slide_layouts_format_valid",
      sql`${table.format} in ('16x9', '21x9', '4x3', '3x4', '9x16')`,
    ),
    check(
      "dashboard_slide_layouts_pages_valid",
      sql`${table.pages} between 1 and 8`,
    ),
  ],
);

export const dashboardWidgetLayouts = pgTable(
  "dashboard_widget_layouts",
  {
    widgetId: uuid("widget_id").notNull(),
    format: text("format").notNull(),
    slideId: uuid("slide_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    /** 0-based page of the slide in this format. */
    page: smallint("page").notNull(),
    x: smallint("x").notNull(),
    y: smallint("y").notNull(),
    w: smallint("w").notNull(),
    h: smallint("h").notNull(),
    /** Hidden in this format: an explicit choice, never a silent drop. */
    hidden: boolean("hidden").notNull().default(false),
    /** Placed by the server after a primary edit; for the user to review. */
    autoPlaced: boolean("auto_placed").notNull().default(false),
  },
  (table) => [
    primaryKey({
      name: "dashboard_widget_layouts_pk",
      columns: [table.widgetId, table.format],
    }),
    foreignKey({
      name: "dashboard_widget_layouts_widget_fk",
      columns: [table.widgetId, table.slideId, table.workspaceId],
      foreignColumns: [
        dashboardWidgets.id,
        dashboardWidgets.slideId,
        dashboardWidgets.workspaceId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      name: "dashboard_widget_layouts_layout_fk",
      columns: [table.slideId, table.format, table.workspaceId],
      foreignColumns: [
        dashboardSlideLayouts.slideId,
        dashboardSlideLayouts.format,
        dashboardSlideLayouts.workspaceId,
      ],
    }).onDelete("cascade"),
    index("dashboard_widget_layouts_workspace_idx").on(table.workspaceId),
    index("dashboard_widget_layouts_layout_idx").on(
      table.slideId,
      table.format,
    ),
    check(
      "dashboard_widget_layouts_page_valid",
      sql`${table.page} between 0 and 7`,
    ),
    check(
      "dashboard_widget_layouts_grid_valid",
      sql`${table.x} >= 0 and ${table.y} >= 0 and ${table.w} >= 1 and ${table.h} >= 1 and ${table.x} + ${table.w} <= 16 and ${table.y} + ${table.h} <= 14`,
    ),
  ],
);

export const dashboardTiles = pgTable(
  "dashboard_tiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    dashboardId: uuid("dashboard_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    // A tile goes with its connection: without it there is nothing to show.
    connectionId: uuid("connection_id").notNull(),
    metricKey: text("metric_key").notNull(),
    aggregation: text("aggregation").notNull(),
    period: text("period").notNull(),
    dimensions: jsonb("dimensions").notNull().default({}),
    /** Overrides the metric name when set. */
    title: text("title"),
    /**
     * A per-currency amount converted into this ISO 4217 code (#191),
     * overriding the workspace's display currency.
     */
    displayCurrency: text("display_currency"),
    position: integer("position").notNull(),
  },
  (table) => [
    foreignKey({
      name: "dashboard_tiles_dashboard_fk",
      columns: [table.dashboardId, table.workspaceId],
      foreignColumns: [dashboards.id, dashboards.workspaceId],
    }).onDelete("cascade"),
    foreignKey({
      name: "dashboard_tiles_connection_fk",
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete("cascade"),
    index("dashboard_tiles_dashboard_idx").on(
      table.dashboardId,
      table.position,
    ),
    index("dashboard_tiles_connection_idx").on(table.connectionId),
    check(
      "dashboard_tiles_aggregation_valid",
      sql`${table.aggregation} in ('sum', 'avg', 'min', 'max', 'last')`,
    ),
    check(
      "dashboard_tiles_period_valid",
      sql`${table.period} in ('today', 'last_7_days', 'last_30_days', 'this_month', 'last_90_days', 'last_12_months', 'this_week', 'this_quarter', 'this_year')`,
    ),
    check("dashboard_tiles_position_valid", sql`${table.position} >= 0`),
  ],
);

// A paired screen (ADR 0011). Workspace table under RLS; its credentials are
// principal_tokens rows of kind "device".
/** `devices.screen` as stored: a heartbeat's validated `screen` object. */
export interface DeviceScreenColumn {
  width: number;
  height: number;
  scale: number;
  format?: string;
  mode: string;
}

export const devices = pgTable(
  "devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // What the screen shows. The foreign key (dashboard_id, workspace_id) →
    // dashboards, ON DELETE SET NULL (dashboard_id), is written by hand in
    // migration 0019: drizzle cannot express a column-list SET NULL.
    dashboardId: uuid("dashboard_id"),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // The latest heartbeat (#57), as the device reported it.
    appVersion: text("app_version"),
    uptimeSeconds: integer("uptime_seconds"),
    lastError: text("last_error"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    // Screen settings (ADR 0017 section 7, #276): the whole rendering turns
    // by this many degrees (an Apple TV cannot know its TV is mounted on
    // its side), and the display mode a browser kiosk uses.
    rotation: smallint("rotation").notNull().default(0),
    displayMode: text("display_mode").notNull().default("screen"),
    // The screen the device last reported in a heartbeat (validated by the
    // contracts' deviceScreenSchema before it is stored); null until then.
    screen: jsonb("screen").$type<DeviceScreenColumn>(),
  },
  (table) => [
    unique("devices_id_workspace_unique").on(table.id, table.workspaceId),
    index("devices_workspace_idx").on(table.workspaceId),
    check(
      "devices_rotation_valid",
      sql`${table.rotation} in (0, 90, 180, 270)`,
    ),
    check(
      "devices_display_mode_valid",
      sql`${table.displayMode} in ('screen', 'scroll')`,
    ),
    check(
      "devices_screen_object",
      sql`${table.screen} is null or jsonb_typeof(${table.screen}) = 'object'`,
    ),
  ],
);

// A pairing in progress (ADR 0011). Installation-level: until approved it
// belongs to no workspace. Only hashes of the code and poll secret are kept.
export const devicePairings = pgTable(
  "device_pairings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    pollSecretHash: text("poll_secret_hash").notNull(),
    // Hash of the requesting client's IP, for the creation rate limit.
    clientKey: text("client_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, {
      onDelete: "cascade",
    }),
    deviceId: uuid("device_id").references(() => devices.id, {
      onDelete: "cascade",
    }),
    // When the device received its credentials; a pairing is spent after.
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => [
    index("device_pairings_client_idx").on(table.clientKey, table.createdAt),
    index("device_pairings_expires_idx").on(table.expiresAt),
    check(
      "device_pairings_approval_complete",
      sql`(${table.approvedAt} is null) = (${table.deviceId} is null)`,
    ),
  ],
);

// Failed approval attempts per user, for the brute-force limit (ADR 0011).
export const devicePairingFailures = pgTable(
  "device_pairing_failures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("device_pairing_failures_user_idx").on(table.userId, table.createdAt),
  ],
);

// An OAuth authorization in progress (ADR 0012). Workspace table under RLS;
// the callback, which does not know the workspace yet, finds and consumes a
// row only through consume_oauth_authorization(state_hash). Only the SHA-256
// of the state is stored; the PKCE verifier is sealed in an envelope bound
// to this row (apps/server/src/credentials.ts).
export const oauthAuthorizations = pgTable(
  "oauth_authorizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    // Who started it; only this user may complete it.
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    connectorId: text("connector_id")
      .notNull()
      .references(() => connectors.id),
    // The connection to reauthorize; null for a new connection. The foreign
    // key (connection_id, workspace_id) → connections pins it to this
    // workspace and goes with the connection.
    connectionId: uuid("connection_id"),
    purpose: text("purpose").notNull(),
    // Whether the grant may come from a different provider account than the
    // one linked to the connection (reauthorization only).
    allowAccountChange: boolean("allow_account_change")
      .notNull()
      .default(false),
    // Relative path inside the web app to return to (allowlisted by the API).
    returnPath: text("return_path").notNull(),
    stateHash: text("state_hash").notNull().unique(),
    nonce: text("nonce").notNull(),
    codeVerifierEncrypted: bytea("code_verifier_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "oauth_authorizations_connection_fk",
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete("cascade"),
    check(
      "oauth_authorizations_purpose_valid",
      sql`${table.purpose} in ('connect', 'reauthorize')`,
    ),
    check(
      "oauth_authorizations_purpose_connection",
      sql`(${table.purpose} = 'reauthorize') = (${table.connectionId} is not null)`,
    ),
    check(
      "oauth_authorizations_account_change",
      sql`not ${table.allowAccountChange} or ${table.purpose} = 'reauthorize'`,
    ),
    check(
      "oauth_authorizations_return_path",
      sql`${table.returnPath} like '/%' and ${table.returnPath} not like '//%'`,
    ),
    index("oauth_authorizations_workspace_idx").on(table.workspaceId),
    index("oauth_authorizations_connection_idx").on(table.connectionId),
    index("oauth_authorizations_expires_idx").on(table.expiresAt),
  ],
);

// The OAuth grant of a connection (ADR 0012), 1:1. The refresh token stays
// in connections.credentials_encrypted; this row holds the linked account,
// the granted scopes and the cached access token in its own envelope (its
// associated data names it an access token, so it cannot be swapped with the
// credentials envelope). Workspace table under RLS.
export const connectionOAuth = pgTable(
  "connection_oauth",
  {
    connectionId: uuid("connection_id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    // The provider's stable account id (OpenID `sub`).
    accountSub: text("account_sub").notNull(),
    // Shown as "Connected as …"; not a secret, but never logged.
    accountEmail: text("account_email"),
    grantedScopes: text("granted_scopes").array().notNull(),
    accessTokenEncrypted: bytea("access_token_encrypted"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "connection_oauth_connection_fk",
      columns: [table.connectionId, table.workspaceId],
      foreignColumns: [connections.id, connections.workspaceId],
    }).onDelete("cascade"),
    check(
      "connection_oauth_access_token_expiry",
      sql`(${table.accessTokenEncrypted} is null) = (${table.accessTokenExpiresAt} is null)`,
    ),
    // The shared-grant check on disconnect (oauth_release_grant, #133).
    index("connection_oauth_provider_sub_idx").on(
      table.provider,
      table.accountSub,
    ),
    index("connection_oauth_workspace_idx").on(table.workspaceId),
  ],
);
