-- #214, ADR 0015: Dashboard Studio. A dashboard becomes an ordered list
-- of slides, each a 12 × 8 grid of widgets; dashboards get rotation and
-- header settings. Every existing dashboard moves forward without user
-- action (ADR 0015 section 4): one slide (a second for more than 16 tiles),
-- every tile a metric widget with the same id, laid out like the TV grid
-- today. dashboard_tiles stays (expand/contract) and the server keeps it in
-- step until a later migration drops it; devices keep their dashboard_id.
CREATE TABLE "dashboard_slides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text,
	"duration_seconds" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "dashboard_slides_id_dashboard_workspace_unique" UNIQUE("id","dashboard_id","workspace_id"),
	CONSTRAINT "dashboard_slides_position_valid" CHECK ("dashboard_slides"."position" >= 0),
	CONSTRAINT "dashboard_slides_name_valid" CHECK ("dashboard_slides"."name" is null or char_length("dashboard_slides"."name") between 1 and 60),
	CONSTRAINT "dashboard_slides_duration_valid" CHECK ("dashboard_slides"."duration_seconds" is null or "dashboard_slides"."duration_seconds" between 5 and 3600)
);
--> statement-breakpoint
CREATE TABLE "dashboard_widgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slide_id" uuid NOT NULL,
	"dashboard_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"x" smallint NOT NULL,
	"y" smallint NOT NULL,
	"w" smallint NOT NULL,
	"h" smallint NOT NULL,
	"title" text,
	"connection_id" uuid,
	"metric_key" text,
	"aggregation" text,
	"period" text,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_currency" text,
	"text" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'text', 'clock')),
	CONSTRAINT "dashboard_widgets_grid_valid" CHECK ("dashboard_widgets"."x" >= 0 and "dashboard_widgets"."y" >= 0 and "dashboard_widgets"."w" >= 1 and "dashboard_widgets"."h" >= 1 and "dashboard_widgets"."x" + "dashboard_widgets"."w" <= 12 and "dashboard_widgets"."y" + "dashboard_widgets"."h" <= 8),
	CONSTRAINT "dashboard_widgets_title_valid" CHECK ("dashboard_widgets"."title" is null or char_length("dashboard_widgets"."title") between 1 and 100),
	CONSTRAINT "dashboard_widgets_text_valid" CHECK ("dashboard_widgets"."text" is null or char_length("dashboard_widgets"."text") <= 500),
	CONSTRAINT "dashboard_widgets_aggregation_valid" CHECK ("dashboard_widgets"."aggregation" is null or "dashboard_widgets"."aggregation" in ('sum', 'avg', 'min', 'max', 'last')),
	CONSTRAINT "dashboard_widgets_period_valid" CHECK ("dashboard_widgets"."period" is null or "dashboard_widgets"."period" in ('today', 'last_7_days', 'last_30_days', 'this_month', 'last_90_days', 'last_12_months')),
	CONSTRAINT "dashboard_widgets_type_columns" CHECK (case when "dashboard_widgets"."type" in ('metric', 'line', 'bar') then "dashboard_widgets"."connection_id" is not null and "dashboard_widgets"."metric_key" is not null and "dashboard_widgets"."aggregation" is not null and "dashboard_widgets"."period" is not null and "dashboard_widgets"."text" is null else "dashboard_widgets"."connection_id" is null and "dashboard_widgets"."metric_key" is null and "dashboard_widgets"."aggregation" is null and "dashboard_widgets"."period" is null and "dashboard_widgets"."display_currency" is null and "dashboard_widgets"."dimensions" = '{}'::jsonb and ("dashboard_widgets"."text" is not null) = ("dashboard_widgets"."type" = 'text') end)
);
--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "show_header" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "auto_advance" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "default_slide_seconds" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "transition" text DEFAULT 'fade' NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD CONSTRAINT "dashboard_slides_dashboard_fk" FOREIGN KEY ("dashboard_id","workspace_id") REFERENCES "public"."dashboards"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_slide_fk" FOREIGN KEY ("slide_id","dashboard_id","workspace_id") REFERENCES "public"."dashboard_slides"("id","dashboard_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_slides_workspace_idx" ON "dashboard_slides" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_slide_idx" ON "dashboard_widgets" USING btree ("slide_id");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_dashboard_idx" ON "dashboard_widgets" USING btree ("dashboard_id");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_connection_idx" ON "dashboard_widgets" USING btree ("connection_id");--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_default_slide_seconds_valid" CHECK ("dashboards"."default_slide_seconds" between 5 and 3600);--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_transition_valid" CHECK ("dashboards"."transition" in ('none', 'fade'));--> statement-breakpoint
-- Positions are unique per dashboard; deferrable, so a save can reorder
-- slides inside one transaction (drizzle cannot express it).
ALTER TABLE "dashboard_slides" ADD CONSTRAINT "dashboard_slides_position_unique" UNIQUE ("dashboard_id", "position") DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
-- The data move reads and writes every workspace. The migration role is the
-- superuser/BYPASSRLS owner (see 0006); with row_security off, any other
-- role fails here instead of silently seeing no tiles.
SET LOCAL row_security = off;
--> statement-breakpoint
-- One slide per started 16 tiles, at least one per dashboard.
INSERT INTO "dashboard_slides" ("dashboard_id", "workspace_id", "position")
SELECT d."id", d."workspace_id", s."position"
FROM "dashboards" d
LEFT JOIN (
  SELECT "dashboard_id", count(*)::int AS "tiles"
  FROM "dashboard_tiles"
  GROUP BY "dashboard_id"
) c ON c."dashboard_id" = d."id"
CROSS JOIN LATERAL generate_series(0, greatest(coalesce(c."tiles", 0) - 1, 0) / 16) AS s("position");
--> statement-breakpoint
-- Tiles in reading order, 16 per slide, placed like legacyLayout in
-- packages/domain (studio-layout.ts, #215). Columns and rows per slide come
-- from this lookup table, generated from legacyGrid and checked against it in
-- studio-migration.test.ts. Columns split the 12 columns evenly; row r starts
-- at floor(r * 8 / rows).
WITH "grid" ("tiles", "columns", "rows") AS (
  VALUES (1, 1, 1), (2, 2, 1), (3, 3, 1), (4, 2, 2), (5, 3, 2), (6, 3, 2),
         (7, 4, 2), (8, 4, 2), (9, 3, 3), (10, 4, 3), (11, 4, 3), (12, 4, 3),
         (13, 4, 4), (14, 4, 4), (15, 4, 4), (16, 4, 4)
),
"ordered" AS (
  SELECT t.*,
         (row_number() OVER (PARTITION BY t."dashboard_id" ORDER BY t."position", t."id") - 1)::int AS "idx",
         (count(*) OVER (PARTITION BY t."dashboard_id"))::int AS "total"
  FROM "dashboard_tiles" t
),
"cells" AS (
  SELECT o.*, o."idx" / 16 AS "slide", g."columns", g."rows",
         (o."idx" % 16) % g."columns" AS "col",
         (o."idx" % 16) / g."columns" AS "row"
  FROM "ordered" o
  JOIN "grid" g ON g."tiles" = least(16, o."total" - (o."idx" / 16) * 16)
)
INSERT INTO "dashboard_widgets" ("id", "slide_id", "dashboard_id",
  "workspace_id", "type", "x", "y", "w", "h", "title", "connection_id",
  "metric_key", "aggregation", "period", "dimensions", "display_currency")
SELECT c."id", s."id", c."dashboard_id", c."workspace_id", 'metric',
       c."col" * (12 / c."columns"),
       (c."row" * 8) / c."rows",
       12 / c."columns",
       ((c."row" + 1) * 8) / c."rows" - (c."row" * 8) / c."rows",
       nullif(left(c."title", 100), ''), c."connection_id", c."metric_key",
       c."aggregation", c."period", c."dimensions", c."display_currency"
FROM "cells" c
JOIN "dashboard_slides" s
  ON s."dashboard_id" = c."dashboard_id" AND s."position" = c."slide";
--> statement-breakpoint
-- Every tile arrived.
DO $$
BEGIN
  IF (SELECT count(*) FROM "dashboard_tiles") <> (SELECT count(*) FROM "dashboard_widgets") THEN
    RAISE EXCEPTION 'dashboard studio migration: tiles and widgets differ';
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL row_security = on;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "dashboard_slides", "dashboard_widgets" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "dashboard_slides" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_slides" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "dashboard_widgets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "dashboard_slides_select" ON "dashboard_slides" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_slides_insert" ON "dashboard_slides" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_slides_update" ON "dashboard_slides" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_slides_delete" ON "dashboard_slides" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widgets_select" ON "dashboard_widgets" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widgets_insert" ON "dashboard_widgets" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widgets_update" ON "dashboard_widgets" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "dashboard_widgets_delete" ON "dashboard_widgets" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
