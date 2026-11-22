-- #839: deleting a workspace.
--
-- An owner deletes a workspace in two steps. delete_workspace() below ends
-- every way into it in one transaction and marks it deleted (deleted_at);
-- a `workspace.purge` job then removes its data connection by connection
-- (revoking OAuth grants) and finally the workspace row, whose foreign keys
-- cascade to what is left. The request answers after the first step.
ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspaces_deleted_idx" ON "workspaces" USING btree ("deleted_at") WHERE "workspaces"."deleted_at" is not null;--> statement-breakpoint
-- At most one live purge per deleted workspace. A purge job has no
-- workspace_id: jobs.workspace_id cascades, and the job must outlive the
-- workspace row it deletes to be completed by its worker. The workspace is
-- named in the payload.
CREATE UNIQUE INDEX "jobs_one_live_workspace_purge" ON "jobs" USING btree (("payload" ->> 'purge_workspace_id')) WHERE "jobs"."kind" = 'workspace.purge' and "jobs"."status" in ('pending', 'running', 'continuing');--> statement-breakpoint
-- The last-owner guard (migration 0001) lets the memberships of a deleted
-- workspace go: delete_workspace() removes them all, owners included. A
-- workspace that is not marked deleted keeps its last owner as before.
CREATE OR REPLACE FUNCTION guard_last_workspace_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  remaining_owners integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role <> 'owner' THEN
      RETURN OLD;
    END IF;
    IF EXISTS (
      SELECT 1 FROM workspaces
      WHERE id = OLD.workspace_id AND deleted_at IS NOT NULL
    ) THEN
      RETURN OLD;
    END IF;
    SELECT count(*) INTO remaining_owners FROM memberships
      WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND id <> OLD.id;
    IF remaining_owners = 0 THEN
      RAISE EXCEPTION 'cannot remove the last owner of workspace %', OLD.workspace_id;
    END IF;
    RETURN OLD;
  ELSE
    IF OLD.role <> 'owner' OR NEW.role = 'owner' THEN
      RETURN NEW;
    END IF;
    SELECT count(*) INTO remaining_owners FROM memberships
      WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND id <> OLD.id;
    IF remaining_owners = 0 THEN
      RAISE EXCEPTION 'cannot demote the last owner of workspace %', OLD.workspace_id;
    END IF;
    RETURN NEW;
  END IF;
