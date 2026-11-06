-- #339 (ADR 0019 sections 2 and 5): the goal widget. `gauge` joins the
-- widget types; it has no metric binding (dashboard_widgets_type_columns
-- already holds it to none, like a clock) and names its goal in `goal_id`.
-- The key keeps the goal in the widget's workspace. Deleting a goal clears
-- only `goal_id` (PostgreSQL 15+ column list; drizzle writes plain SET NULL,
-- which would also clear workspace_id): the widget stays and shows "Goal
-- deleted". Its option (showTimeLeft) lives in `options`.
--
-- Existing rows: a new nullable column, no rewrite; every stored type keeps
-- satisfying the checks (the type list only grows, goal_id is null).
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "goal_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_goal_fk" FOREIGN KEY ("goal_id","workspace_id") REFERENCES "public"."goals"("id","workspace_id") ON DELETE SET NULL ("goal_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_widgets_goal_idx" ON "dashboard_widgets" USING btree ("goal_id");--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_goal_valid" CHECK ("dashboard_widgets"."goal_id" is null or "dashboard_widgets"."type" = 'gauge');--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table', 'status', 'compare', 'countdown', 'gauge'));
