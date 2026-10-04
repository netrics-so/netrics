-- #338 (ADR 0019 sections 2 and 7): the status board. `status` joins the
-- widget types and uses no binding columns, which the existing
-- dashboard_widgets_type_columns check already demands of every type that
-- is not metric-bound (no connection, metric, period, currency, filters or
-- text). Its options (connectionIds, showAge) live in `options`.
--
-- Existing rows: every stored type keeps satisfying the check (the list
-- only grows); nothing is rewritten.
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table', 'status'));
