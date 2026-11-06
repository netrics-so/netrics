-- #332 (ADR 0019 sections 2 and 6): the table widget. `table` joins the
-- widget types and uses the metric binding columns like `bar`; its
-- options (groupBy, limit, showChange, showOthers) live in `options`.
-- Each later type widens these checks for its own key (ADR 0019 §2).
--
-- Existing rows: every stored type keeps satisfying both checks (the
-- lists only grow); nothing is rewritten.
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_columns";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table'));--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_columns" CHECK (case when "dashboard_widgets"."type" in ('metric', 'line', 'bar', 'table') then "dashboard_widgets"."connection_id" is not null and "dashboard_widgets"."metric_key" is not null and "dashboard_widgets"."aggregation" is not null and "dashboard_widgets"."period" is not null and "dashboard_widgets"."text" is null else "dashboard_widgets"."connection_id" is null and "dashboard_widgets"."metric_key" is null and "dashboard_widgets"."aggregation" is null and "dashboard_widgets"."period" is null and "dashboard_widgets"."display_currency" is null and "dashboard_widgets"."dimensions" = '{}'::jsonb and ("dashboard_widgets"."text" is not null) = ("dashboard_widgets"."type" = 'text') end);