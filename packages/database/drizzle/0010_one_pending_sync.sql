-- #31: the scheduler deduplicated syncs per clock hour, so a connection with
-- a 5-minute poll interval synced at most hourly. Syncs now dedupe per due
-- slot, and at most one sync may wait per connection.
--
-- Existing installations may hold several pending syncs for a connection;
-- keep the earliest and retire the rest before adding the index.
UPDATE "jobs" SET "status" = 'failed', "last_error" = 'superseded by an earlier pending sync'
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "connection_id" ORDER BY "run_at", "created_at"
    ) AS rn
    FROM "jobs"
    WHERE "kind" = 'connection.sync' AND "status" = 'pending'
  ) ranked
  WHERE ranked.rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_pending_sync" ON "jobs" USING btree ("connection_id") WHERE "jobs"."kind" = 'connection.sync' and "jobs"."status" = 'pending';
--> statement-breakpoint
-- enqueue_sync_job: a pending sync for the connection (or the same due-slot
-- key) makes the enqueue a no-op that returns NULL, instead of an error.
CREATE OR REPLACE FUNCTION enqueue_sync_job(p_connection_id uuid, p_workspace_id uuid, p_kind text, p_run_at timestamp with time zone, p_idempotency_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM connections
    WHERE id = p_connection_id AND workspace_id = p_workspace_id
  ) THEN
    RAISE EXCEPTION 'connection_workspace_mismatch' USING ERRCODE = 'foreign_key_violation';
  END IF;
  INSERT INTO jobs (kind, workspace_id, connection_id, payload, run_at, idempotency_key)
  VALUES (
    p_kind,
    p_workspace_id,
    p_connection_id,
    jsonb_build_object('workspace_id', p_workspace_id, 'connection_id', p_connection_id),
    p_run_at,
    p_idempotency_key
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
