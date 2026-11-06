-- #49: tile dashboards. Composite foreign keys keep each tile in the
-- workspace of its dashboard and its connection; RLS scopes both tables to
-- the tenant context like every other workspace table.
--
-- The tile → connection key needs (id, workspace_id) to be unique on
-- connections; id alone already is, so this cannot fail on existing rows.
ALTER TABLE "connections" ADD CONSTRAINT "connections_id_workspace_unique" UNIQUE("id","workspace_id");
--> statement-breakpoint
CREATE TABLE "dashboard_tiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"aggregation" text NOT NULL,
	"period" text NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text,
	"position" integer NOT NULL,
	CONSTRAINT "dashboard_tiles_aggregation_valid" CHECK ("dashboard_tiles"."aggregation" in ('sum', 'avg', 'min', 'max', 'last')),
	CONSTRAINT "dashboard_tiles_period_valid" CHECK ("dashboard_tiles"."period" in ('today', 'last_7_days', 'last_30_days', 'this_month')),
	CONSTRAINT "dashboard_tiles_position_valid" CHECK ("dashboard_tiles"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboards_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "dashboards_version_positive" CHECK ("dashboards"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "dashboard_tiles" ADD CONSTRAINT "dashboard_tiles_dashboard_fk" FOREIGN KEY ("dashboard_id","workspace_id") REFERENCES "public"."dashboards"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_tiles" ADD CONSTRAINT "dashboard_tiles_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_tiles_dashboard_idx" ON "dashboard_tiles" USING btree ("dashboard_id","position");--> statement-breakpoint
CREATE INDEX "dashboard_tiles_connection_idx" ON "dashboard_tiles" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "dashboards_workspace_idx" ON "dashboards" USING btree ("workspace_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "dashboards", "dashboard_tiles" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboards" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_tiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_tiles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "dashboards_select" ON "dashboards" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboards_insert" ON "dashboards" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboards_update" ON "dashboards" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboards_delete" ON "dashboards" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_tiles_select" ON "dashboard_tiles" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_tiles_insert" ON "dashboard_tiles" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_tiles_update" ON "dashboard_tiles" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_tiles_delete" ON "dashboard_tiles" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
