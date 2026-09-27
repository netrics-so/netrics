CREATE TABLE "connection_state" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"last_success_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"cursor" text,
	"auth_state" text DEFAULT 'ok' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "connection_state_auth_state_valid" CHECK ("connection_state"."auth_state" in ('ok', 'auth_failed', 'outage'))
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"connector_id" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" "bytea",
	"credentials_key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"workspace_id" uuid,
	"connection_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('pending', 'running', 'succeeded', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "metric_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"unit" text NOT NULL,
	"dimensions" jsonb NOT NULL,
	"aggregations" jsonb NOT NULL,
	CONSTRAINT "metric_definitions_connector_id_key_unique" UNIQUE("connector_id","key"),
	CONSTRAINT "metric_definitions_kind_valid" CHECK ("metric_definitions"."kind" in ('gauge', 'delta', 'counter'))
);
--> statement-breakpoint
CREATE TABLE "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"metric_definition_id" uuid NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"value" double precision NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_identity" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observations_connection_id_source_identity_unique" UNIQUE("connection_id","source_identity")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"requested_from" timestamp with time zone NOT NULL,
	"requested_to" timestamp with time zone NOT NULL,
	"cursor_before" text,
	"cursor_after" text,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"error_class" text,
	"error_message" text,
	"observations_written" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sync_runs_mode_valid" CHECK ("sync_runs"."mode" in ('backfill', 'incremental')),
	CONSTRAINT "sync_runs_status_valid" CHECK ("sync_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "sync_runs_error_class_valid" CHECK ("sync_runs"."error_class" in ('auth', 'transient', 'contract', 'budget'))
);
--> statement-breakpoint
ALTER TABLE "connection_state" ADD CONSTRAINT "connection_state_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_state" ADD CONSTRAINT "connection_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observations" ADD CONSTRAINT "observations_metric_definition_id_metric_definitions_id_fk" FOREIGN KEY ("metric_definition_id") REFERENCES "public"."metric_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "observations_workspace_metric_time_idx" ON "observations" USING btree ("workspace_id","metric_definition_id","source_timestamp");--> statement-breakpoint
CREATE INDEX "observations_connection_time_idx" ON "observations" USING btree ("connection_id","source_timestamp");--> statement-breakpoint
CREATE INDEX "sync_runs_connection_started_idx" ON "sync_runs" USING btree ("connection_id","started_at" DESC NULLS LAST);--> statement-breakpoint
-- RLS + grants (hand-written per ADR 0001). connectors and metric_definitions
-- are installation-level catalogs: no RLS. The tenant tables and jobs follow
-- migration 0001's workspace-context pattern; jobs adds a second policy class
-- for the scheduler role (ADR 0006).
GRANT SELECT, INSERT, UPDATE, DELETE ON "connectors", "metric_definitions" TO netrics_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "connections", "connection_state", "observations", "sync_runs" TO netrics_app;
--> statement-breakpoint
-- Jobs are archival: nobody gets DELETE. netrics_app enqueues and retries
-- jobs of its own workspace; netrics_scheduler claims/advances across all
-- workspaces. The default privileges from migration 0001 granted netrics_app
-- DELETE on this new table, so revoke it explicitly.
REVOKE DELETE ON "jobs" FROM netrics_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "jobs" TO netrics_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO netrics_scheduler;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "jobs" TO netrics_scheduler;
--> statement-breakpoint
-- The scheduler plans due syncs from connection_state alone and must never
-- read credential material: it gets NO grant on connections at all (column-
-- level grant here, scheduler-only policy below).
GRANT SELECT (connection_id, workspace_id, next_due_at) ON "connection_state" TO netrics_scheduler;
--> statement-breakpoint
-- connections.credentials_encrypted is an AES-256-GCM envelope; it must only
-- be read by code paths that decrypt (apps/server/src/credentials.ts).
ALTER TABLE "connections" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connections" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection_state" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sync_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sync_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connections_select" ON "connections" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connections_insert" ON "connections" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connections_update" ON "connections" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connections_delete" ON "connections" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_state_select" ON "connection_state" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_state_insert" ON "connection_state" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_state_update" ON "connection_state" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_state_delete" ON "connection_state" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Scheduler-wide read for due-sync planning (column grant above keeps it to
-- connection_id / workspace_id / next_due_at).
CREATE POLICY "connection_state_scheduler_select" ON "connection_state" FOR SELECT
  USING (current_user = 'netrics_scheduler');
--> statement-breakpoint
CREATE POLICY "observations_select" ON "observations" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "observations_insert" ON "observations" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "observations_update" ON "observations" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "observations_delete" ON "observations" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "sync_runs_select" ON "sync_runs" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "sync_runs_insert" ON "sync_runs" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "sync_runs_update" ON "sync_runs" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "sync_runs_delete" ON "sync_runs" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Tenant class: enqueue and retry happen inside tenant transactions, so the
-- app role only ever touches its own workspace's jobs (strict: workspace_id
-- NULL rows are installation-internal and invisible to tenants).
CREATE POLICY "jobs_select" ON "jobs" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "jobs_insert" ON "jobs" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "jobs_update" ON "jobs" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Scheduler class: claiming/advancing is workspace-agnostic.
CREATE POLICY "jobs_scheduler_select" ON "jobs" FOR SELECT
  USING (current_user = 'netrics_scheduler');
--> statement-breakpoint
CREATE POLICY "jobs_scheduler_update" ON "jobs" FOR UPDATE
  USING (current_user = 'netrics_scheduler')
  WITH CHECK (current_user = 'netrics_scheduler');
--> statement-breakpoint
-- Default privileges from migration 0001 already cover netrics_app for future
-- tables. netrics_scheduler deliberately gets NO default privileges: every
-- scheduler grant is added explicitly, per table, in the migration that needs
-- it.
