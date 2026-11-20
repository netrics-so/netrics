-- Custom API item images (milestone 13, issue #809; spec section 8). After a
-- sync, the images of a stream's newest items are copied into
-- workspace_images with origin 'custom_api': at most 2 MiB each (uploads
-- stay 1 MiB), with their own quota, never with connection or resource
-- provenance. custom_api_item_images maps (workspace, sha256 of the URL) to
-- the stored image; custom_api_stream_images keeps the last outcome per
-- stream (stored, unchanged, skipped by reason).
--
-- Each check is swapped in one statement, so no moment exists without it.
-- Existing uploads and resource icons satisfy both new checks unchanged.
CREATE TABLE "custom_api_item_images" (
	"workspace_id" uuid NOT NULL,
	"url_sha256" text NOT NULL,
	"image_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "custom_api_item_images_pk" PRIMARY KEY("workspace_id","url_sha256"),
	CONSTRAINT "custom_api_item_images_url_sha256_valid" CHECK ("custom_api_item_images"."url_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "custom_api_stream_images" (
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"stream_key" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"stored" integer NOT NULL,
	"unchanged" integer NOT NULL,
	"skipped" integer NOT NULL,
	"skipped_reasons" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "custom_api_stream_images_pk" PRIMARY KEY("connection_id","stream_key"),
	CONSTRAINT "custom_api_stream_images_counts_valid" CHECK ("custom_api_stream_images"."stored" >= 0 and "custom_api_stream_images"."unchanged" >= 0 and "custom_api_stream_images"."skipped" >= 0)
);
--> statement-breakpoint
ALTER TABLE "custom_api_item_images" ADD CONSTRAINT "custom_api_item_images_image_fk" FOREIGN KEY ("image_id","workspace_id") REFERENCES "public"."workspace_images"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_api_stream_images" ADD CONSTRAINT "custom_api_stream_images_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_api_item_images_seen_idx" ON "custom_api_item_images" USING btree ("workspace_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "custom_api_item_images_image_idx" ON "custom_api_item_images" USING btree ("image_id");--> statement-breakpoint
CREATE INDEX "custom_api_stream_images_workspace_idx" ON "custom_api_stream_images" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_images_custom_api_sha_idx" ON "workspace_images" USING btree ("workspace_id","sha256") WHERE "workspace_images"."origin" = 'custom_api';--> statement-breakpoint
ALTER TABLE "workspace_images" DROP CONSTRAINT "workspace_images_bytes_valid", ADD CONSTRAINT "workspace_images_bytes_valid" CHECK ("workspace_images"."bytes" > 0 and "workspace_images"."bytes" <= case when "workspace_images"."origin" = 'custom_api' then 2097152 else 1048576 end and "workspace_images"."bytes" = octet_length("workspace_images"."content"));--> statement-breakpoint
ALTER TABLE "workspace_images" DROP CONSTRAINT "workspace_images_origin_valid", ADD CONSTRAINT "workspace_images_origin_valid" CHECK (("workspace_images"."origin" = 'upload' and "workspace_images"."connection_id" is null and "workspace_images"."resource_id" is null) or ("workspace_images"."origin" = 'resource_icon' and "workspace_images"."connection_id" is not null and "workspace_images"."resource_id" is not null) or ("workspace_images"."origin" = 'custom_api' and "workspace_images"."connection_id" is null and "workspace_images"."resource_id" is null));--> statement-breakpoint
ALTER TABLE custom_api_item_images ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_api_item_images FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY custom_api_item_images_tenant ON custom_api_item_images
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE custom_api_stream_images ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_api_stream_images FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY custom_api_stream_images_tenant ON custom_api_stream_images
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_api_item_images, custom_api_stream_images TO netrics_app;
--> statement-breakpoint
-- Garbage collection, run by the scheduler's maintenance as the owner (like
-- prune_revoked_devices, migration 0070): netrics_scheduler has no grant on
-- these tables. First up to p_batch lookup rows unseen for p_grace, then up
-- to p_batch custom_api images that no lookup row refers to. An image is kept
-- for an hour after its insert, so an image whose lookup upsert has not yet
-- committed (or lost a race to another one) is not deleted under it, and
-- an image a dashboard still names is kept. Returns the rows deleted; a
-- count of 2 * p_batch means more may remain for the next run.
CREATE FUNCTION prune_custom_api_item_images(
  p_now timestamptz,
  p_grace interval,
  p_batch integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  lookups integer;
  images integer;
BEGIN
  DELETE FROM custom_api_item_images
  WHERE (workspace_id, url_sha256) IN (
    SELECT l.workspace_id, l.url_sha256 FROM custom_api_item_images l
    WHERE l.last_seen_at < p_now - p_grace
    LIMIT p_batch
  );
  GET DIAGNOSTICS lookups = ROW_COUNT;
  DELETE FROM workspace_images
  WHERE id IN (
    SELECT i.id FROM workspace_images i
    WHERE i.origin = 'custom_api'
      AND i.created_at < p_now - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM custom_api_item_images l
        WHERE l.workspace_id = i.workspace_id AND l.image_id = i.id)
      AND NOT EXISTS (
        SELECT 1 FROM dashboards d
        WHERE d.workspace_id = i.workspace_id AND d.logo_image_id = i.id)
      AND NOT EXISTS (
        SELECT 1 FROM dashboard_slides s
        WHERE s.workspace_id = i.workspace_id
          AND (s.background_image_id = i.id OR s.logo_image_id = i.id))
      AND NOT EXISTS (
        SELECT 1 FROM dashboard_widgets w
        WHERE w.workspace_id = i.workspace_id AND w.image_id = i.id)
    LIMIT p_batch
  );
  GET DIAGNOSTICS images = ROW_COUNT;
  RETURN lookups + images;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_custom_api_item_images(timestamptz, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_custom_api_item_images(timestamptz, interval, integer) TO netrics_scheduler;
