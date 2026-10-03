-- #194: names of a connection's resources (apps, projects, properties), so
-- a tile can show one resource by name. The sync engine refreshes them from
-- the connector's discover at most daily; RLS scopes the table to the tenant
-- context like every other workspace table. A new, empty table: existing
-- data is untouched.
CREATE TABLE "connection_resources" (
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_resources_connection_id_resource_id_pk" PRIMARY KEY("connection_id","resource_id")
);
--> statement-breakpoint
ALTER TABLE "connection_resources" ADD CONSTRAINT "connection_resources_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_resources_workspace_idx" ON "connection_resources" USING btree ("workspace_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "connection_resources" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "connection_resources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection_resources" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connection_resources_select" ON "connection_resources" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_resources_insert" ON "connection_resources" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_resources_update" ON "connection_resources" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_resources_delete" ON "connection_resources" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