END;
$$;
--> statement-breakpoint
-- The fence between a deletion and everything else that acts for a
-- workspace. Callers take it before their first write for the workspace:
-- every tenant transaction of the application (withWorkspace) and the
-- SECURITY DEFINER entry points below. It takes a transaction-level
-- advisory lock in SHARED mode, then says whether the workspace is 'live',
-- 'deleted' or 'missing'. delete_workspace() takes the same lock in
-- EXCLUSIVE mode first of all. So a writer either holds the lock before the
-- deletion, which then waits for its commit and cleans up what it wrote, or
-- gets it after the deletion committed and reads 'deleted'.
--
-- Shared holders do not block each other, an advisory lock writes nothing
-- (unlike a row lock on the workspace row, which would dirty it on every
-- request), and it works in read-only transactions. Both sides take it as
-- their first lock for the workspace, so neither waits for it while holding
-- something the other needs: no deadlock. The key is 32 bits of the
-- workspace id; two workspaces sharing one only wait for each other's
-- deletion.
--
-- The answer is read by a new statement of this VOLATILE function, so under
-- READ COMMITTED it reflects a deletion the lock waited for. A REPEATABLE
-- READ or SERIALIZABLE transaction reads its older snapshot here, which may
-- predate a deletion the lock just waited for; such a caller passes
-- p_lock_row, and the workspace row is read FOR SHARE, which fails with
-- 40001 (serialization_failure) on a row changed since the snapshot.
--
-- The row is read through its primary key (sequential scans are off for
-- this function): under SERIALIZABLE a sequential scan would take a
-- predicate lock on the whole workspaces table, an index scan takes one on
-- this workspace's row and its index page.
CREATE FUNCTION workspace_fence(p_workspace_id uuid, p_lock_row boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET enable_seqscan = off
SET enable_bitmapscan = off
AS $$
DECLARE
  v_deleted_at timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    hashtext('netrics.workspace_fence'),
    hashtext(p_workspace_id::text)
  );
  IF p_lock_row THEN
    SELECT w.deleted_at INTO v_deleted_at FROM workspaces w
      WHERE w.id = p_workspace_id
      FOR SHARE;
  ELSE
    SELECT w.deleted_at INTO v_deleted_at FROM workspaces w
      WHERE w.id = p_workspace_id;
  END IF;
  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  RETURN CASE WHEN v_deleted_at IS NULL THEN 'live' ELSE 'deleted' END;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION workspace_fence(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION workspace_fence(uuid, boolean) TO netrics_app, netrics_scheduler;
--> statement-breakpoint
-- The first step. It acts on the transaction's tenant context only (the
-- workspace of app.workspace_id, as the user of app.user_id; the route calls
-- it in a withWorkspace transaction that does not take the fence itself),
-- so a caller can never name another workspace or user, and checks again,
-- under the exclusive fence and the workspace row lock, what the API
-- checked: the caller is an owner and p_name is the workspace's name
-- (ignoring space around it, like the dialog that asks for it).
--
-- The exclusive fence comes first: it waits (at most 10 seconds, then
-- 55P03) for every transaction already acting for the workspace, and makes
-- every later one wait and then find the workspace deleted. Nothing below
-- can therefore be undone by a transaction that started earlier, and the
-- triggers further down refuse to re-create it afterwards.
--
-- Answers 'not_found' (no such workspace, already deleted, or the caller is
-- not a member), 'forbidden' (not an owner), 'name_mismatch' or 'deleted'.
-- On 'deleted', committed together:
--   - its screens are revoked like "Remove screen" (their next request is
--     answered 401), open pairings and OAuth flows are deleted;
--   - no job of it runs again: waiting ones end as failed, running ones lose
--     their lease (their worker can neither complete nor retry them), and
--     the scheduler plans no sync (next_due_at NULL);
--   - invitations are deleted, the workspace is marked deleted, memberships
--     are deleted, so no account reaches it;
--   - an installation-level audit event (workspace_id NULL) records who
--     deleted which workspace; the workspace's own audit events go with it;
--   - a `workspace.purge` job is queued.
-- SECURITY DEFINER under the migration role: the application role has no
-- access to principal_tokens and cannot delete invitations.
CREATE FUNCTION delete_workspace(p_name text)
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
  v_name text;
  v_role text;
  v_counts jsonb;
