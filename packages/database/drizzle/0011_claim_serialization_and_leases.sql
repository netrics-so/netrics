-- #33: job claiming and leases.
--
-- 1. claim_jobs serializes on a transaction-scoped advisory lock. Two claims
--    running concurrently could each miss the other's uncommitted 'running'
--    row and both start a job for the same connection; serialized claims
--    always see committed siblings. Claims are short, so this is cheap.
-- 2. A stale lease requeues with the same exponential backoff as a failure,
--    so a job that crashes its worker cannot crash-loop the fleet.
-- 3. Workers renew their lease while a handler runs (renewJobLease), and
--    complete/fail are fenced on locked_by, so a reclaimed job has exactly
--    one owner.
CREATE INDEX IF NOT EXISTS "jobs_running_connection"
  ON "jobs" USING btree ("connection_id")
  WHERE "status" = 'running';
--> statement-breakpoint
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
  SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'pending' END,
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
    WHERE j.status = 'pending' AND j.run_at <= now()
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
