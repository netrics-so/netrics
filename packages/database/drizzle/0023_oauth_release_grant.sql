-- ADR 0012, #133: the shared-grant check on disconnect. Google revokes the
-- whole grant of one account for our OAuth project, so deleting an OAuth
-- connection may revoke at the provider only when no other connection on the
-- instance (in any workspace) holds a grant for the same provider and
-- account. The app role cannot see other workspaces' connection_oauth rows
-- (RLS), so this SECURITY DEFINER function answers with one boolean and
-- nothing else: no ids, workspaces or counts.
--
-- - The caller must hold the grant: the connection must be in the caller's
--   workspace (app.workspace_id) with this provider and sub. Otherwise the
--   function raises, so it cannot be used to probe for accounts.
-- - A transaction advisory lock on (provider, sub) serializes concurrent
--   disconnects of one account until commit. It is plpgsql so the check runs
--   in a statement after the lock: under READ COMMITTED it sees deletions
--   committed while it waited, so of two concurrent disconnects of the last
--   two connections exactly one sees "no other" and revokes.
-- No table or data change: existing rows are unaffected.
CREATE FUNCTION oauth_release_grant(
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
  PERFORM pg_advisory_xact_lock(
    hashtext('netrics.oauth_grant'),
    hashtext(p_provider || chr(31) || p_sub)
  );
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
REVOKE ALL ON FUNCTION oauth_release_grant(text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_release_grant(text, text, uuid) TO netrics_app;
