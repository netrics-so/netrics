-- #340 (ADR 0019 sections 2 and 12): the latest-review widget. `review`
-- joins the widget types; it binds a connection (connection_id, and an
-- optional resource filter in dimensions) without a metric, and may name
-- its app's icon in image_id. Its options (minRating, requireText,
-- showAuthor) live in `options`.
--
-- Existing rows: every stored widget keeps satisfying all three checks (each
-- only admits more); nothing is rewritten.
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_image_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_columns";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table', 'status', 'compare', 'countdown', 'gauge', 'review'));--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_image_valid" CHECK ("dashboard_widgets"."type" = 'review' or ("dashboard_widgets"."image_id" is not null) = ("dashboard_widgets"."type" = 'image'));--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_columns" CHECK (case when "dashboard_widgets"."type" in ('metric', 'line', 'bar', 'table', 'compare') then "dashboard_widgets"."connection_id" is not null and "dashboard_widgets"."metric_key" is not null and "dashboard_widgets"."aggregation" is not null and "dashboard_widgets"."period" is not null and "dashboard_widgets"."text" is null when "dashboard_widgets"."type" = 'review' then "dashboard_widgets"."connection_id" is not null and "dashboard_widgets"."metric_key" is null and "dashboard_widgets"."aggregation" is null and "dashboard_widgets"."period" is null and "dashboard_widgets"."display_currency" is null and "dashboard_widgets"."text" is null else "dashboard_widgets"."connection_id" is null and "dashboard_widgets"."metric_key" is null and "dashboard_widgets"."aggregation" is null and "dashboard_widgets"."period" is null and "dashboard_widgets"."display_currency" is null and "dashboard_widgets"."dimensions" = '{}'::jsonb and ("dashboard_widgets"."text" is not null) = ("dashboard_widgets"."type" = 'text') end);