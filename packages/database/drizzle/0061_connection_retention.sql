ALTER TABLE "connections" ADD COLUMN "retention_choice" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "retention_fallback" text DEFAULT 'preset' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "retention_basis" text DEFAULT 'preset' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "retention_chosen_by" uuid;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "retention_chosen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_retention_chosen_by_users_id_fk" FOREIGN KEY ("retention_chosen_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_retention_choice_object" CHECK (jsonb_typeof("connections"."retention_choice") = 'object');--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_retention_fallback_valid" CHECK ("connections"."retention_fallback" in ('preset','connector'));--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_retention_basis_valid" CHECK ("connections"."retention_basis" in ('preset','chosen','migrated'));--> statement-breakpoint
-- Existing connections keep the retention they have today (#492): the
-- connector's declared retention per dataset, still capped by the workspace
-- maximum at use. It is recorded as an explicit choice for every dataset the
-- connection has registered, and datasets it registers later follow the
-- connector default too ("connector" fallback). Personal fields are not cut
-- to the 90-day preset that new connections get; nothing is deleted here.
UPDATE "connections" SET "retention_fallback" = 'connector',
  "retention_basis" = 'migrated', "retention_chosen_at" = now();
--> statement-breakpoint
UPDATE "connections" c SET "retention_choice" = declared.choice
FROM (
  SELECT d.connection_id, jsonb_object_agg(d.key, to_jsonb(r.days)) AS choice
  FROM data_datasets d
  CROSS JOIN LATERAL (
    SELECT v.definition FROM data_schema_versions v
    WHERE v.dataset_id = d.id AND v.workspace_id = d.workspace_id
    ORDER BY v.version DESC LIMIT 1
  ) latest
  CROSS JOIN LATERAL (
    -- datasetRetentionDays(): the shortest finite dataset/field retention;
    -- an omitted dataset retention is the SDK default of 30 days.
    SELECT min(x) AS days FROM (
      SELECT CASE
        WHEN NOT (latest.definition ? 'retentionDays') THEN 30::numeric
        WHEN jsonb_typeof(latest.definition -> 'retentionDays') = 'number'
          THEN (latest.definition ->> 'retentionDays')::numeric
      END AS x
      UNION ALL
      SELECT (f ->> 'retentionDays')::numeric
      FROM jsonb_array_elements(latest.definition -> 'fields') f
      WHERE jsonb_typeof(f -> 'retentionDays') = 'number'
    ) finite
  ) r
  WHERE d.kind = 'source' AND d.connection_id IS NOT NULL
  GROUP BY d.connection_id
) declared
WHERE declared.connection_id = c.id;
--> statement-breakpoint
ALTER TABLE "connections" ALTER COLUMN "retention_fallback" SET DEFAULT 'preset';
--> statement-breakpoint
CREATE FUNCTION retention_deadline(p_from timestamptz, p_days bigint)
RETURNS timestamptz LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp AS $$
  -- Matches retentionExpiry(): a day is a fixed 86,400 seconds, whatever the
  -- session time zone, and beyond the timestamp range means no expiry.
  SELECT CASE
    WHEN p_days IS NULL THEN NULL
    WHEN p_days <= ('9999-12-31'::date - (p_from AT TIME ZONE 'UTC')::date)
      THEN p_from + make_interval(secs => p_days * 86400)
  END
$$;
--> statement-breakpoint
-- Applies a connection's dataset retention (#492) to stored deadlines.
-- p_days maps dataset key -> days (JSON null keeps until deleted); the
-- caller has already applied the workspace maximum, which is enforced here
-- again for workspace overrides. Unexpired data of the current generation,
-- unexpired refreshes and live stage sources take the new deadline, shorter
-- or longer. Everything else can only become shorter, so expired or released
-- data is never revived. Derived caches are cleared, like
-- admin_set_data_policy. Only the current tenant's own connection.
CREATE FUNCTION apply_connection_retention(p_workspace uuid, p_connection uuid, p_days jsonb, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE
  d record;
  days bigint;
  cap bigint;
  current_generation uuid;
  v_dataset uuid;
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
        AND dataset_key = d.key;
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
        AND (expires_at IS NULL OR expires_at > p_now);
    UPDATE data_records r SET expires_at = least(r.expires_at, retention_deadline(r.collected_at, days))
      FROM data_generations g
      WHERE g.workspace_id = p_workspace AND g.dataset_id = v_dataset
        AND g.id IS DISTINCT FROM current_generation
        AND r.workspace_id = p_workspace AND r.generation_id = g.id;
    UPDATE data_generations SET expires_at = CASE
        WHEN id = current_generation THEN retention_deadline(created_at, days)
        ELSE least(expires_at, retention_deadline(created_at, days)) END
      WHERE workspace_id = p_workspace AND dataset_id = v_dataset;
    UPDATE data_refreshes SET expires_at = CASE
        WHEN expires_at IS NULL OR expires_at > p_now
          THEN retention_deadline(source_collected_at, days)
        ELSE expires_at END
      WHERE workspace_id = p_workspace AND dataset_id = v_dataset;
  END LOOP;
  DELETE FROM data_model_query_snapshots WHERE workspace_id = p_workspace;
  DELETE FROM data_prepared_generations WHERE workspace_id = p_workspace;
  RETURN true;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION retention_deadline(timestamptz, bigint) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION apply_connection_retention(uuid, uuid, jsonb, timestamptz) FROM PUBLIC;
--> statement-breakpoint
-- The API resolves the choice and the workspace maximum before this call.
GRANT EXECUTE ON FUNCTION apply_connection_retention(uuid, uuid, jsonb, timestamptz) TO netrics_app;
--> statement-breakpoint
-- As in 0058, plus the workspace ingestion lock before any write, so a
-- policy change serializes with ingestion and connection retention.
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
    UPDATE data_records SET expires_at=CASE WHEN retention <= ('9999-12-31'::date - collected_at::date) THEN least(expires_at,collected_at + make_interval(days => retention::integer)) ELSE expires_at END WHERE workspace_id=p_workspace;
    UPDATE data_refreshes SET expires_at=CASE WHEN retention <= ('9999-12-31'::date - source_collected_at::date) THEN least(expires_at,source_collected_at + make_interval(days => retention::integer)) ELSE expires_at END WHERE workspace_id=p_workspace;
    UPDATE data_generations SET expires_at=CASE WHEN retention <= ('9999-12-31'::date - created_at::date) THEN least(expires_at,created_at + make_interval(days => retention::integer)) ELSE expires_at END WHERE workspace_id=p_workspace;
    UPDATE data_connector_stages SET
      source_expires_at=CASE WHEN retention <= ('9999-12-31'::date - source_collected_at::date) THEN least(source_expires_at,source_collected_at + make_interval(days => retention::integer)) ELSE source_expires_at END,
      expires_at=CASE WHEN retention <= ('9999-12-31'::date - source_collected_at::date) THEN least(expires_at,source_collected_at + make_interval(days => retention::integer)) ELSE expires_at END
      WHERE workspace_id=p_workspace;
    DELETE FROM data_model_query_snapshots WHERE workspace_id=p_workspace;
    DELETE FROM data_prepared_generations WHERE workspace_id=p_workspace;
  END IF;
  RETURN p_workspace;
END; $$;
