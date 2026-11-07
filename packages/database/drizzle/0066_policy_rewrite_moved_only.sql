-- Retention changes write only the deadlines they move (#518).
--
-- Until 0065, every admin_set_data_policy call that carried a retention
-- ceiling rewrote every record, generation, refresh and stage of the
-- workspace, also when nothing changed (a second call with the same ceiling,
-- or a queryRows change while a ceiling is set). Each rewrite left a dead
-- tuple and a new expiry index entry per record, and the record update found
-- the workspace's rows by scanning every workspace's records, because no
-- data_records index leads with workspace_id. apply_connection_retention
-- rewrote the stored deadlines of the connection's datasets on every call in
-- the same way.
--
-- Both functions now keep the stored values and their semantics: after a
-- policy call every deadline is least(old deadline, ceiling deadline), as
-- before, and after a connection-retention call every deadline is what 0061
-- computes. They only skip the rows where that value equals the stored one
-- (IS DISTINCT FROM), so a call that moves nothing writes nothing, and the
-- derived caches are cleared only when a deadline moved. Records are reached
-- through the workspace's (or dataset's) generations and the data_records
-- primary key (generation_id, record_key), so a small workspace no longer
-- reads other workspaces' records; no index is added (drizzle runs all
-- migrations in one transaction, so CREATE INDEX CONCURRENTLY is not
-- available, and a plain build would lock data_records for writes).
--
-- The whole change still runs as one statement per table under the
-- workspace ingestion lock (440): a deadline that moves into the past must
-- be stored before any reader or later page can see the old one. A call
-- that moves nothing still reads the workspace's records once under the
-- lock, but writes none.
--
-- Prune (0065) never waits for a lock, so it cannot deadlock with either
-- function. It now finds fewer held records: only those whose deadline
-- moved are locked here.
CREATE OR REPLACE FUNCTION admin_set_data_policy(p_workspace uuid, p_overrides jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE retention bigint; span interval; changed bigint; moved boolean := false;
BEGIN
  IF jsonb_typeof(p_overrides) <> 'object' THEN RAISE EXCEPTION 'invalid data policy'; END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id=p_workspace) THEN RETURN NULL; END IF;
  -- The workspace ingestion lock (440), taken by dataset ingestion, staging
  -- and connection retention before they read the policy: an in-flight page
  -- commits first and is shortened below, or reads this policy (#492, #497).
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace::text, 440));
  INSERT INTO data_workspace_policies(workspace_id,overrides) VALUES(p_workspace,p_overrides)
    ON CONFLICT (workspace_id) DO UPDATE SET overrides=EXCLUDED.overrides,updated_at=now();
  retention := (p_overrides->>'maxRetentionDays')::bigint;
  IF retention IS NOT NULL THEN
    IF retention < 1 THEN RAISE EXCEPTION 'invalid data retention'; END IF;
    -- A shorter policy can remove access immediately; a later increase never
    -- revives it. retention_deadline() is NULL beyond the timestamp range,
    -- and least() ignores NULL, so such deadlines stay as they are. Only rows
    -- whose deadline moves are written.
    --
    -- retention_deadline() is not inlined (it sets search_path), and calling
    -- it for every record cost about 1.4 s per million records. A record's
    -- deadline can only move when it is NULL or more than `span` after
    -- collection, which is cheap to test first: when the new deadline is not
    -- NULL it is collected_at + span exactly, and interval comparison counts
    -- microseconds. Beyond 5,373,484 days (from the earliest timestamp,
    -- 4714-11-24 BC, to 9999-12-31) every new deadline is NULL and nothing
    -- moves; span is NULL then, so no record matches. (expires_at -
    -- collected_at cannot overflow: stored deadlines end by 9999-12-31.)
    span := CASE WHEN retention <= '9999-12-31'::date - '4714-11-24 BC'::date
      THEN make_interval(secs => retention * 86400) END;
    UPDATE data_records r
      SET expires_at=least(r.expires_at,retention_deadline(r.collected_at,retention))
      FROM data_generations g
      WHERE g.workspace_id=p_workspace AND r.generation_id=g.id AND r.workspace_id=p_workspace
        AND span IS NOT NULL AND (r.expires_at IS NULL OR r.expires_at - r.collected_at > span)
        AND r.expires_at IS DISTINCT FROM least(r.expires_at,retention_deadline(r.collected_at,retention));
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    UPDATE data_refreshes
      SET expires_at=least(expires_at,retention_deadline(source_collected_at,retention))
      WHERE workspace_id=p_workspace
        AND expires_at IS DISTINCT FROM least(expires_at,retention_deadline(source_collected_at,retention));
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    UPDATE data_generations
      SET expires_at=least(expires_at,retention_deadline(created_at,retention))
      WHERE workspace_id=p_workspace
        AND expires_at IS DISTINCT FROM least(expires_at,retention_deadline(created_at,retention));
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    UPDATE data_connector_stages SET
      source_expires_at=least(source_expires_at,retention_deadline(source_collected_at,retention)),
      expires_at=least(expires_at,retention_deadline(source_collected_at,retention))
      WHERE workspace_id=p_workspace
        AND (source_expires_at IS DISTINCT FROM least(source_expires_at,retention_deadline(source_collected_at,retention))
          OR expires_at IS DISTINCT FROM least(expires_at,retention_deadline(source_collected_at,retention)));
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    -- Derived results may hold data whose deadline moved.
    IF moved THEN
      DELETE FROM data_model_query_snapshots WHERE workspace_id=p_workspace;
      DELETE FROM data_prepared_generations WHERE workspace_id=p_workspace;
    END IF;
  END IF;
  RETURN p_workspace;
