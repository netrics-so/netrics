-- #40: jobs integrity and history retention.
--
-- 1. jobs.connection_id references connections. Deleting a connection keeps
--    its jobs as history with connection_id set to NULL (the API cancels the
--    pending ones first). Jobs of connections deleted before this constraint
--    existed get the same treatment, so the constraint holds for old data.
UPDATE "jobs" j
SET "connection_id" = NULL,
    "status" = CASE WHEN j."status" = 'pending' THEN 'failed' ELSE j."status" END,
    "last_error" = CASE WHEN j."status" = 'pending' THEN 'connection deleted' ELSE j."last_error" END
WHERE j."connection_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "connections" c WHERE c."id" = j."connection_id");
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- 2. claim_jobs' running-per-connection check. Migration 0011 created this
--    index in SQL only; it now lives in the Drizzle schema too.
CREATE INDEX IF NOT EXISTS "jobs_running_connection" ON "jobs" USING btree ("connection_id") WHERE "jobs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_finished_created_idx" ON "jobs" USING btree ("created_at") WHERE "jobs"."status" in ('succeeded', 'failed', 'dead');--> statement-breakpoint
-- 3. History retention, run by the scheduler (netrics_scheduler has no DELETE
--    on these tables; the function runs as the owner, like claim_jobs).
--    Deletes at most p_batch rows per table per call, so a first run on a
--    large backlog stays short; the scheduler calls it again later.
--    - jobs: finished jobs by age. Failed and dead jobs are kept longer than
--      succeeded ones for dead-letter inspection.
--    - sync_runs: finished runs by age, except each connection's latest run,
--      so "last sync" never disappears.
CREATE OR REPLACE FUNCTION prune_history(
  p_succeeded_jobs interval,
  p_failed_jobs interval,
  p_sync_runs interval,
  p_batch integer
)
RETURNS TABLE (jobs_deleted integer, sync_runs_deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM jobs
  WHERE id IN (
    SELECT j.id FROM jobs j
    WHERE (j.status = 'succeeded' AND j.created_at < now() - p_succeeded_jobs)
       OR (j.status IN ('failed', 'dead') AND j.created_at < now() - p_failed_jobs)
    LIMIT p_batch
  );
  GET DIAGNOSTICS jobs_deleted = ROW_COUNT;

  DELETE FROM sync_runs
  WHERE id IN (
    SELECT s.id FROM sync_runs s
    WHERE s.status <> 'running'
      AND s.finished_at < now() - p_sync_runs
      AND EXISTS (
        SELECT 1 FROM sync_runs newer
        WHERE newer.connection_id = s.connection_id
          AND newer.started_at > s.started_at
      )
    LIMIT p_batch
  );
  GET DIAGNOSTICS sync_runs_deleted = ROW_COUNT;

  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_history(interval, interval, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_history(interval, interval, interval, integer) TO netrics_scheduler;
