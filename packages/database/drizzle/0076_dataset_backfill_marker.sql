-- Which datasets a connection's backfill has read (#617). Only additions:
-- nullable columns, and a request counter that is 0 for every existing
-- row. Existing rows keep every value; a null record is read by the sync
-- engine as "not recorded yet" and derived once from the connection's
-- backfill runs. The app role already has table-wide grants on
-- connection_state; the scheduler role gets none of these.
ALTER TABLE "connection_state" ADD COLUMN "backfilled_datasets" jsonb;--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "backfill_job_datasets" jsonb;--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "backfill_requested_datasets" jsonb;--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "backfill_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "backfill_request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "history_reload_requested_at" timestamp with time zone;