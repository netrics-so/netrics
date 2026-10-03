-- ADR 0012, #132: the OAuth authorization flow (migration 0024).
--
-- 1. A connection created by an OAuth callback starts in a setup state: it
--    holds the grant but not its config yet, is not scheduled, and the web app
--    shows "Finish setup". Existing connections are complete (default false).
ALTER TABLE "connections" ADD COLUMN "setup_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- 2. Authorization rows are only needed until their callback (10 minutes at
--    most). The scheduler's hourly maintenance deletes consumed and expired
--    ones across workspaces; netrics_scheduler has no grant on the table, so
--    this runs as the owner, like prune_history (migration 0016). Bounded per
--    call; returns the number of rows deleted.
CREATE FUNCTION prune_oauth_authorizations(p_batch integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM oauth_authorizations
  WHERE id IN (
    SELECT a.id FROM oauth_authorizations a
    WHERE a.consumed_at IS NOT NULL OR a.expires_at <= now()
    LIMIT p_batch
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_oauth_authorizations(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_oauth_authorizations(integer) TO netrics_scheduler;
--> statement-breakpoint
-- 3. One lock per provider account (ADR 0012, "Grant lock"). Every change to
--    whether an account holds a grant on this instance, and every revocation
--    at the provider, runs under an advisory lock on (provider, sub), so a
--    shared-grant check and the revocation or store that follows it cannot
--    interleave with another for the same account. oauth_grant_lock is the
--    only place the key is derived; 0023's oauth_release_grant is redefined
--    below to use it. Advisory locks need no table privileges, so this is not
--    SECURITY DEFINER. Modes:
--    - 'xact': pg_advisory_xact_lock, released at commit or rollback;
--    - 'session': pg_advisory_lock, held across the revocation HTTP call by
--      a disconnect (or a callback) on one reserved connection;
--    - 'unlock': releases one 'session' hold, returns whether it was held.
--    Session and transaction holds of one key conflict between sessions and
--    are reentrant within one, so a holder of the session lock can still
--    call oauth_release_grant.
CREATE FUNCTION oauth_grant_lock(p_provider text, p_sub text, p_mode text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  k1 integer := hashtext('netrics.oauth_grant');
  k2 integer := hashtext(p_provider || chr(31) || p_sub);
BEGIN
  CASE p_mode
    WHEN 'xact' THEN
      PERFORM pg_advisory_xact_lock(k1, k2);
      RETURN true;
    WHEN 'session' THEN
      PERFORM pg_advisory_lock(k1, k2);
      RETURN true;
    WHEN 'unlock' THEN
      RETURN pg_advisory_unlock(k1, k2);
  END CASE;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_grant_lock(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_grant_lock(text, text, text) TO netrics_app;
--> statement-breakpoint
-- 4. oauth_release_grant (0023) with the key from oauth_grant_lock; the
--    behaviour is unchanged (same key, same checks, same answer).
CREATE OR REPLACE FUNCTION oauth_release_grant(
  p_provider text,
  p_sub text,
  p_connection_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM oauth_grant_lock(p_provider, p_sub, 'xact');
  IF NOT EXISTS (
    SELECT 1 FROM connection_oauth o
    WHERE o.connection_id = p_connection_id
      AND o.workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
      AND o.provider = p_provider
      AND o.account_sub = p_sub
  ) THEN
    RAISE EXCEPTION 'oauth_release_grant: the connection does not hold this grant'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM connection_oauth o
    WHERE o.provider = p_provider
      AND o.account_sub = p_sub
      AND o.connection_id <> p_connection_id
  );
END;
$$;
--> statement-breakpoint
-- 5. A callback that refuses a grant (scopes missing, account mismatch, no
--    refresh token) revokes it at the provider only when no connection on the
--    instance holds a grant of the same provider account: Google revokes per
--    account and project, so revoking would also stop those connections (ADR
--    0012, "Disconnect"). Unlike oauth_release_grant there is no connection
--    of the caller to start from, so this is the non-deleting variant: it
--    takes the same lock (reentrant for a caller already holding it), looks
--    across workspaces as the owner and answers only a boolean.
CREATE FUNCTION oauth_account_has_grant(p_provider text, p_account_sub text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM oauth_grant_lock(p_provider, p_account_sub, 'xact');
  RETURN EXISTS (
    SELECT 1 FROM connection_oauth o
    WHERE o.provider = p_provider AND o.account_sub = p_account_sub
  );
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_account_has_grant(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_account_has_grant(text, text) TO netrics_app;
