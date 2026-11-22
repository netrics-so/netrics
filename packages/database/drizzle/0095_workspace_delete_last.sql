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
-- Two deletions whose callers each rely on the workspace the other one
-- deletes must not both pass: one user deleting their last two workspaces
-- at once, or two co-owners of the same two workspaces each deleting a
-- different one. Each deletion holds only its own workspace's fence and
-- sees the other workspace as live until the other commits. So deletions
-- are put in one order for the whole installation: a transaction-level
-- advisory lock with one fixed key, taken FIRST, before the fence. A second
-- deletion waits there, holding nothing, until the first has committed or
-- rolled back, and then counts what is left (a new statement, so under READ
-- COMMITTED it sees the first one's commit; any other isolation level is
-- refused, its snapshot could predate it). The result is always one that
-- the deletions could have produced one after the other.
--
-- One lock for all, not one per user: whose eligibility a deletion changes
-- is every member of its workspace, and locking those in some order is more
-- machinery than rare, short deletions are worth. The price: deletions do
-- not run side by side, and one that waits for work in its workspace (up to
-- the 10 seconds below) holds the others up for that long.
--
-- Why before the fence: while a deletion waits for the lock it must not
-- hold an exclusive fence, which stalls every request of its workspace.
-- And no deadlock: only delete_workspace() takes this lock, once per
-- transaction, before its one fence and before any row lock. A transaction
-- that waits for it holds no lock at all. Its holder then stands exactly
-- where a deletion stood in 0094 (waiting for its own fence, then working
-- under it), and nothing it can wait for (tenant transactions, the entry
-- points of 0094, accept_invitation, member removal) ever asks for this
-- lock. So no cycle can close through it.
--
-- Nothing else takes the lock, deliberately:
--   - accept_invitation and create_workspace only ADD a membership. A
--     deletion that does not see one being added refuses where it might
--     have passed, which is the answer of "deletion first, then the new
--     membership".
--   - Removing a member (or a member leaving) is not a deletion and is not
--     ordered with one: a caller who is removed from their other workspace
--     while they delete this one can be left without a workspace. Out of
--     scope here; the removal runs under that workspace's shared fence only.
--
-- The wait for both locks together stays within the 10 seconds of 0094
-- (55P03 afterwards, answered 409 workspace_busy).
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
  PERFORM pg_advisory_xact_lock(hashtext('netrics.workspace_delete'), 0);
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
