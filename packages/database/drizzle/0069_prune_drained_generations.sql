-- Prune stops looking for records of generations it has emptied (#531).
--
-- Each call looked up every expired generation in data_records: once in the
-- loop that deletes their records (a NOWAIT probe, the delete and a check for
-- remaining records), and once more when deleting superseded generations
-- without records, depending on the plan even for current generations, which
-- that statement never deletes. Expired current generations stay until a
-- newer generation replaces them, so the number of lookups per call grew with
-- them and never went down. Until vacuum, each lookup of an emptied
-- generation reads the index entries of all its deleted records: up to
-- 0.67 s in one call with 100 expired current generations and 2 M records,
-- and about 0.1-0.2 s per idle call after the drain.
--
-- Records are only written in the transaction that creates their generation,
-- so a generation without records never gets any again. Prune now marks it
-- (records_pruned) when it finds it empty, and skips marked generations in
-- the loop. Superseded generations are deleted only once marked, so that
-- statement no longer looks up records for any candidate; the delete keeps
-- its check after taking the lock. Marking takes the generation row with
-- SKIP LOCKED, so prune still never waits for a row lock.
--
-- Same function as 0068 otherwise. CREATE OR REPLACE keeps its owner and
-- grants, and prune_dataset_history still calls it. Existing generations
-- start unmarked; the first call that finds one empty marks it.
ALTER TABLE "data_generations" ADD COLUMN "records_pruned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prune_dataset_history_batch(p_now timestamptz, p_batch integer,
  OUT deleted integer, OUT more boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n integer; m integer; ids uuid[]; gen record; held boolean; found_one boolean; remaining boolean;
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

  -- In expiry order, so both read the expiry index (#524). A plain EXISTS
  -- drops ORDER BY and LIMIT, hence the scalar subquery.
  DELETE FROM data_records WHERE (generation_id,record_key) IN (
    SELECT generation_id,record_key FROM data_records WHERE expires_at <= p_now
    ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR coalesce((
    SELECT true FROM data_records WHERE expires_at <= p_now
    ORDER BY expires_at LIMIT 1), false); END IF;

  -- Records of released or expired generations, generation by generation.
  -- A policy or retention change updates every record of a generation, so
  -- when the first one is held the rest usually are too: try it without
  -- waiting (NOWAIT fails at once, it never queues) and skip the generation,
  -- instead of passing over all its held records on every call.
  -- Each generation is looked up by its own key, never by scanning all
  -- records. Records are only written together with their generation, so
  -- once a generation has none left it never has any again: it is marked
  -- records_pruned and not looked up again (#531). Until vacuum, every
  -- lookup of an emptied generation reads the index entries of all its
  -- deleted records; expired current generations stay until a newer one
  -- replaces them, and were looked up three times on every call.
  n := 0;
  FOR gen IN
    SELECT g.id, g.workspace_id FROM data_generations g
    WHERE g.expires_at <= p_now AND NOT g.records_pruned
  LOOP
    IF n >= p_batch THEN more := true; EXIT; END IF;
    held := false; found_one := false;
    BEGIN
      PERFORM 1 FROM data_records r WHERE r.generation_id=gen.id AND r.workspace_id=gen.workspace_id
        ORDER BY r.record_key LIMIT 1 FOR UPDATE NOWAIT;
      found_one := FOUND;
    EXCEPTION WHEN lock_not_available THEN held := true;
    END;
    IF held THEN more := true; CONTINUE; END IF;
    remaining := false;
    IF found_one THEN
      DELETE FROM data_records WHERE (generation_id,record_key) IN (
        SELECT r.generation_id,r.record_key FROM data_records r
        WHERE r.generation_id=gen.id AND r.workspace_id=gen.workspace_id
        FOR UPDATE SKIP LOCKED LIMIT p_batch - n
      );
      GET DIAGNOSTICS m = ROW_COUNT; n := n+m;
      -- A full batch may have left records; the next call finds out.
      -- Otherwise only held records can be left. Asked in key order, so it
      -- reads the primary key: a plain EXISTS may scan the table (#524).
      remaining := n >= p_batch OR coalesce((
        SELECT true FROM data_records r
        WHERE r.generation_id=gen.id AND r.workspace_id=gen.workspace_id
        ORDER BY r.record_key LIMIT 1), false);
    END IF;
    IF remaining THEN more := true;
    ELSE
      -- Without waiting for the generation row; a skipped mark is retried.
      UPDATE data_generations SET records_pruned = true WHERE id = (
        SELECT g.id FROM data_generations g WHERE g.id = gen.id
        FOR NO KEY UPDATE SKIP LOCKED);
      IF NOT FOUND THEN more := true; END IF;
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

  -- Superseded generations without records. Only marked ones qualify, so
  -- no generation is searched for records here, and the current generation
  -- of a dataset (which has no newer one) is never looked up (#531). The
  -- delete still checks after taking the lock.
  ids := ARRAY(
    SELECT g.id FROM data_generations g WHERE g.expires_at <= p_now AND g.records_pruned
    AND EXISTS (SELECT 1 FROM data_generations newer WHERE newer.dataset_id=g.dataset_id AND newer.sequence > g.sequence)
    FOR UPDATE SKIP LOCKED LIMIT p_batch
  );
  DELETE FROM data_generations g WHERE g.id = ANY(ids)
    AND NOT EXISTS (SELECT 1 FROM data_records r WHERE r.generation_id=g.id);
  GET DIAGNOSTICS n = ROW_COUNT; deleted := deleted+n;
  IF NOT more THEN more := n = p_batch OR EXISTS (
    SELECT 1 FROM data_generations g WHERE g.expires_at <= p_now AND g.records_pruned
    AND EXISTS (SELECT 1 FROM data_generations newer WHERE newer.dataset_id=g.dataset_id AND newer.sequence > g.sequence)); END IF;
END; $$;
