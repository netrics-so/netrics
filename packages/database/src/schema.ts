import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
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
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  authUserId: text("auth_user_id").unique(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  // May use the installation admin API (/v1/admin/*). The first-run setup
  // account is one; installation-level, never granted by a workspace role.
  isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
// RLS policies (migration 0001) grant no UPDATE/DELETE path.
export const auditEvents = pgTable("audit_events", {
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
});

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
  },
  (table) => [
    unique().on(table.connectorId, table.key),
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

export const connections = pgTable("connections", {
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

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
    authState: text("auth_state").notNull().default("ok"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  },
  (table) => [
    check(
      "connection_state_auth_state_valid",
      sql`${table.authState} in ('ok', 'auth_failed', 'outage')`,
    ),
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
    connectionId: uuid("connection_id"),
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
  ],
);
