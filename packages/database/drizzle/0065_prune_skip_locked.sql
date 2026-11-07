-- Dataset history pruning never waits for a row lock (#517). Until 0064 one
-- prune call locked data_generations rows (release) and then waited for
-- data_records rows, while admin_set_data_policy and
-- apply_connection_retention update data_records first and data_generations
-- afterwards: a deadlock, and either side could be the one aborted.
--
-- Every row prune changes or deletes is now first locked with SKIP LOCKED
-- (or probed with NOWAIT, which fails at once instead of queueing), so a row
-- another transaction holds is left for a later call instead of waited for. Deleting a parent row (stage, refresh, generation) would also
-- lock its children through ON DELETE CASCADE; prune deletes only parents it
-- has locked and that, in a snapshot taken after the lock, have no children.
-- A child can only be added under a KEY SHARE lock on the parent, which the
-- held lock excludes, so the cascade finds nothing to lock. With no lock
-- wait in prune, it cannot be part of a deadlock cycle; a policy or
-- retention change may wait for one prune call, never the other way round.
--
-- Skipped rows must not end a drain early, so the call also reports `more`:
-- a step filled its batch, or rows it would prune remain (skipped because
-- locked, or eligible since). The scheduler stops a drain on a short batch
-- and drains again on its next tick while `more` is true.
CREATE FUNCTION prune_dataset_history_batch(p_now timestamptz, p_batch integer,
  OUT deleted integer, OUT more boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n integer; m integer; ids uuid[]; gen record; held boolean;
BEGIN
  IF p_batch < 1 OR p_batch > 10000 THEN RAISE EXCEPTION 'invalid dataset prune batch'; END IF;
  deleted := 0; more := false;

  DELETE FROM data_connector_stage_pages WHERE (stage_id,page_key) IN (
    SELECT p.stage_id,p.page_key FROM data_connector_stage_pages p
    JOIN data_connector_stages s ON s.id=p.stage_id AND s.workspace_id=p.workspace_id
    WHERE s.expires_at <= p_now
    FOR UPDATE OF p SKIP LOCKED LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_connector_stage_pages p
    JOIN data_connector_stages s ON s.id=p.stage_id AND s.workspace_id=p.workspace_id
    WHERE s.expires_at <= p_now); END IF;

  ids := ARRAY(
    SELECT s.id FROM data_connector_stages s WHERE s.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_connector_stage_pages p WHERE p.stage_id=s.id)
    FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  DELETE FROM data_connector_stages s WHERE s.id = ANY(ids)
    AND NOT EXISTS (SELECT 1 FROM data_connector_stage_pages p WHERE p.stage_id=s.id);
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_connector_stages s WHERE s.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_connector_stage_pages p WHERE p.stage_id=s.id)); END IF;

  DELETE FROM data_prepared_generations WHERE id IN (
    SELECT id FROM data_prepared_generations WHERE expires_at <= p_now
    FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_prepared_generations WHERE expires_at <= p_now); END IF;

  DELETE FROM data_model_query_snapshots WHERE (release_id,query_key) IN (
    SELECT release_id,query_key FROM data_model_query_snapshots WHERE expires_at <= p_now
    FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_model_query_snapshots WHERE expires_at <= p_now); END IF;

  -- Release unpinned superseded generations. Readers then fail explicitly
  -- (expired) instead of seeing a partially deleted generation.
  UPDATE data_generations SET expires_at = p_now WHERE id IN (
    SELECT g.id FROM data_generations g
    WHERE (g.expires_at IS NULL OR g.expires_at > p_now)
    AND data_generation_releasable(g.workspace_id, g.dataset_id, g.id, g.sequence, p_now, interval '15 minutes')
    FOR NO KEY UPDATE SKIP LOCKED LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_generations g
    WHERE (g.expires_at IS NULL OR g.expires_at > p_now)
    AND data_generation_releasable(g.workspace_id, g.dataset_id, g.id, g.sequence, p_now, interval '15 minutes')); END IF;

  DELETE FROM data_records WHERE (generation_id,record_key) IN (
    SELECT generation_id,record_key FROM data_records WHERE expires_at <= p_now
    FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_records WHERE expires_at <= p_now); END IF;

  -- Records of released or expired generations, generation by generation.
  -- A policy or retention change updates every record of a generation, so
  -- when the first one is held the rest usually are too: try it without
  -- waiting (NOWAIT fails at once, it never queues) and skip the generation,
  -- instead of passing over all its held records on every call.
  -- Expired generations are few (released ones are deleted once empty), and
  -- each is looked up by its own key, never by scanning all records.
  n := 0;
  FOR gen IN
    SELECT g.id, g.workspace_id FROM data_generations g WHERE g.expires_at <= p_now
  LOOP
    IF n >= p_batch THEN more := true; EXIT; END IF;
    held := false;
    BEGIN
      PERFORM 1 FROM data_records r WHERE r.generation_id=gen.id AND r.workspace_id=gen.workspace_id
        ORDER BY r.record_key LIMIT 1 FOR UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN held := true;
    END;
    IF held THEN more := true;
    ELSE
      DELETE FROM data_records WHERE (generation_id,record_key) IN (
        SELECT r.generation_id,r.record_key FROM data_records r
        WHERE r.generation_id=gen.id AND r.workspace_id=gen.workspace_id
        FOR UPDATE SKIP LOCKED LIMIT p_batch - n
      );
      GET DIAGNOSTICS m = ROW_COUNT; n := n+m;
      IF NOT more THEN more := EXISTS (
        SELECT 1 FROM data_records r
        WHERE r.generation_id=gen.id AND r.workspace_id=gen.workspace_id); END IF;
    END IF;
  END LOOP;
  deleted := deleted+n;

  DELETE FROM data_pages WHERE id IN (
    WITH expired AS (
      SELECT r.id FROM data_refreshes r
      WHERE (r.expires_at <= p_now OR data_refresh_releasable(
        r.workspace_id, r.dataset_id, r.refresh_key, r.complete, r.created_at, p_now, interval '15 minutes'))
      AND EXISTS (SELECT 1 FROM data_pages p WHERE p.refresh_id=r.id)
      FOR UPDATE SKIP LOCKED LIMIT p_batch
    )
    SELECT p.id FROM data_pages p JOIN expired r ON r.id=p.refresh_id
    FOR UPDATE OF p SKIP LOCKED LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_refreshes r
    WHERE (r.expires_at <= p_now OR data_refresh_releasable(
      r.workspace_id, r.dataset_id, r.refresh_key, r.complete, r.created_at, p_now, interval '15 minutes'))
    AND EXISTS (SELECT 1 FROM data_pages p WHERE p.refresh_id=r.id)); END IF;

  ids := ARRAY(
    SELECT r.id FROM data_refreshes r WHERE r.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_pages p WHERE p.refresh_id=r.id)
    FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  DELETE FROM data_refreshes r WHERE r.id = ANY(ids)
    AND NOT EXISTS (SELECT 1 FROM data_pages p WHERE p.refresh_id=r.id);
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_refreshes r WHERE r.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_pages p WHERE p.refresh_id=r.id)); END IF;

  ids := ARRAY(
    SELECT g.id FROM data_generations g WHERE g.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_records r WHERE r.generation_id=g.id)
    AND EXISTS (SELECT 1 FROM data_generations newer WHERE newer.dataset_id=g.dataset_id AND newer.sequence > g.sequence)
    FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  DELETE FROM data_generations g WHERE g.id = ANY(ids)
    AND NOT EXISTS (SELECT 1 FROM data_records r WHERE r.generation_id=g.id);
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_generations g WHERE g.expires_at <= p_now
    AND NOT EXISTS (SELECT 1 FROM data_records r WHERE r.generation_id=g.id)
    AND EXISTS (SELECT 1 FROM data_generations newer WHERE newer.dataset_id=g.dataset_id AND newer.sequence > g.sequence)); END IF;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_dataset_history_batch(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_dataset_history_batch(timestamptz, integer) TO netrics_scheduler;
--> statement-breakpoint
-- The previous entry point, for a server that has not been replaced yet
-- while this migration runs: the same pruning, rows deleted only.
CREATE OR REPLACE FUNCTION prune_dataset_history(p_now timestamptz, p_batch integer)
RETURNS integer LANGUAGE sql VOLATILE
SET search_path = public, pg_temp AS $$
  SELECT deleted FROM prune_dataset_history_batch(p_now, p_batch)
$$;
