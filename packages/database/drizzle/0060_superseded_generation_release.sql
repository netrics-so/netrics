CREATE INDEX "data_model_query_snapshots_workspace_idx" ON "data_model_query_snapshots" USING btree ("workspace_id");--> statement-breakpoint
-- A superseded source generation is retained only while something can still
-- read it: an unexpired last-valid query snapshot or pinned page session that
-- names it (both live in data_model_query_snapshots). Prepared caches copy
-- their outputs and are only reachable through current input vectors, and
-- published definition history stores no generation identities. Ingestion
-- only reads the latest generation. p_grace covers request transactions that
-- read a generation before committing the snapshot that would pin it.
CREATE OR REPLACE FUNCTION data_generation_releasable(
  p_workspace uuid, p_dataset uuid, p_generation uuid, p_sequence integer,
  p_now timestamptz, p_grace interval)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM data_generations n
    WHERE n.workspace_id = p_workspace AND n.dataset_id = p_dataset
      AND n.sequence > p_sequence AND n.created_at <= p_now - p_grace
  ) AND NOT EXISTS (
    SELECT 1 FROM data_model_query_snapshots s
    WHERE s.workspace_id = p_workspace AND s.expires_at > p_now
      AND s.generations ->> p_dataset::text = p_generation::text
  )
$$;
--> statement-breakpoint
-- Raw pages are needed to finish an in-progress refresh and to replay the
-- refresh behind the current generation. A complete refresh whose generation
-- has been superseded, and an incomplete refresh that can no longer publish
-- because a newer refresh already did (ingestion's dataset_refresh_superseded
-- rule), keep only their metadata row.
CREATE OR REPLACE FUNCTION data_refresh_releasable(
  p_workspace uuid, p_dataset uuid, p_refresh_key text, p_complete boolean,
  p_created_at timestamptz, p_now timestamptz, p_grace interval)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM data_generations n
    WHERE n.workspace_id = p_workspace AND n.dataset_id = p_dataset
      AND n.created_at <= p_now - p_grace
      AND CASE WHEN p_complete THEN n.sequence > coalesce((
            SELECT own.sequence FROM data_generations own
            WHERE own.workspace_id = p_workspace AND own.dataset_id = p_dataset
              AND own.refresh_key = p_refresh_key), 0)
          ELSE n.source_started_at > p_created_at END
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION data_generation_releasable(uuid, uuid, uuid, integer, timestamptz, interval) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION data_refresh_releasable(uuid, uuid, text, boolean, timestamptz, timestamptz, interval) FROM PUBLIC;
--> statement-breakpoint
-- Storage accounting runs under the tenant role and RLS.
GRANT EXECUTE ON FUNCTION data_generation_releasable(uuid, uuid, uuid, integer, timestamptz, interval) TO netrics_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION data_refresh_releasable(uuid, uuid, text, boolean, timestamptz, timestamptz, interval) TO netrics_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prune_dataset_history(p_now timestamptz, p_batch integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n integer; total integer := 0;
BEGIN
  IF p_batch < 1 OR p_batch > 10000 THEN RAISE EXCEPTION 'invalid dataset prune batch'; END IF;
  DELETE FROM data_connector_stage_pages WHERE (stage_id,page_key) IN (
    SELECT p.stage_id,p.page_key FROM data_connector_stage_pages p
    JOIN data_connector_stages s ON s.id=p.stage_id AND s.workspace_id=p.workspace_id
    WHERE s.expires_at <= p_now LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_connector_stages WHERE id IN (
    SELECT s.id FROM data_connector_stages s WHERE s.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_connector_stage_pages p WHERE p.stage_id=s.id) LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_prepared_generations WHERE id IN (SELECT id FROM data_prepared_generations WHERE expires_at <= p_now LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_model_query_snapshots WHERE (release_id,query_key) IN (SELECT release_id,query_key FROM data_model_query_snapshots WHERE expires_at <= p_now LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  -- Release unpinned superseded generations. Readers then fail explicitly
  -- (expired) instead of seeing a partially deleted generation.
  UPDATE data_generations SET expires_at = p_now WHERE id IN (
    SELECT g.id FROM data_generations g
    WHERE (g.expires_at IS NULL OR g.expires_at > p_now)
    AND data_generation_releasable(g.workspace_id, g.dataset_id, g.id, g.sequence, p_now, interval '15 minutes')
    LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_records WHERE (generation_id,record_key) IN (
    SELECT generation_id,record_key FROM data_records WHERE expires_at <= p_now LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_records WHERE (generation_id,record_key) IN (
    SELECT r.generation_id,r.record_key FROM data_generations g
    JOIN data_records r ON r.generation_id=g.id AND r.workspace_id=g.workspace_id
    WHERE g.expires_at <= p_now LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_pages WHERE id IN (
    WITH expired AS (
      SELECT r.id FROM data_refreshes r
      WHERE (r.expires_at <= p_now OR data_refresh_releasable(
        r.workspace_id, r.dataset_id, r.refresh_key, r.complete, r.created_at, p_now, interval '15 minutes'))
      AND EXISTS (SELECT 1 FROM data_pages p WHERE p.refresh_id=r.id)
      FOR UPDATE SKIP LOCKED LIMIT p_batch
    )
    SELECT p.id FROM data_pages p JOIN expired r ON r.id=p.refresh_id LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_refreshes WHERE id IN (
    SELECT r.id FROM data_refreshes r WHERE r.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_pages p WHERE p.refresh_id=r.id) LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_generations WHERE id IN (
    SELECT g.id FROM data_generations g WHERE g.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_records r WHERE r.generation_id=g.id)
    AND EXISTS (SELECT 1 FROM data_generations newer WHERE newer.dataset_id=g.dataset_id AND newer.sequence > g.sequence)
    LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  RETURN total;
END; $$;
