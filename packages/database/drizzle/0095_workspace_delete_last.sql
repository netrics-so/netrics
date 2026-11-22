-- #855: an owner cannot delete their only workspace.
--
-- delete_workspace() (migration 0094) as it was, plus one check: the caller
-- must be a member, in any role, of another workspace that is not deleted.
-- A workspace that is deleted and waits for its purge does not count (its
-- memberships are gone already; the join says so explicitly). Only the
-- caller counts: other members who are left without a workspace are not
-- considered, as before.
--
-- The refusal is an exception (SQLSTATE WS002), not a fifth return value:
-- nothing was written, and a server of the previous release, which knows
-- four return values and reads any other as "deleted", fails instead of
-- answering that the workspace is gone.
--
-- Two deletions by one user, of that user's last two workspaces, must not
-- both pass. Each holds only its own workspace's fence and sees the other's
-- workspace as live until the other commits, so the check is serialised per
-- user: a transaction-level advisory lock on the caller, taken FIRST, before
-- the fence. The second deletion waits there, holding nothing, until the
-- first has committed or rolled back, and then counts what is left (a new
-- statement, so under READ COMMITTED it sees the first one's commit; any
-- other isolation level is refused, its snapshot could predate it).
--
-- Why before the fence: while a deletion waits for the user lock it must not
-- hold the exclusive fence, which stalls every request of its workspace.
-- And no deadlock: only delete_workspace() takes user locks, one per
-- transaction, always before its one fence. A transaction that waits for a
-- user lock holds no lock at all; the holder of a user lock waits only for
-- its own workspace's fence, whose holders (tenant transactions and the
-- entry points of 0094) never ask for a user lock. So no cycle can close.
--
-- Nothing else takes the user lock, deliberately:
--   - accept_invitation and create_workspace only ADD a membership. A
--     deletion that does not see one being added refuses where it might
--     have passed, which is the answer of "deletion first, then the new
--     membership".
--   - Another owner deleting, or an admin removing the caller from, the
--     caller's other workspace at the same moment leaves the caller without
--     a workspace. That is the result of the same two actions one after the
--     other, which is allowed: the rule protects the deleting owner at the
--     time of the deletion, not every member for ever.
--
-- The wait for both locks together stays within the 10 seconds of 0094
-- (55P03 afterwards, answered 409 workspace_busy). The key is 32 bits of
-- the user id; two users sharing one only wait for each other's deletion.
CREATE OR REPLACE FUNCTION delete_workspace(p_name text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_workspace_id uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  v_user_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_lock_timeout text := current_setting('lock_timeout');
  v_deadline timestamptz := clock_timestamp() + interval '10 seconds';
  v_name text;
  v_role text;
  v_counts jsonb;
BEGIN
  IF v_workspace_id IS NULL OR v_user_id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'delete_workspace() needs a read committed transaction'
      USING ERRCODE = 'feature_not_supported';
  END IF;
  PERFORM set_config('lock_timeout', '10s', true);
  PERFORM pg_advisory_xact_lock(
    hashtext('netrics.workspace_delete_user'),
    hashtext(v_user_id::text)
  );
  -- What is left of the 10 seconds (0 would mean no timeout).
  PERFORM set_config(
    'lock_timeout',
    greatest(
      1,
      ceil(extract(epoch FROM v_deadline - clock_timestamp()) * 1000)::integer
    )::text || 'ms',
    true
  );
  PERFORM pg_advisory_xact_lock(
    hashtext('netrics.workspace_fence'),
    hashtext(v_workspace_id::text)
  );
  PERFORM set_config('lock_timeout', v_lock_timeout, true);
  SELECT w.name INTO v_name FROM workspaces w
    WHERE w.id = v_workspace_id AND w.deleted_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  SELECT m.role INTO v_role FROM memberships m
    WHERE m.workspace_id = v_workspace_id AND m.user_id = v_user_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_role <> 'owner' THEN
    RETURN 'forbidden';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM memberships m
    JOIN workspaces w ON w.id = m.workspace_id
    WHERE m.user_id = v_user_id
      AND m.workspace_id <> v_workspace_id
      AND w.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workspace % is the only workspace of user %', v_workspace_id, v_user_id
      USING ERRCODE = 'WS002';
  END IF;
  IF p_name IS NULL OR btrim(v_name) = '' OR btrim(p_name) <> btrim(v_name) THEN
    RETURN 'name_mismatch';
  END IF;

  SELECT jsonb_build_object(
    'members', (SELECT count(*) FROM memberships WHERE workspace_id = v_workspace_id),
    'connections', (SELECT count(*) FROM connections WHERE workspace_id = v_workspace_id AND status <> 'draft'),
    'dashboards', (SELECT count(*) FROM dashboards WHERE workspace_id = v_workspace_id),
    'screens', (SELECT count(*) FROM devices WHERE workspace_id = v_workspace_id AND revoked_at IS NULL)
  ) INTO v_counts;

  UPDATE devices SET revoked_at = now()
    WHERE workspace_id = v_workspace_id AND revoked_at IS NULL;
  UPDATE principal_tokens SET revoked_at = now()
    WHERE workspace_id = v_workspace_id AND revoked_at IS NULL;
  DELETE FROM device_pairings WHERE workspace_id = v_workspace_id;
  DELETE FROM oauth_authorizations WHERE workspace_id = v_workspace_id;

  UPDATE jobs
    SET status = 'failed',
        locked_by = NULL,
        locked_at = NULL,
        last_error = 'workspace deleted'
    WHERE workspace_id = v_workspace_id
      AND status IN ('pending', 'continuing', 'running');
  UPDATE connection_state SET next_due_at = NULL
    WHERE workspace_id = v_workspace_id AND next_due_at IS NOT NULL;

  DELETE FROM invitations WHERE workspace_id = v_workspace_id;
  UPDATE workspaces SET deleted_at = now() WHERE id = v_workspace_id;
  DELETE FROM memberships WHERE workspace_id = v_workspace_id;

  INSERT INTO audit_events (workspace_id, actor_user_id, action, target, metadata)
  VALUES (
    NULL,
    v_user_id,
    'workspace.deleted',
    v_workspace_id::text,
    jsonb_build_object('name', v_name) || v_counts
  );

  INSERT INTO jobs (kind, workspace_id, connection_id, payload)
  VALUES (
    'workspace.purge',
    NULL,
    NULL,
    jsonb_build_object(
      'workspace_id', NULL,
      'connection_id', NULL,
      'purge_workspace_id', v_workspace_id
    )
  )
  ON CONFLICT DO NOTHING;

  RETURN 'deleted';
END;
$$;