END; $$;
--> statement-breakpoint
-- As in 0061, writing only the rows whose deadline changes.
CREATE OR REPLACE FUNCTION apply_connection_retention(p_workspace uuid, p_connection uuid, p_days jsonb, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  d record;
  days bigint;
  cap bigint;
  current_generation uuid;
  v_dataset uuid;
  changed bigint;
  moved boolean := false;
BEGIN
  IF p_workspace IS DISTINCT FROM nullif(current_setting('app.workspace_id', true), '')::uuid
    THEN RAISE EXCEPTION 'connection retention outside the current workspace'; END IF;
  IF jsonb_typeof(p_days) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid connection retention'; END IF;
  IF NOT EXISTS (SELECT 1 FROM connections WHERE id = p_connection AND workspace_id = p_workspace)
    THEN RETURN false; END IF;
  -- A caller clock behind the database never makes expired data current again.
  p_now := greatest(p_now, now());
  SELECT (overrides ->> 'maxRetentionDays')::bigint INTO cap
    FROM data_workspace_policies WHERE workspace_id = p_workspace;
  FOR d IN SELECT key, value FROM jsonb_each(p_days) LOOP
    IF jsonb_typeof(d.value) = 'null' THEN days := NULL;
    ELSIF jsonb_typeof(d.value) = 'number' THEN
      days := (d.value #>> '{}')::bigint;
      IF days < 1 THEN RAISE EXCEPTION 'invalid connection retention'; END IF;
    ELSE RAISE EXCEPTION 'invalid connection retention';
    END IF;
    days := least(days, cap);
    -- Staged reports can exist before ingestion registers their dataset.
    UPDATE data_connector_stages SET
        source_expires_at = CASE
          WHEN source_expires_at IS NULL OR source_expires_at > p_now
            THEN retention_deadline(source_collected_at, days)
          ELSE source_expires_at END,
        expires_at = least(expires_at, retention_deadline(source_collected_at, days))
      WHERE workspace_id = p_workspace AND connection_id = p_connection
        AND dataset_key = d.key
        AND (source_expires_at IS DISTINCT FROM CASE
              WHEN source_expires_at IS NULL OR source_expires_at > p_now
                THEN retention_deadline(source_collected_at, days)
              ELSE source_expires_at END
          OR expires_at IS DISTINCT FROM least(expires_at, retention_deadline(source_collected_at, days)));
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    SELECT id INTO v_dataset FROM data_datasets
      WHERE workspace_id = p_workspace AND connection_id = p_connection
        AND kind = 'source' AND key = d.key;
    CONTINUE WHEN v_dataset IS NULL;
    SELECT g.id INTO current_generation FROM data_generations g
      WHERE g.workspace_id = p_workspace AND g.dataset_id = v_dataset
        AND (g.expires_at IS NULL OR g.expires_at > p_now)
        AND NOT EXISTS (SELECT 1 FROM data_generations n
          WHERE n.workspace_id = p_workspace AND n.dataset_id = v_dataset AND n.sequence > g.sequence);
    UPDATE data_records SET expires_at = retention_deadline(collected_at, days)
      WHERE workspace_id = p_workspace AND generation_id = current_generation
        AND (expires_at IS NULL OR expires_at > p_now)
        AND expires_at IS DISTINCT FROM retention_deadline(collected_at, days);
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    UPDATE data_records r SET expires_at = least(r.expires_at, retention_deadline(r.collected_at, days))
      FROM data_generations g
      WHERE g.workspace_id = p_workspace AND g.dataset_id = v_dataset
        AND g.id IS DISTINCT FROM current_generation
        AND r.workspace_id = p_workspace AND r.generation_id = g.id
        AND r.expires_at IS DISTINCT FROM least(r.expires_at, retention_deadline(r.collected_at, days));
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    UPDATE data_generations SET expires_at = CASE
        WHEN id = current_generation THEN retention_deadline(created_at, days)
        ELSE least(expires_at, retention_deadline(created_at, days)) END
      WHERE workspace_id = p_workspace AND dataset_id = v_dataset
        AND expires_at IS DISTINCT FROM CASE
          WHEN id = current_generation THEN retention_deadline(created_at, days)
          ELSE least(expires_at, retention_deadline(created_at, days)) END;
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
    UPDATE data_refreshes SET expires_at = CASE
        WHEN expires_at IS NULL OR expires_at > p_now
          THEN retention_deadline(source_collected_at, days)
        ELSE expires_at END
      WHERE workspace_id = p_workspace AND dataset_id = v_dataset
        AND expires_at IS DISTINCT FROM CASE
          WHEN expires_at IS NULL OR expires_at > p_now
            THEN retention_deadline(source_collected_at, days)
          ELSE expires_at END;
    GET DIAGNOSTICS changed = ROW_COUNT; moved := moved OR changed > 0;
  END LOOP;
  -- Derived results may hold data whose deadline moved.
  IF moved THEN
    DELETE FROM data_model_query_snapshots WHERE workspace_id = p_workspace;
    DELETE FROM data_prepared_generations WHERE workspace_id = p_workspace;
  END IF;
  RETURN true;
END; $$;
