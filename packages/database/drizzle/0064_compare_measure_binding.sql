-- A compare widget may name the model of its measure binding (#507). This
-- only relaxes the check: every existing compare row has neither, which
-- still holds.
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_model_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_model_valid" CHECK (case when "dashboard_widgets"."type" = 'measure' then "dashboard_widgets"."model_id" is not null and "dashboard_widgets"."model_binding" is not null when "dashboard_widgets"."type" = 'compare' then ("dashboard_widgets"."model_id" is null) = ("dashboard_widgets"."model_binding" is null) else "dashboard_widgets"."model_id" is null and "dashboard_widgets"."model_binding" is null end);
