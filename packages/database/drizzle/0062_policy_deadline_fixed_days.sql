-- As in 0061, but the workspace maximum counts days as a fixed 86,400
-- seconds and checks its range in UTC, through retention_deadline(), like
-- ingestion and connection retention (#498). Calendar-day arithmetic in the
-- session time zone moved deadlines across a daylight-saving change by an
-- hour. retention_deadline() is NULL beyond the timestamp range, and least()
-- ignores NULL, so such deadlines stay as they are.
CREATE OR REPLACE FUNCTION admin_set_data_policy(p_workspace uuid, p_overrides jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE retention bigint;
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
    -- A shorter policy can remove access immediately; a later increase never revives it.
    UPDATE data_records SET expires_at=least(expires_at,retention_deadline(collected_at,retention)) WHERE workspace_id=p_workspace;
    UPDATE data_refreshes SET expires_at=least(expires_at,retention_deadline(source_collected_at,retention)) WHERE workspace_id=p_workspace;
    UPDATE data_generations SET expires_at=least(expires_at,retention_deadline(created_at,retention)) WHERE workspace_id=p_workspace;
    UPDATE data_connector_stages SET
      source_expires_at=least(source_expires_at,retention_deadline(source_collected_at,retention)),
      expires_at=least(expires_at,retention_deadline(source_collected_at,retention))
      WHERE workspace_id=p_workspace;
    DELETE FROM data_model_query_snapshots WHERE workspace_id=p_workspace;
    DELETE FROM data_prepared_generations WHERE workspace_id=p_workspace;
  END IF;
  RETURN p_workspace;
END; $$;
