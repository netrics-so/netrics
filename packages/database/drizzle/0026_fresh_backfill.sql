-- #153: a backfill job reads its connector's whole backfill window, unless the
-- connection's cursor is its own checkpoint (a retried or reclaimed attempt of
-- the same job), which it resumes. backfill_job_id names the backfill job the
-- cursor continues; existing rows start with none, so the next backfill of
-- every connection is a fresh one. No foreign key: job rows are pruned.
ALTER TABLE "connection_state" ADD COLUMN "backfill_job_id" uuid;--> statement-breakpoint
-- At most one waiting backfill per connection: a new request (a config change
-- that affects collected data) supersedes the waiting one. Backfills were
-- deduplicated by the key backfill:<connection id> until now, so duplicates
-- can only come from other enqueuers; keep the earliest, retire the rest.
UPDATE "jobs" SET "status" = 'failed', "last_error" = 'superseded by an earlier pending backfill'
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "connection_id" ORDER BY "run_at", "created_at"
    ) AS rn
    FROM "jobs"
    WHERE "kind" = 'connection.backfill' AND "status" = 'pending'
      AND "connection_id" IS NOT NULL
  ) ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_pending_backfill" ON "jobs" USING btree ("connection_id") WHERE "jobs"."kind" = 'connection.backfill' and "jobs"."status" = 'pending';
