-- First-owner bootstrap: creates the installation's very first workspace with
-- the caller as owner. Same SECURITY DEFINER pattern as create_workspace()
-- (migration 0001): the function runs as the migration role and drives the
-- same RLS policies by clearing then adopting the tenant context.
--
-- The "no workspace exists yet" check reads ALL workspaces, which requires
-- bypassing FORCE RLS on the workspaces table: the migration role that owns
-- this function must therefore be a superuser or have BYPASSRLS (true for the
-- dev/test role `netrics`; same assumption create_workspace() already relies
-- on for its no-context INSERT).
--
-- Concurrency: a transaction-scoped advisory lock serializes bootstrap
-- attempts, so two racing requests cannot both pass the existence check.
-- Once any workspace exists the function raises SQLSTATE 23505
-- (unique_violation) with message 'workspace_already_exists', which the API
-- maps to 409 Conflict.
CREATE OR REPLACE FUNCTION bootstrap_workspace(p_name text, p_owner_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  -- Fixed advisory key for bootstrap serialization (namespace "netrics", 1).
  PERFORM pg_advisory_xact_lock(hashtext('netrics.bootstrap'));
  IF EXISTS (SELECT 1 FROM workspaces) THEN
    RAISE EXCEPTION 'workspace_already_exists' USING ERRCODE = 'unique_violation';
  END IF;
  PERFORM set_config('app.workspace_id', '', true);
  INSERT INTO workspaces (name) VALUES (p_name) RETURNING id INTO v_workspace_id;
  PERFORM set_config('app.workspace_id', v_workspace_id::text, true);
  INSERT INTO memberships (workspace_id, user_id, role)
    VALUES (v_workspace_id, p_owner_user_id, 'owner');
  INSERT INTO audit_events (workspace_id, actor_user_id, action)
    VALUES (v_workspace_id, p_owner_user_id, 'workspace.bootstrap');
  RETURN v_workspace_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION bootstrap_workspace(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION bootstrap_workspace(text, uuid) TO netrics_app;
