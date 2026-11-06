-- #336 (ADR 0019 sections 2 and 10): the compare widget. `compare` joins
-- the widget types and uses the metric binding columns for its numerator
-- like `bar`; its denominator is a second binding in four new columns,
-- required exactly for `compare`. A deleted connection deletes the widget
-- whichever side it is on (cascade). Period and display currency are
-- shared by both sides.
--
-- Existing rows: the new columns are null (dimensions '{}'), which every
-- stored type satisfies; the type lists only grow; nothing is rewritten.
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_columns";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "denominator_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "denominator_metric_key" text;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "denominator_aggregation" text;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "denominator_dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_denominator_connection_fk" FOREIGN KEY ("denominator_connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_widgets_denominator_connection_idx" ON "dashboard_widgets" USING btree ("denominator_connection_id");--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_denominator_columns" CHECK (case when "dashboard_widgets"."type" = 'compare' then "dashboard_widgets"."denominator_connection_id" is not null and "dashboard_widgets"."denominator_metric_key" is not null and "dashboard_widgets"."denominator_aggregation" in ('sum', 'avg', 'min', 'max', 'last') else "dashboard_widgets"."denominator_connection_id" is null and "dashboard_widgets"."denominator_metric_key" is null and "dashboard_widgets"."denominator_aggregation" is null and "dashboard_widgets"."denominator_dimensions" = '{}'::jsonb end);--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table', 'status', 'compare'));--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_columns" CHECK (case when "dashboard_widgets"."type" in ('metric', 'line', 'bar', 'table', 'compare') then "dashboard_widgets"."connection_id" is not null and "dashboard_widgets"."metric_key" is not null and "dashboard_widgets"."aggregation" is not null and "dashboard_widgets"."period" is not null and "dashboard_widgets"."text" is null else "dashboard_widgets"."connection_id" is null and "dashboard_widgets"."metric_key" is null and "dashboard_widgets"."aggregation" is null and "dashboard_widgets"."period" is null and "dashboard_widgets"."display_currency" is null and "dashboard_widgets"."dimensions" = '{}'::jsonb and ("dashboard_widgets"."text" is not null) = ("dashboard_widgets"."type" = 'text') end);