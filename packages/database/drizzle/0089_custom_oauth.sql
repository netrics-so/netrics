-- Custom OAuth for the custom API connector (milestone 13, #805).
--
-- 1. oauth_authorizations.purpose gains 'authorize': the first grant of a
--    connection that exists before it has one (a custom OAuth connection or
--    builder draft holding its client ID and secret). Like 'reauthorize' it
--    names a connection. Existing 'connect' and 'reauthorize' rows satisfy
--    both new checks, so nothing is rewritten.
-- 2. A builder draft that holds an OAuth grant is not deleted by the plain
--    24-hour prune: its grant is revoked at the provider first, which needs
--    the credential keyring and the network, so the scheduler queues one
--    `custom_api.draft_expired` job per such draft for the worker, which
--    revokes (best effort) and then deletes the draft. A draft whose cleanup
--    never ran is still pruned once it is twice as old.
-- oauth_authorizations is written by every OAuth start and connections by
-- every request path: a lock not granted within 5 s fails the migration (to
-- be re-run) instead of queueing those requests.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "oauth_authorizations" DROP CONSTRAINT "oauth_authorizations_purpose_valid";--> statement-breakpoint
ALTER TABLE "oauth_authorizations" DROP CONSTRAINT "oauth_authorizations_purpose_connection";--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_purpose_valid" CHECK ("oauth_authorizations"."purpose" in ('connect', 'reauthorize', 'authorize'));--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_purpose_connection" CHECK (("oauth_authorizations"."purpose" in ('reauthorize', 'authorize')) = ("oauth_authorizations"."connection_id" is not null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION prune_draft_connections(
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
  -- Drafts with an OAuth grant go through custom_api.draft_expired jobs
  -- (revoke first); after twice the age they are pruned regardless.
  DELETE FROM connections
  WHERE status = 'draft'
    AND updated_at < p_now - p_age
    AND id IN (
      SELECT c.id FROM connections c
      WHERE c.status = 'draft'
        AND c.updated_at < p_now - p_age
        AND (
          c.updated_at < p_now - p_age * 2
          OR NOT EXISTS (
            SELECT 1 FROM connection_oauth o WHERE o.connection_id = c.id
          )
        )
      LIMIT p_batch
    );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
-- One job per expired draft with a grant. The key names the draft and the
-- time it was last touched, so a draft touched again and abandoned later
-- gets a new job, and a scheduler tick before the job ran adds none.
CREATE FUNCTION enqueue_expired_draft_grants(
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
  queued integer;
BEGIN
  INSERT INTO jobs (kind, workspace_id, connection_id, payload, idempotency_key)
  SELECT
    'custom_api.draft_expired',
    c.workspace_id,
    c.id,
    jsonb_build_object('workspace_id', c.workspace_id, 'connection_id', c.id),
    'draft-expired:' || c.id::text || ':' || (extract(epoch FROM c.updated_at) * 1000)::bigint::text
  FROM connections c
  JOIN connection_oauth o ON o.connection_id = c.id AND o.workspace_id = c.workspace_id
  WHERE c.status = 'draft' AND c.updated_at < p_now - p_age
  ORDER BY c.updated_at
  LIMIT p_batch
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS queued = ROW_COUNT;
  RETURN queued;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enqueue_expired_draft_grants(timestamptz, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION enqueue_expired_draft_grants(timestamptz, interval, integer) TO netrics_scheduler;
