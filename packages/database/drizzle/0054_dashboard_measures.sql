ALTER TABLE "dashboard_widgets" ADD COLUMN "model_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "model_binding" jsonb;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "filter_exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "data_filters" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_model_fk" FOREIGN KEY ("model_id","workspace_id") REFERENCES "public"."data_models"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_widgets_model_idx" ON "dashboard_widgets" USING btree ("model_id");--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_model_valid" CHECK (case when "dashboard_widgets"."type" = 'measure' then "dashboard_widgets"."model_id" is not null and "dashboard_widgets"."model_binding" is not null else "dashboard_widgets"."model_id" is null and "dashboard_widgets"."model_binding" is null end);--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock', 'table', 'status', 'compare', 'countdown', 'gauge', 'review', 'measure'));
