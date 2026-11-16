ALTER TABLE "dashboard_slides" ADD COLUMN "logo_image_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD COLUMN "scope" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD CONSTRAINT "dashboard_slides_logo_image_fk" FOREIGN KEY ("logo_image_id","workspace_id") REFERENCES "public"."workspace_images"("id","workspace_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "dashboard_slides_logo_image_idx" ON "dashboard_slides" USING btree ("logo_image_id");--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD CONSTRAINT "dashboard_slides_scope_object" CHECK (jsonb_typeof("dashboard_slides"."scope") = 'object');