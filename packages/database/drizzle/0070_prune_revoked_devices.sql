-- Removed screens (owner decision 2026-11-08): revoking a device marks it
-- revoked and deletes its tokens, but the record (name, platform, last
-- heartbeat values, approving admin) stayed until the workspace was deleted.
-- Devices revoked longer than p_age (90 days, REVOKED_DEVICE_RETENTION_DAYS
-- in packages/database/src/security-retention.ts; the privacy policy states
-- it) are deleted by the scheduler's hourly maintenance. Their pairings and
-- any remaining tokens go with them (ON DELETE CASCADE).
--
-- netrics_scheduler has no grant on devices, so this runs as the owner, like
-- prune_security_records (migration 0029). At most p_batch rows per call; a
-- count equal to p_batch means more remain for the next run. p_now is the
-- caller's clock, so tests can pin it. Few devices exist per installation,
-- so the scan needs no index.
CREATE FUNCTION prune_revoked_devices(
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
  deleted integer;
BEGIN
  DELETE FROM devices
  WHERE id IN (
    SELECT d.id FROM devices d
    WHERE d.revoked_at IS NOT NULL AND d.revoked_at < p_now - p_age
    LIMIT p_batch
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_revoked_devices(timestamptz, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_revoked_devices(timestamptz, interval, integer) TO netrics_scheduler;
