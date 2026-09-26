-- Scheduler/worker queue mechanics (ADR 0006, milestone 03 slice 3).
--
-- The scheduler plans due syncs from connection_state alone and must never
-- read credential material (no grant on connections). It therefore cannot
-- look up the connector manifest's refresh interval: poll_interval_seconds is
-- denormalized onto connection_state by the API at connection-creation time,
-- and auth_state is added to the scheduler's column grant so it can skip
-- auth_failed connections (credential repair happens through the API; the
-- worker owns re-enabling syncs).
ALTER TABLE "connection_state" ADD COLUMN "poll_interval_seconds" integer DEFAULT 300 NOT NULL;
--> statement-breakpoint
GRANT SELECT (poll_interval_seconds, auth_state) ON "connection_state" TO netrics_scheduler;
--> statement-breakpoint
GRANT UPDATE (next_due_at) ON "connection_state" TO netrics_scheduler;
--> statement-breakpoint
-- Migration 0005 only created the scheduler SELECT policy; the UPDATE needs
-- its own (permissive) policy for the row to be visible to the statement.
CREATE POLICY "connection_state_scheduler_update" ON "connection_state" FOR UPDATE
  USING (current_user = 'netrics_scheduler')
  WITH CHECK (current_user = 'netrics_scheduler');
--> statement-breakpoint
-- The scheduler enqueues due syncs itself (enqueue_sync_job below wraps this
-- in idempotency-key dedup).
GRANT INSERT ON "jobs" TO netrics_scheduler;
--> statement-breakpoint
CREATE POLICY "jobs_scheduler_insert" ON "jobs" FOR INSERT
  WITH CHECK (current_user = 'netrics_scheduler');
--> statement-breakpoint
-- Installation-level ops data (which workers/scheduler are alive): no RLS.
-- Migration 0001's default privileges granted netrics_app S/I/U/D on this new
-- table; narrow it to SELECT (future admin UI) — only the scheduler role
-- (used by both worker and scheduler processes) may write heartbeats.
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "worker_heartbeats_role_valid" CHECK ("worker_heartbeats"."role" in ('worker', 'scheduler'))
);
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON "worker_heartbeats" FROM netrics_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "worker_heartbeats" TO netrics_scheduler;
--> statement-breakpoint
-- Claims up to p_limit due jobs for a worker. SECURITY DEFINER under the
-- migration role (superuser/BYPASSRLS in dev and tests — the same assumption
-- create_workspace() documents), so claiming deliberately bypasses tenant
-- RLS: the scheduler role claims across all workspaces by design and never
-- sets app.workspace_id.
--
-- Invariants:
--  1. Stale running jobs (locked_at older than p_stale_after, i.e. the worker
--     crashed) are requeued to pending with attempts + 1; once attempts would
--     exceed max_attempts the job goes straight to dead.
--  2. Claiming sets status/locked_by/locked_at; attempts is NOT incremented
--     on claim — attempts counts failures (failJob / stale requeue).
--  3. Per-connection serialization: at most one claimed/running job of a
--     connection.* kind per connection_id, both within one claim batch
--     (v_seen) and against already-running jobs.
--  4. SKIP LOCKED gives concurrent claimers disjoint batches.
-- Caveat: two claim statements running truly concurrently do not see each
-- other's uncommitted running rows, so (3) is best-effort across simultaneous
-- claims; committed running jobs are always respected. Handlers must stay
-- idempotent regardless (at-least-once, ADR 0006).
CREATE OR REPLACE FUNCTION claim_jobs(p_worker_id text, p_limit integer, p_stale_after interval)
RETURNS SETOF jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidate jobs%ROWTYPE;
  v_claimed jobs%ROWTYPE;
  v_count integer := 0;
  v_seen uuid[] := '{}';
BEGIN
  UPDATE jobs
  SET status = CASE WHEN attempts + 1 > max_attempts THEN 'dead' ELSE 'pending' END,
      attempts = attempts + 1,
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_jobs(text, integer, interval) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_jobs(text, integer, interval) TO netrics_scheduler;
--> statement-breakpoint
-- Idempotent enqueue for the scheduler: ON CONFLICT on the idempotency key
-- suppresses duplicates (returns NULL). Every job carries workspace_id and
-- connection_id both as columns and inside the payload (milestone invariant;
-- the worker executor rejects mismatches as tampering). SECURITY DEFINER so
-- the scheduler role can enqueue for any workspace without a tenant context.
CREATE OR REPLACE FUNCTION enqueue_sync_job(p_connection_id uuid, p_workspace_id uuid, p_kind text, p_run_at timestamp with time zone, p_idempotency_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO jobs (kind, workspace_id, connection_id, payload, run_at, idempotency_key)
  VALUES (
    p_kind,
    p_workspace_id,
    p_connection_id,
    jsonb_build_object('workspace_id', p_workspace_id, 'connection_id', p_connection_id),
    p_run_at,
    p_idempotency_key
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enqueue_sync_job(uuid, uuid, text, timestamp with time zone, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION enqueue_sync_job(uuid, uuid, text, timestamp with time zone, text) TO netrics_scheduler;
