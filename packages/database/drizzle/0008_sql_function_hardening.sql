-- Hardening of SECURITY DEFINER functions and the audit insert policy (#30).
--
-- search_path: a SECURITY DEFINER function must not resolve unqualified names
-- through the caller's temporary schema, so pg_temp is pinned last.
ALTER FUNCTION create_workspace(text, uuid) SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION bootstrap_workspace(text, uuid) SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION guard_last_workspace_owner() SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION claim_jobs(text, integer, interval) SET search_path = public, pg_temp;
--> statement-breakpoint
-- enqueue_sync_job now verifies that the connection belongs to the given
-- workspace before enqueueing, so a job can never pair a connection with a
-- foreign workspace even if a caller passes mismatched ids.
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
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
--> statement-breakpoint
-- Audit rows may only be written for the workspace in the current tenant
-- context, or as installation-level rows (workspace_id NULL). Previously any
-- netrics_app path could write audit rows for arbitrary workspaces.
DROP POLICY "audit_events_insert" ON "audit_events";
--> statement-breakpoint
CREATE POLICY "audit_events_insert" ON "audit_events" FOR INSERT
  WITH CHECK (
    "workspace_id" IS NULL
    OR "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  );
