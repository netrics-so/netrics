-- Incremental connector dataset staging (ADR 0024, #525).
--
-- A stage is now written page by page: begin inserts a draft header
-- (committed_at null), each append stores pages and adds their bytes to
-- byte_size, and commit sets metadata, digest, committed_at and the final
-- deadline. Readers only see committed stages. A draft lives within one
-- connector call; its expires_at is at most 15 minutes after begin, so an
-- abandoned draft stops counting toward the staging budget and is pruned like
-- any expired stage (prune_dataset_history_batch, 0065, unchanged).
-- admin_set_data_policy and apply_connection_retention (0066) already update
-- every row of data_connector_stages, drafts included.
--
-- New pages are stored as gzip-compressed JSON text in payload_gzip, and
-- byte_size counts those stored bytes. Pages written before this migration
-- keep their JSONB payload and stay readable until their stage expires (at
-- most one day).
--
-- Existing stages were written in one transaction, so all of them are
-- committed.
ALTER TABLE "data_connector_stages" ADD COLUMN "committed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "data_connector_stages" SET "committed_at" = "source_collected_at";--> statement-breakpoint
ALTER TABLE "data_connector_stages" DROP CONSTRAINT "data_connector_stages_connection_key";--> statement-breakpoint
CREATE UNIQUE INDEX "data_connector_stages_connection_key" ON "data_connector_stages" USING btree ("connection_id","key") WHERE "data_connector_stages"."committed_at" is not null;--> statement-breakpoint
ALTER TABLE "data_connector_stage_pages" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_connector_stage_pages" ADD COLUMN "payload_gzip" "bytea";--> statement-breakpoint
ALTER TABLE "data_connector_stage_pages" ADD CONSTRAINT "data_connector_stage_pages_gzip_size" CHECK (octet_length("data_connector_stage_pages"."payload_gzip") <= 2097152);--> statement-breakpoint
ALTER TABLE "data_connector_stage_pages" ADD CONSTRAINT "data_connector_stage_pages_one_payload" CHECK (("data_connector_stage_pages"."payload" is null) <> ("data_connector_stage_pages"."payload_gzip" is null));--> statement-breakpoint
-- Writes a draft needs: appends add to byte_size; commit sets metadata,
-- digest, committed_at and expires_at once.
GRANT UPDATE(metadata, digest, committed_at, expires_at) ON data_connector_stages TO netrics_app;--> statement-breakpoint
-- The application can change a stage only while it is a draft, and never to
-- a deadline beyond one day after collection or beyond the source deadline
-- that policy and connection-retention changes maintain. A committed stage is
-- immutable to the application; retention functions (SECURITY DEFINER) still
-- shorten its deadlines.
CREATE POLICY data_connector_stages_draft_update ON data_connector_stages
 AS RESTRICTIVE FOR UPDATE TO netrics_app
 USING (committed_at IS NULL)
 WITH CHECK (
   expires_at <= source_collected_at + interval '1 day'
   AND (source_expires_at IS NULL OR expires_at <= source_expires_at)
 );
