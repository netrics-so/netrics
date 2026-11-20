-- #378: where a connection's read history starts. An empty widget window
-- reads 0 only over days the connection has read: from the start of the
-- window its last backfill read completely up to the freshness stream's
-- dataThrough. The sync engine sets history_from when a backfill succeeds
-- and clears it when one fails, so a backfill that never finished (a key
-- refused halfway) claims no history.
-- Every sync writes connection_state: a lock not granted within 5 s fails the
-- migration (to be re-run) instead of queueing those writes behind a
-- long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "history_from" timestamp with time zone;--> statement-breakpoint
-- Existing connections: the window of their latest backfill run, when that
-- run succeeded. Older runs are pruned after the history retention; such a
-- connection gets its history start with its next backfill.
UPDATE "connection_state" AS cs
SET "history_from" = latest."requested_from"
FROM (
  SELECT DISTINCT ON ("connection_id") "connection_id", "requested_from", "status"
  FROM "sync_runs"
  WHERE "mode" = 'backfill' AND "status" IN ('succeeded', 'failed')
  ORDER BY "connection_id", "started_at" DESC
) AS latest
WHERE latest."connection_id" = cs."connection_id"
  AND latest."status" = 'succeeded';--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
