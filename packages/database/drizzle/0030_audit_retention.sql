-- #163: retention for security records (audit events, sign-in sessions,
-- auth rate-limit counters and device pairings), which hold IP addresses,
-- browser user agents or hashes of them.
--
-- 1. The age scan of prune_security_records below.
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
-- 2. Run by the scheduler's hourly maintenance with the constants in
--    packages/database/src/security-retention.ts. netrics_scheduler has no
--    grant on these tables, so this runs as the owner, like prune_history
--    (migration 0016); audit_events has no DELETE policy, which the owner
--    (the superuser/BYPASSRLS migration role, see migration 0006) bypasses.
--    Each statement touches at most p_batch rows per call, so a first run on
--    a large backlog stays short; the next hourly run continues.
--    - audit_events: older than p_audit_events (12 months), every workspace
--      and installation-level events (auth.login carries IP and browser).
--    - auth.session: expired for longer than p_expired. A session kept alive
--      past p_audit_events loses the IP address and user agent recorded at
--      sign-in; the session itself stays valid.
--    - auth.rate_limit: counters (keyed by client IP) idle for longer than
--      p_expired; better-auth only clears them when the same key returns.
--    - device_pairings: expired for longer than p_expired (they keep a hash
--      of the client IP); the API also prunes these when pairings start.
--    better-auth writes auth.* timestamps as UTC wall-clock `timestamp`
--    values, hence AT TIME ZONE 'UTC'; last_request is epoch milliseconds.
--    p_now is the caller's clock, so tests can pin it.
CREATE FUNCTION prune_security_records(
  p_now timestamptz,
  p_audit_events interval,
  p_expired interval,
  p_batch integer
)
RETURNS TABLE (
  audit_events_deleted integer,
  sessions_deleted integer,
  session_addresses_cleared integer,
  rate_limits_deleted integer,
  device_pairings_deleted integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  audit_cutoff timestamptz := p_now - p_audit_events;
  expired_cutoff timestamptz := p_now - p_expired;
BEGIN
  DELETE FROM audit_events
  WHERE id IN (
    SELECT a.id FROM audit_events a
    WHERE a.created_at < audit_cutoff
    LIMIT p_batch
  );
  GET DIAGNOSTICS audit_events_deleted = ROW_COUNT;

  DELETE FROM auth.session
  WHERE id IN (
    SELECT s.id FROM auth.session s
    WHERE s.expires_at < (expired_cutoff AT TIME ZONE 'UTC')
    LIMIT p_batch
  );
  GET DIAGNOSTICS sessions_deleted = ROW_COUNT;

  UPDATE auth.session
  SET ip_address = NULL, user_agent = NULL
  WHERE id IN (
    SELECT s.id FROM auth.session s
    WHERE s.created_at < (audit_cutoff AT TIME ZONE 'UTC')
      AND (s.ip_address IS NOT NULL OR s.user_agent IS NOT NULL)
    LIMIT p_batch
  );
  GET DIAGNOSTICS session_addresses_cleared = ROW_COUNT;

  DELETE FROM auth.rate_limit
  WHERE id IN (
    SELECT r.id FROM auth.rate_limit r
    WHERE r.last_request < (extract(epoch FROM expired_cutoff) * 1000)::bigint
    LIMIT p_batch
  );
  GET DIAGNOSTICS rate_limits_deleted = ROW_COUNT;

  DELETE FROM device_pairings
  WHERE id IN (
    SELECT p.id FROM device_pairings p
    WHERE p.expires_at < expired_cutoff
    LIMIT p_batch
  );
  GET DIAGNOSTICS device_pairings_deleted = ROW_COUNT;

  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_security_records(timestamptz, interval, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_security_records(timestamptz, interval, interval, integer) TO netrics_scheduler;
