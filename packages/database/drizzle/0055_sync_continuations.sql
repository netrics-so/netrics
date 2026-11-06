ALTER TABLE "jobs" DROP CONSTRAINT "jobs_status_valid";--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_status_valid";--> statement-breakpoint
DROP INDEX "jobs_claim_idx";--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at") WHERE "jobs"."status" in ('pending', 'continuing');--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_status_valid" CHECK ("jobs"."status" in ('pending', 'running', 'continuing', 'succeeded', 'failed', 'dead'));--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_status_valid" CHECK ("sync_runs"."status" in ('running', 'succeeded', 'failed', 'continued'));
--> statement-breakpoint
-- Keep existing scheduler-only grants and hardened search_path. Distinguish
-- continued work from a newly queued sync so both can wait without a unique
-- index conflict, and the later job cannot overwrite an active checkpoint.
CREATE OR REPLACE FUNCTION claim_jobs(p_worker_id text, p_limit integer, p_stale_after interval)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_candidate jobs%ROWTYPE;
  v_claimed jobs%ROWTYPE;
  v_count integer := 0;
  v_seen uuid[] := '{}';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('netrics.claim_jobs'));

  UPDATE jobs
  SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' WHEN payload ? 'continuation' THEN 'continuing' ELSE 'pending' END,
      attempts = attempts + 1,
      run_at = now() + least(
        power(2, attempts + 1) * interval '15 seconds',
        interval '15 minutes'
      ),
      locked_by = NULL,
      locked_at = NULL,
      last_error = 'stale lock requeued'
  WHERE status = 'running' AND locked_at < now() - p_stale_after;

  FOR v_candidate IN
    SELECT j.* FROM jobs j
    WHERE j.status IN ('pending', 'continuing') AND j.run_at <= now()
    ORDER BY j.run_at
    FOR UPDATE SKIP LOCKED
  LOOP
    EXIT WHEN v_count >= p_limit;
    IF v_candidate.kind LIKE 'connection.%' AND v_candidate.connection_id IS NOT NULL THEN
      CONTINUE WHEN v_candidate.connection_id = ANY(v_seen);
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM jobs r
        WHERE r.status = 'running'
          AND r.kind LIKE 'connection.%'
          AND r.connection_id = v_candidate.connection_id
      );
      -- A checkpoint owns this connection until it finishes or is cancelled.
      -- Other connections still run while its next segment waits.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM jobs c
        WHERE c.status = 'continuing'
          AND c.kind LIKE 'connection.%'
          AND c.connection_id = v_candidate.connection_id
          AND c.id <> v_candidate.id
          AND (v_candidate.status = 'pending'
               OR (c.created_at, c.id) < (v_candidate.created_at, v_candidate.id))
      );
      v_seen := array_append(v_seen, v_candidate.connection_id);
    END IF;
    UPDATE jobs
    SET status = 'running', locked_by = p_worker_id, locked_at = now()
    WHERE id = v_candidate.id
    RETURNING * INTO v_claimed;
    v_count := v_count + 1;
    RETURN NEXT v_claimed;
  END LOOP;
  RETURN;
END;
$$;
