-- #635: a global cap on backfills per OAuth app. The per-workspace throttle
-- (#617) keeps one workspace from running several automatic backfills at
-- once; a provider app shared by every workspace (a hosted Google OAuth app,
-- for example) has one quota for all of them. claim_jobs gains
-- p_backfills_per_app: a connection.backfill of an OAuth connection is not
-- claimed while that many backfills of the same connector and OAuth provider
-- run or wait to continue, in any workspace. NULL or 0 claims as before.
--
-- A backfill that hands over to a continuation keeps its slot until it
-- finishes. Among continuing backfills the older ones go first, so lowering
-- the cap never blocks every holder at once. Connections without OAuth (own
-- API keys, workspace keys) are not capped here: their quotas are per
-- workspace and the per-workspace throttle covers them.
--
-- Runs as the owner like before (SECURITY DEFINER; the superuser/BYPASSRLS
-- migration role, see 0006), so it can read connections and connection_oauth
-- (connector and provider only; never credentials) without a scheduler
-- grant on them.
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
  v_count integer := 0;
  v_seen uuid[] := '{}';
  v_connector text;
  v_provider text;
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
      -- Backfills share the OAuth app's quota across workspaces (#635).
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
-- The three-argument form stays for workers of the previous release during
-- a rolling deploy: it claims without the cap.
CREATE OR REPLACE FUNCTION claim_jobs(p_worker_id text, p_limit integer, p_stale_after interval)
RETURNS SETOF jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT * FROM claim_jobs(p_worker_id, p_limit, p_stale_after, NULL::integer);
$$;
