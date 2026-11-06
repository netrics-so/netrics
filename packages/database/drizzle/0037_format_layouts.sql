-- #275, ADR 0017 sections 4 and 8: a primary format per dashboard and
-- custom layouts per slide and format. Every existing dashboard becomes a
-- 16x9 dashboard (the column default) with no custom layouts, so every other
-- format is auto and nothing changes on any screen. The widget grid check is
-- relaxed to the largest grid of any format (16 x 14); the service checks
-- the exact grid of the dashboard's primary format. Existing rows satisfy
-- the relaxed check, so no data is rewritten.
CREATE TABLE "dashboard_slide_layouts" (
	"slide_id" uuid NOT NULL,
	"format" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"pages" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_slide_layouts_pk" PRIMARY KEY("slide_id","format"),
	CONSTRAINT "dashboard_slide_layouts_slide_format_workspace_unique" UNIQUE("slide_id","format","workspace_id"),
	CONSTRAINT "dashboard_slide_layouts_format_valid" CHECK ("dashboard_slide_layouts"."format" in ('16x9', '21x9', '4x3', '3x4', '9x16')),
	CONSTRAINT "dashboard_slide_layouts_pages_valid" CHECK ("dashboard_slide_layouts"."pages" between 1 and 8)
);
--> statement-breakpoint
CREATE TABLE "dashboard_widget_layouts" (
	"widget_id" uuid NOT NULL,
	"format" text NOT NULL,
	"slide_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page" smallint NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"w" smallint NOT NULL,
	"h" smallint NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"auto_placed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dashboard_widget_layouts_pk" PRIMARY KEY("widget_id","format"),
	CONSTRAINT "dashboard_widget_layouts_page_valid" CHECK ("dashboard_widget_layouts"."page" between 0 and 7),
	CONSTRAINT "dashboard_widget_layouts_grid_valid" CHECK ("dashboard_widget_layouts"."x" >= 0 and "dashboard_widget_layouts"."y" >= 0 and "dashboard_widget_layouts"."w" >= 1 and "dashboard_widget_layouts"."h" >= 1 and "dashboard_widget_layouts"."x" + "dashboard_widget_layouts"."w" <= 16 and "dashboard_widget_layouts"."y" + "dashboard_widget_layouts"."h" <= 14)
);
--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_grid_valid";--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "primary_format" text DEFAULT '16x9' NOT NULL;--> statement-breakpoint
-- Before the foreign key that references it (drizzle orders it last).
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_id_slide_workspace_unique" UNIQUE("id","slide_id","workspace_id");--> statement-breakpoint
ALTER TABLE "dashboard_slide_layouts" ADD CONSTRAINT "dashboard_slide_layouts_slide_fk" FOREIGN KEY ("slide_id","dashboard_id","workspace_id") REFERENCES "public"."dashboard_slides"("id","dashboard_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widget_layouts" ADD CONSTRAINT "dashboard_widget_layouts_widget_fk" FOREIGN KEY ("widget_id","slide_id","workspace_id") REFERENCES "public"."dashboard_widgets"("id","slide_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widget_layouts" ADD CONSTRAINT "dashboard_widget_layouts_layout_fk" FOREIGN KEY ("slide_id","format","workspace_id") REFERENCES "public"."dashboard_slide_layouts"("slide_id","format","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_slide_layouts_workspace_idx" ON "dashboard_slide_layouts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dashboard_slide_layouts_dashboard_idx" ON "dashboard_slide_layouts" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "dashboard_widget_layouts_workspace_idx" ON "dashboard_widget_layouts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dashboard_widget_layouts_layout_idx" ON "dashboard_widget_layouts" USING btree ("slide_id","format");--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_grid_valid" CHECK ("dashboard_widgets"."x" >= 0 and "dashboard_widgets"."y" >= 0 and "dashboard_widgets"."w" >= 1 and "dashboard_widgets"."h" >= 1 and "dashboard_widgets"."x" + "dashboard_widgets"."w" <= 16 and "dashboard_widgets"."y" + "dashboard_widgets"."h" <= 14);--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_primary_format_valid" CHECK ("dashboards"."primary_format" in ('16x9', '21x9', '4x3', '3x4', '9x16'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "dashboard_slide_layouts", "dashboard_widget_layouts" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "dashboard_slide_layouts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_slide_layouts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_widget_layouts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_widget_layouts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "dashboard_slide_layouts_select" ON "dashboard_slide_layouts" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_slide_layouts_insert" ON "dashboard_slide_layouts" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_slide_layouts_update" ON "dashboard_slide_layouts" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_slide_layouts_delete" ON "dashboard_slide_layouts" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widget_layouts_select" ON "dashboard_widget_layouts" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widget_layouts_insert" ON "dashboard_widget_layouts" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widget_layouts_update" ON "dashboard_widget_layouts" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widget_layouts_delete" ON "dashboard_widget_layouts" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
