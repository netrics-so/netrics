-- Which datasets a connection's backfill has read (#617). All three columns
-- are nullable additions: existing rows keep every value and start with
-- null, which the sync engine reads as "not recorded yet" and derives once
-- from the connection's backfill runs. The app role already has table-wide
-- grants on connection_state; the scheduler role gets none of these.
ALTER TABLE "connection_state" ADD COLUMN "backfilled_datasets" jsonb;--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "backfill_requested_datasets" jsonb;--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "history_reload_requested_at" timestamp with time zone;