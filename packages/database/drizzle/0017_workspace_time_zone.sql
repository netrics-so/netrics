-- #48: every workspace has one IANA time zone for "today" and daily buckets.
-- Existing workspaces keep UTC, which is how everything was bucketed so far.
ALTER TABLE "workspaces" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;
--> statement-breakpoint
-- create_workspace takes the zone (validated by the API). The default keeps
-- two-argument calls working while an older API version is still running.
DROP FUNCTION create_workspace(text, uuid);
--> statement-breakpoint
CREATE FUNCTION create_workspace(p_name text, p_owner_user_id uuid, p_time_zone text DEFAULT 'UTC')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  PERFORM set_config('app.workspace_id', '', true);
  INSERT INTO workspaces (name, time_zone) VALUES (p_name, p_time_zone) RETURNING id INTO v_workspace_id;
  PERFORM set_config('app.workspace_id', v_workspace_id::text, true);
  INSERT INTO memberships (workspace_id, user_id, role)
    VALUES (v_workspace_id, p_owner_user_id, 'owner');
  RETURN v_workspace_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_workspace(text, uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_workspace(text, uuid, text) TO netrics_app;
