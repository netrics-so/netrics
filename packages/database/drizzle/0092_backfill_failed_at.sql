-- #787: a backfill that died with its retries used up left no durable trace
-- on the connection: history_from is null, but it is also null when the
-- history start is only unknown, and the jobs and sync runs that tell the
-- two apart are pruned by the history retention. The connection page then
-- reported the history as complete. The sync engine now records a failed
-- backfill attempt in backfill_failed_at and clears it when a backfill
-- succeeds; while no backfill waits or runs, the history is incomplete.
-- Every sync writes connection_state: a lock not granted within 5 s fails the
-- migration (to be re-run) instead of queueing those writes behind a
-- long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "backfill_failed_at" timestamp with time zone;--> statement-breakpoint
-- Existing connections whose latest backfill attempt failed, from the runs
-- still stored (the same reading as 0084 for history_from). A run that only
-- waited for a provider's rate limit (#781) is no failure. Never a
-- connection with a known history start: a backfill succeeded last.
UPDATE "connection_state" AS cs
SET "backfill_failed_at" = latest."failed_at"
FROM (
  SELECT DISTINCT ON ("connection_id")
    "connection_id", "status", coalesce("finished_at", "started_at") AS "failed_at"
  FROM "sync_runs"
  WHERE "mode" = 'backfill'
    AND ("status" = 'succeeded'
      OR ("status" = 'failed' AND "error_class" IS DISTINCT FROM 'rate_limited'))
  ORDER BY "connection_id", "started_at" DESC
) AS latest
WHERE latest."connection_id" = cs."connection_id"
  AND latest."status" = 'failed'
  AND cs."history_from" IS NULL;--> statement-breakpoint
-- ... and those whose latest backfill job died without a failed run (a
-- worker that stopped mid-run until the attempts were used up). A job
-- superseded by a newer backfill did not fail.
UPDATE "connection_state" AS cs
SET "backfill_failed_at" = latest."created_at"
FROM (
  SELECT DISTINCT ON ("connection_id")
    "connection_id", "status", "last_error", "created_at"
  FROM "jobs"
  WHERE "kind" = 'connection.backfill' AND "connection_id" IS NOT NULL
  ORDER BY "connection_id", "created_at" DESC
) AS latest
WHERE latest."connection_id" = cs."connection_id"
  AND cs."history_from" IS NULL
  AND cs."backfill_failed_at" IS NULL
  AND (latest."status" = 'dead'
    OR (latest."status" = 'failed'
      AND latest."last_error" IS DISTINCT FROM 'superseded by a newer backfill'));--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