BEGIN
  IF v_workspace_id IS NULL OR v_user_id IS NULL THEN
    RETURN 'not_found';
  END IF;
  PERFORM set_config('lock_timeout', '10s', true);
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION delete_workspace(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION delete_workspace(text) TO netrics_app;
--> statement-breakpoint
-- A deleted workspace whose purge job is gone before the workspace is (it
-- ran out of attempts, or was pruned) gets a new one: the scheduler's
-- maintenance calls this, so a purge always resumes. Returns the number of
-- jobs queued.
CREATE FUNCTION enqueue_workspace_purges(p_batch integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  queued integer;
BEGIN
  INSERT INTO jobs (kind, workspace_id, connection_id, payload)
  SELECT
    'workspace.purge',
    NULL,
    NULL,
    jsonb_build_object(
      'workspace_id', NULL,
      'connection_id', NULL,
      'purge_workspace_id', w.id
    )
  FROM workspaces w
  WHERE w.deleted_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.kind = 'workspace.purge'
        AND j.status IN ('pending', 'running', 'continuing')
        AND j.payload ->> 'purge_workspace_id' = w.id::text
    )
  ORDER BY w.deleted_at
  LIMIT p_batch
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN queued;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enqueue_workspace_purges(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION enqueue_workspace_purges(integer) TO netrics_scheduler;
--> statement-breakpoint
-- The admin API's workspace list (migration 0014) leaves out deleted
-- workspaces that still wait for their purge.
CREATE OR REPLACE FUNCTION admin_list_workspaces()
RETURNS TABLE (id uuid, name text, created_at timestamptz, member_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.id, w.name, w.created_at, count(m.id)
  FROM workspaces w
  LEFT JOIN memberships m ON m.workspace_id = w.id
  WHERE w.deleted_at IS NULL
  GROUP BY w.id
  ORDER BY w.created_at;
$$;
--> statement-breakpoint
-- What delete_workspace() cleaned must not come back. Every entry point
-- takes the fence; these triggers are the backstop behind them, for a path
-- that forgot to: no membership, invitation, connection, screen, pairing,
-- token, OAuth flow or job can be created for a deleted workspace
-- (SQLSTATE WS001), and its connections get no next sync time. They read
-- the workspace without the fence (a trigger runs after its transaction
-- already holds row locks, where waiting for the fence could deadlock with
-- a deletion); the fence at the entry points closes that last interleaving.
CREATE FUNCTION refuse_deleted_workspace()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.workspace_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = NEW.workspace_id AND w.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'workspace % is deleted', NEW.workspace_id
      USING ERRCODE = 'WS001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "memberships_refuse_deleted_workspace"
  BEFORE INSERT ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
CREATE TRIGGER "invitations_refuse_deleted_workspace"
  BEFORE INSERT ON "invitations"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
CREATE TRIGGER "connections_refuse_deleted_workspace"
  BEFORE INSERT ON "connections"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
CREATE TRIGGER "devices_refuse_deleted_workspace"
  BEFORE INSERT ON "devices"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
CREATE TRIGGER "device_pairings_refuse_deleted_workspace"
  BEFORE INSERT OR UPDATE OF workspace_id ON "device_pairings"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
CREATE TRIGGER "principal_tokens_refuse_deleted_workspace"
  BEFORE INSERT ON "principal_tokens"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
CREATE TRIGGER "oauth_authorizations_refuse_deleted_workspace"
  BEFORE INSERT ON "oauth_authorizations"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
-- Inserts only: ending or detaching a deleted workspace's jobs stays
-- possible, and the purge job itself carries no workspace_id.
CREATE TRIGGER "jobs_refuse_deleted_workspace"
  BEFORE INSERT ON "jobs"
  FOR EACH ROW EXECUTE FUNCTION refuse_deleted_workspace();
--> statement-breakpoint
-- A deleted workspace's connections are never due again. Not an error: the
-- scheduler's tick advances next_due_at for many workspaces in one
-- transaction and must not fail for all of them.
CREATE FUNCTION keep_deleted_workspace_unscheduled()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workspaces w
    WHERE w.id = NEW.workspace_id AND w.deleted_at IS NOT NULL
  ) THEN
    NEW.next_due_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "connection_state_keep_deleted_unscheduled"
  BEFORE INSERT OR UPDATE OF next_due_at ON "connection_state"
  FOR EACH ROW WHEN (NEW.next_due_at IS NOT NULL)
  EXECUTE FUNCTION keep_deleted_workspace_unscheduled();
--> statement-breakpoint
-- The SECURITY DEFINER entry points that act for a workspace outside a
-- withWorkspace transaction, each as it was (migrations 0009, 0010, 0019,
-- 0020, 0089) plus the fence.
--
-- accept_invitation:
CREATE OR REPLACE FUNCTION accept_invitation(p_token_hash text, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation invitations%ROWTYPE;
  v_email text;
BEGIN
  -- A deleted workspace's invitations are gone (#839); wait out a deletion
  -- in progress before looking, so none is accepted across it.
  IF EXISTS (
    SELECT 1 FROM invitations i
    WHERE i.token_hash = p_token_hash
      AND workspace_fence(i.workspace_id) = 'deleted'
  ) THEN
    RAISE EXCEPTION 'invitation_not_found';
  END IF;
  SELECT * INTO v_invitation FROM invitations
    WHERE token_hash = p_token_hash
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found';
  END IF;
  IF v_invitation.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation_revoked';
  END IF;
  IF v_invitation.accepted_at IS NOT NULL THEN
    IF v_invitation.accepted_by_user_id = p_user_id THEN
      RETURN v_invitation.workspace_id;
    END IF;
    RAISE EXCEPTION 'invitation_used';
  END IF;
  IF v_invitation.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation_expired';
  END IF;
  SELECT lower(email) INTO v_email FROM users WHERE id = p_user_id;
  IF v_email IS DISTINCT FROM v_invitation.email THEN
    RAISE EXCEPTION 'invitation_email_mismatch';
  END IF;

  PERFORM set_config('app.workspace_id', v_invitation.workspace_id::text, true);
  INSERT INTO memberships (workspace_id, user_id, role)
    VALUES (v_invitation.workspace_id, p_user_id, v_invitation.role)
    ON CONFLICT (workspace_id, user_id) DO NOTHING;
  UPDATE invitations
    SET accepted_at = now(), accepted_by_user_id = p_user_id
    WHERE id = v_invitation.id;
  INSERT INTO audit_events (workspace_id, actor_user_id, action, target, metadata)
    VALUES (
      v_invitation.workspace_id,
      p_user_id,
      'invitation.accepted',
      v_invitation.id::text,
      jsonb_build_object('role', v_invitation.role, 'email', v_invitation.email)
    );
  RETURN v_invitation.workspace_id;
END;
$$;
--> statement-breakpoint
-- enqueue_sync_job (the scheduler's tick):
CREATE OR REPLACE FUNCTION enqueue_sync_job(p_connection_id uuid, p_workspace_id uuid, p_kind text, p_run_at timestamp with time zone, p_idempotency_key text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- A deleted workspace gets no sync (#839). The fence also orders this
  -- against a deletion in progress: either this job commits first and the
  -- deletion ends it, or the deletion is seen here.
  IF workspace_fence(p_workspace_id) = 'deleted' THEN
    RETURN NULL;
  END IF;
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
--> statement-breakpoint
-- issue_device_tokens (a pairing being collected):
CREATE OR REPLACE FUNCTION issue_device_tokens(
  p_device_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_access_hash text,
  p_access_expires_at timestamptz,
  p_refresh_hash text,
  p_refresh_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF workspace_fence(p_workspace_id) = 'deleted' THEN
    RAISE EXCEPTION 'workspace % is deleted', p_workspace_id
      USING ERRCODE = 'WS001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM devices d
    WHERE d.id = p_device_id
      AND d.workspace_id = p_workspace_id
      AND d.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'device % is not active in workspace %', p_device_id, p_workspace_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO principal_tokens (kind, name, token_hash, scopes, workspace_id, device_id, expires_at)
  VALUES
    ('device', p_name, p_access_hash, ARRAY['device:read'], p_workspace_id, p_device_id, p_access_expires_at),
    ('device', p_name, p_refresh_hash, ARRAY['device:refresh'], p_workspace_id, p_device_id, p_refresh_expires_at);
END;
$$;
--> statement-breakpoint
-- rotate_device_refresh_token (a screen refreshing its tokens):
CREATE OR REPLACE FUNCTION rotate_device_refresh_token(
  p_refresh_hash text,
  p_new_access_hash text,
  p_access_expires_at timestamptz,
  p_new_refresh_hash text,
  p_refresh_expires_at timestamptz,
  p_retry_window interval
)
RETURNS TABLE (status text, device_id uuid, workspace_id uuid, device_name text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t principal_tokens%ROWTYPE;
BEGIN
  -- No new tokens for a deleted workspace (#839): wait out a deletion in
  -- progress before the token row is locked.
  IF EXISTS (
    SELECT 1 FROM principal_tokens p
    WHERE p.token_hash = p_refresh_hash
      AND p.workspace_id IS NOT NULL
      AND workspace_fence(p.workspace_id) = 'deleted'
  ) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO t FROM principal_tokens p
  WHERE p.token_hash = p_refresh_hash
  FOR UPDATE;

  IF NOT FOUND
    OR t.kind <> 'device'
    OR NOT ('device:refresh' = ANY (t.scopes))
    OR (t.expires_at IS NOT NULL AND t.expires_at <= now()) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  IF t.revoked_at IS NOT NULL THEN
    IF t.rotated_at IS NULL THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::text;
      RETURN;
    END IF;
    -- A rotated token again. A retry only while it was rotated recently, a
    -- successor pair is still live and no successor refresh token was used.
    IF t.rotated_at <= now() - p_retry_window
      OR EXISTS (
        SELECT 1 FROM principal_tokens s
        WHERE s.parent_id = t.id AND s.rotated_at IS NOT NULL
      )
      OR NOT EXISTS (
        SELECT 1 FROM principal_tokens s
        WHERE s.parent_id = t.id AND s.revoked_at IS NULL
      ) THEN
      UPDATE principal_tokens p SET revoked_at = now()
      WHERE p.device_id = t.device_id AND p.revoked_at IS NULL;
      RETURN QUERY SELECT 'reused'::text, t.device_id, t.workspace_id, t.name;
      RETURN;
    END IF;
    UPDATE principal_tokens p SET revoked_at = now()
    WHERE p.parent_id = t.id AND p.revoked_at IS NULL;
  ELSE
    UPDATE principal_tokens p SET revoked_at = now(), rotated_at = now()
    WHERE p.id = t.id;
  END IF;

  INSERT INTO principal_tokens
    (kind, name, token_hash, scopes, workspace_id, device_id, expires_at, parent_id)
  VALUES
    ('device', t.name, p_new_access_hash, ARRAY['device:read'], t.workspace_id, t.device_id, p_access_expires_at, t.id),
    ('device', t.name, p_new_refresh_hash, ARRAY['device:refresh'], t.workspace_id, t.device_id, p_refresh_expires_at, t.id);
  RETURN QUERY SELECT 'rotated'::text, t.device_id, t.workspace_id, t.name;
END;
$$;
--> statement-breakpoint
-- resolve_principal_token: a token of a deleted workspace resolves to
-- nothing, whatever its own state.
CREATE OR REPLACE FUNCTION resolve_principal_token(p_token_hash text)
RETURNS TABLE (id uuid, kind text, name text, scopes text[], workspace_id uuid, device_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT t.id, t.kind, t.name, t.scopes, t.workspace_id, t.device_id
    FROM principal_tokens t
    WHERE t.token_hash = p_token_hash
      AND t.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM workspaces w
        WHERE w.id = t.workspace_id AND w.deleted_at IS NOT NULL
      )
      AND (t.expires_at IS NULL OR t.expires_at > now());
  -- Usage tracking at minute resolution, so a busy client does not write on
  -- every request.
  UPDATE principal_tokens t SET last_used_at = now()
  WHERE t.token_hash = p_token_hash
    AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute');
END;
$$;
--> statement-breakpoint
-- enqueue_expired_draft_grants: row by row under the fence, and never for a
-- deleted workspace (its purge revokes the drafts' grants).
CREATE OR REPLACE FUNCTION enqueue_expired_draft_grants(
  p_now timestamptz,
  p_age interval,
  p_batch integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  queued integer := 0;
  added integer;
  draft record;
BEGIN
  FOR draft IN
    SELECT c.id, c.workspace_id, c.updated_at
    FROM connections c
    JOIN connection_oauth o ON o.connection_id = c.id AND o.workspace_id = c.workspace_id
    WHERE c.status = 'draft' AND c.updated_at < p_now - p_age
    ORDER BY c.updated_at
    LIMIT p_batch
  LOOP
    CONTINUE WHEN workspace_fence(draft.workspace_id) <> 'live';
    INSERT INTO jobs (kind, workspace_id, connection_id, payload, idempotency_key)
    VALUES (
      'custom_api.draft_expired',
      draft.workspace_id,
      draft.id,
      jsonb_build_object('workspace_id', draft.workspace_id, 'connection_id', draft.id),
      'draft-expired:' || draft.id::text || ':' || (extract(epoch FROM draft.updated_at) * 1000)::bigint::text
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS added = ROW_COUNT;
    queued := queued + added;
  END LOOP;
  RETURN queued;
END;
$$;
