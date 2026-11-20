-- Custom API definitions (milestone 13, #803): a workspace's own API
-- descriptions, stored as immutable versions, and the pin of a custom-api
-- connection to one version and one environment. Additive: existing
-- connections are bundled ones and keep an empty pin.
-- connections is read and written by every request path: a lock not granted
-- within 5 s fails the migration (to be re-run) instead of queueing those
-- requests behind a long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "custom_api_definition_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"document_sha256" text NOT NULL,
	"dataset_versions" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_api_definition_versions_definition_version_unique" UNIQUE("definition_id","version"),
	CONSTRAINT "custom_api_definition_versions_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "custom_api_definition_versions_version_positive" CHECK ("custom_api_definition_versions"."version" > 0),
	CONSTRAINT "custom_api_definition_versions_document_object" CHECK (jsonb_typeof("custom_api_definition_versions"."document") = 'object'),
	CONSTRAINT "custom_api_definition_versions_dataset_versions_object" CHECK (jsonb_typeof("custom_api_definition_versions"."dataset_versions") = 'object'),
	CONSTRAINT "custom_api_definition_versions_sha256" CHECK ("custom_api_definition_versions"."document_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "custom_api_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"current_version" integer NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_api_definitions_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "custom_api_definitions_current_version_positive" CHECK ("custom_api_definitions"."current_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "custom_api_definition_version_id" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "custom_api_environment_id" text;--> statement-breakpoint
ALTER TABLE "custom_api_definition_versions" ADD CONSTRAINT "custom_api_definition_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_api_definition_versions" ADD CONSTRAINT "custom_api_definition_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_api_definition_versions" ADD CONSTRAINT "custom_api_definition_versions_definition_fk" FOREIGN KEY ("definition_id","workspace_id") REFERENCES "public"."custom_api_definitions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_api_definitions" ADD CONSTRAINT "custom_api_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_api_definitions" ADD CONSTRAINT "custom_api_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_api_definitions" ADD CONSTRAINT "custom_api_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_api_definitions_workspace_archived_idx" ON "custom_api_definitions" USING btree ("workspace_id","archived_at");--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_custom_api_version_fk" FOREIGN KEY ("custom_api_definition_version_id","workspace_id") REFERENCES "public"."custom_api_definition_versions"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connections_custom_api_version_idx" ON "connections" USING btree ("workspace_id","custom_api_definition_version_id");--> statement-breakpoint
-- Added without checking the existing rows, then validated: every existing
-- connection is a bundled one with both new columns null.
ALTER TABLE "connections" ADD CONSTRAINT "connections_custom_api_pin" CHECK (("connections"."connector_id" = 'custom-api') = ("connections"."custom_api_definition_version_id" is not null) and ("connections"."custom_api_definition_version_id" is null) = ("connections"."custom_api_environment_id" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_custom_api_pin";--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;--> statement-breakpoint
ALTER TABLE custom_api_definitions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE custom_api_definitions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY custom_api_definitions_tenant ON custom_api_definitions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE custom_api_definition_versions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE custom_api_definition_versions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY custom_api_definition_versions_tenant ON custom_api_definition_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- The default privileges (0001) grant netrics_app everything on new tables:
-- narrow them. Definitions are archived, never deleted; versions are
-- immutable.
REVOKE ALL ON custom_api_definitions FROM netrics_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON custom_api_definitions TO netrics_app;--> statement-breakpoint
REVOKE ALL ON custom_api_definition_versions FROM netrics_app;--> statement-breakpoint
GRANT SELECT, INSERT ON custom_api_definition_versions TO netrics_app;--> statement-breakpoint
-- The catalog row the connections foreign key needs. The connector is not in
-- the bundled registry (its manifest is per connection), so the boot-time
-- catalog sync never writes this row.
INSERT INTO connectors (id, version, manifest) VALUES ('custom-api', '1.0.0', '{"id":"custom-api","name":"Custom API"}'::jsonb) ON CONFLICT (id) DO NOTHING;