-- #781 review: claim_jobs as in 0080, with two changes.
--
-- 1. The stale-lock requeue puts each stale job back on its own. A job that
--    would wait as `pending` beside another waiting job of its kind for the
--    same connection (jobs_one_pending_sync, jobs_one_pending_backfill: for
--    example a "Sync now" queued while it ran) no longer fails the whole
--    claim with a duplicate key, which stopped every worker from claiming
--    anything. The waiting job stays and runs no sooner than the requeued
--    one would have; the stale one ends as `failed`, superseded.
--
-- 2. The per-app backfill cap (#635) no longer counts a continuing backfill
--    whose connection waits for a provider's rate-limit reset
--    (connection_state.rate_limited_until in the future, up to a day): it
--    holds no provider quota while it waits, so other workspaces' backfills
--    of the same OAuth app may run meanwhile. Once the reset has passed it
--    counts again; until a slot is free it waits. Every other continuing
--    backfill keeps its slot until it finishes, as in 0080: one between two
--    segments (run_at a second ahead) and one waiting out a retry backoff
--    (failJob or the stale requeue, 30 s to 15 min) alike. The waiting
--    backfill still owns its connection (the continuing check below is
--    unchanged), so the connection's incremental sync does not run ahead.
--
-- SECURITY DEFINER under the migration role as before (0006, 0080).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE OR REPLACE FUNCTION claim_jobs(
  p_worker_id text,
  p_limit integer,
  p_stale_after interval,
  p_backfills_per_app integer
)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_candidate jobs%ROWTYPE;
  v_claimed jobs%ROWTYPE;
  v_stale jobs%ROWTYPE;
  v_status text;
  v_run_at timestamptz;
  v_count integer := 0;
  v_seen uuid[] := '{}';
  v_connector text;
  v_provider text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('netrics.claim_jobs'));

  FOR v_stale IN
    SELECT * FROM jobs
    WHERE status = 'running' AND locked_at < now() - p_stale_after
    ORDER BY locked_at
    FOR UPDATE SKIP LOCKED
  LOOP
    v_status := CASE
      WHEN v_stale.attempts + 1 >= v_stale.max_attempts THEN 'dead'
      WHEN v_stale.payload ? 'continuation' THEN 'continuing'
      ELSE 'pending'
    END;
    v_run_at := now() + least(
      power(2, v_stale.attempts + 1) * interval '15 seconds',
      interval '15 minutes'
    );
    BEGIN
      UPDATE jobs
      SET status = v_status,
          attempts = attempts + 1,
          run_at = v_run_at,
          locked_by = NULL,
          locked_at = NULL,
          last_error = 'stale lock requeued'
      WHERE id = v_stale.id;
    EXCEPTION WHEN unique_violation THEN
      UPDATE jobs
      SET run_at = greatest(run_at, v_run_at)
      WHERE kind = v_stale.kind
        AND connection_id = v_stale.connection_id
        AND status = 'pending'
        AND id <> v_stale.id;
      UPDATE jobs
      SET status = 'failed',
          attempts = attempts + 1,
          locked_by = NULL,
          locked_at = NULL,
          last_error = 'stale lock requeued (superseded by a waiting job of the connection)'
      WHERE id = v_stale.id;
    END;
  END LOOP;

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
      -- A checkpoint owns this connection until it finishes or is cancelled,
      -- also while it waits for a later run_at. Other connections still run.
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM jobs c
        WHERE c.status = 'continuing'
          AND c.kind LIKE 'connection.%'
          AND c.connection_id = v_candidate.connection_id
          AND c.id <> v_candidate.id
          AND (v_candidate.status = 'pending'
               OR (c.created_at, c.id) < (v_candidate.created_at, v_candidate.id))
      );
      -- Backfills share the OAuth app's quota across workspaces (#635). A
      -- continuing one whose connection waits for a rate-limit reset holds
      -- no slot (#781); every other one keeps its slot until it finishes.
      IF v_candidate.kind = 'connection.backfill' AND coalesce(p_backfills_per_app, 0) > 0 THEN
        v_connector := NULL;
        v_provider := NULL;
        SELECT c.connector_id, o.provider INTO v_connector, v_provider
        FROM connections c
        JOIN connection_oauth o ON o.connection_id = c.id
        WHERE c.id = v_candidate.connection_id;
        CONTINUE WHEN v_provider IS NOT NULL AND (
          SELECT count(*) FROM jobs b
          JOIN connections bc ON bc.id = b.connection_id
          JOIN connection_oauth bo ON bo.connection_id = b.connection_id
          WHERE b.kind = 'connection.backfill'
            AND b.id <> v_candidate.id
            AND bc.connector_id = v_connector
            AND bo.provider = v_provider
            AND (b.status = 'running'
                 OR (b.status = 'continuing'
                     AND NOT EXISTS (
                       SELECT 1 FROM connection_state s
                       WHERE s.connection_id = b.connection_id
                         AND s.rate_limited_until > now())
                     AND (v_candidate.status = 'pending'
                          OR (b.created_at, b.id) < (v_candidate.created_at, v_candidate.id))))
        ) >= p_backfills_per_app;
      END IF;
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_jobs(text, integer, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_jobs(text, integer, interval, integer) TO netrics_scheduler;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
