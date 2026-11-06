-- #217 (ADR 0015, section 5): workspace images in PostgreSQL, and the
-- dashboard columns that use them (logo, slide background, image widget).
--
-- workspace_images: raster images up to 1 MiB with their metadata already
-- stripped by the API. The bytes are already compressed, so TOAST stores
-- them out of line without compressing them again (STORAGE EXTERNAL). RLS
-- scopes the table to the tenant context like every other workspace table;
-- images are immutable, so the application role gets no UPDATE.
--
-- The image references are composite foreign keys (image, workspace), so a
-- dashboard can only use an image of its own workspace. A referenced image
-- cannot be deleted (the API answers 409 image_in_use first). The keys are
-- deferred to the end of the transaction, because deleting a workspace
-- reaches widgets two cascades deep, after its images: an immediate check
-- would refuse it. The API sets them IMMEDIATE when it deletes an image.
--
-- Existing rows: the new columns are null (background_dim 0) and the new
-- checks hold for every existing widget type; nothing is rewritten.
CREATE TABLE "workspace_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea" NOT NULL,
	"origin" text DEFAULT 'upload' NOT NULL,
	"connection_id" uuid,
	"resource_id" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_images_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "workspace_images_content_type_valid" CHECK ("workspace_images"."content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "workspace_images_bytes_valid" CHECK ("workspace_images"."bytes" > 0 and "workspace_images"."bytes" <= 1048576 and "workspace_images"."bytes" = octet_length("workspace_images"."content")),
	CONSTRAINT "workspace_images_dimensions_valid" CHECK ("workspace_images"."width" between 1 and 4096 and "workspace_images"."height" between 1 and 4096 and "workspace_images"."width"::bigint * "workspace_images"."height" <= 16777216),
	CONSTRAINT "workspace_images_sha256_valid" CHECK ("workspace_images"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workspace_images_origin_valid" CHECK (("workspace_images"."origin" = 'upload' and "workspace_images"."connection_id" is null and "workspace_images"."resource_id" is null) or ("workspace_images"."origin" = 'resource_icon' and "workspace_images"."connection_id" is not null and "workspace_images"."resource_id" is not null)),
	CONSTRAINT "workspace_images_name_valid" CHECK (char_length("workspace_images"."name") <= 100)
);
--> statement-breakpoint
ALTER TABLE "dashboard_widgets" DROP CONSTRAINT "dashboard_widgets_type_valid";--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD COLUMN "background_image_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD COLUMN "background_dim" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "logo_image_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_images" ADD CONSTRAINT "workspace_images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_images" ADD CONSTRAINT "workspace_images_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_images_workspace_idx" ON "workspace_images" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD CONSTRAINT "dashboard_slides_background_image_fk" FOREIGN KEY ("background_image_id","workspace_id") REFERENCES "public"."workspace_images"("id","workspace_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_image_fk" FOREIGN KEY ("image_id","workspace_id") REFERENCES "public"."workspace_images"("id","workspace_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_logo_image_fk" FOREIGN KEY ("logo_image_id","workspace_id") REFERENCES "public"."workspace_images"("id","workspace_id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE INDEX "dashboard_slides_background_image_idx" ON "dashboard_slides" USING btree ("background_image_id");--> statement-breakpoint
CREATE INDEX "dashboard_widgets_image_idx" ON "dashboard_widgets" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "dashboards_logo_image_idx" ON "dashboards" USING btree ("logo_image_id");--> statement-breakpoint
ALTER TABLE "dashboard_slides" ADD CONSTRAINT "dashboard_slides_background_dim_valid" CHECK ("dashboard_slides"."background_dim" between 0 and 80);--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_image_valid" CHECK (("dashboard_widgets"."image_id" is not null) = ("dashboard_widgets"."type" = 'image'));--> statement-breakpoint
ALTER TABLE "dashboard_widgets" ADD CONSTRAINT "dashboard_widgets_type_valid" CHECK ("dashboard_widgets"."type" in ('metric', 'line', 'bar', 'image', 'text', 'clock'));
--> statement-breakpoint
ALTER TABLE "workspace_images" ALTER COLUMN "content" SET STORAGE EXTERNAL;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "workspace_images" TO netrics_app;
--> statement-breakpoint
-- The schema's default privileges include UPDATE; images never change.
REVOKE UPDATE, TRUNCATE ON "workspace_images" FROM netrics_app;
--> statement-breakpoint
ALTER TABLE "workspace_images" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_images" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "workspace_images_select" ON "workspace_images" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "workspace_images_insert" ON "workspace_images" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "workspace_images_delete" ON "workspace_images" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
