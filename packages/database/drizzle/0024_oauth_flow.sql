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
-- 3. A callback that refuses a grant (scopes missing, account mismatch)
--    revokes it at the provider only when no connection on the instance holds
--    a grant of the same provider account: Google revokes per account and
--    client, so revoking would also stop those connections (ADR 0012,
--    "Disconnect"). The callback runs in one workspace, so this looks across
--    workspaces as the owner and answers only a boolean.
CREATE FUNCTION oauth_account_has_grant(p_provider text, p_account_sub text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM connection_oauth o
    WHERE o.provider = p_provider AND o.account_sub = p_account_sub
  );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION oauth_account_has_grant(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION oauth_account_has_grant(text, text) TO netrics_app;
