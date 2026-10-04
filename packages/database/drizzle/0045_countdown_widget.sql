-- #337 (ADR 0019 sections 2 and 8): the countdown widget. `countdown` joins
-- the widget types without binding columns (the existing else branch of
-- dashboard_widgets_type_columns already requires them empty); its options
-- (target, timeZone, showTarget, doneText) live in `options`.
--
-- Existing rows: every stored type keeps satisfying the check (the list
-- only grows); nothing is rewritten.
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table', 'status', 'compare', 'countdown'));