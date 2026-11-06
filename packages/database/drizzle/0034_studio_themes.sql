-- #216 (ADR 0015, section 6): custom dashboard themes and a theme per
-- dashboard. Existing dashboards get the built-in "netrics_dark" (the
-- column default fills them), which is today's palette, so nothing changes
-- on any screen. A dashboard references a custom theme with a composite key,
-- so the theme is always in the dashboard's workspace.
CREATE TABLE "workspace_themes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base" text NOT NULL,
	"tokens" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_themes_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "workspace_themes_version_positive" CHECK ("workspace_themes"."version" >= 1),
	CONSTRAINT "workspace_themes_tokens_object" CHECK (jsonb_typeof("workspace_themes"."tokens") = 'object')
);
--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "theme_builtin" text DEFAULT 'netrics_dark';--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "theme_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "accent_color" text;--> statement-breakpoint
ALTER TABLE "workspace_themes" ADD CONSTRAINT "workspace_themes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_themes_name_unique" ON "workspace_themes" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_theme_fk" FOREIGN KEY ("theme_id","workspace_id") REFERENCES "public"."workspace_themes"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboards_theme_idx" ON "dashboards" USING btree ("theme_id") WHERE "dashboards"."theme_id" is not null;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_one_theme" CHECK (("dashboards"."theme_builtin" is null) <> ("dashboards"."theme_id" is null));--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_theme_builtin_format" CHECK ("dashboards"."theme_builtin" ~ '^[a-z][a-z0-9_]{0,39}$');--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_accent_color_format" CHECK ("dashboards"."accent_color" ~ '^#[0-9a-f]{6}$');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "workspace_themes" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "workspace_themes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_themes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_themes_select" ON "workspace_themes" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "workspace_themes_insert" ON "workspace_themes" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "workspace_themes_update" ON "workspace_themes" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "workspace_themes_delete" ON "workspace_themes" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
