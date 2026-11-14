-- Archived projects and a project on preparations and models (#572). Nothing
-- is archived and every existing preparation and model stays unassigned.
ALTER TABLE "data_models" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "data_preparations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "data_models" ADD CONSTRAINT "data_models_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_preparations" ADD CONSTRAINT "data_preparations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_models_project_idx" ON "data_models" USING btree ("workspace_id","project_id");--> statement-breakpoint
CREATE INDEX "data_preparations_project_idx" ON "data_preparations" USING btree ("workspace_id","project_id");