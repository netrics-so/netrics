CREATE TABLE "data_connector_stage_pages" (
	"stage_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "data_connector_stage_pages_stage_id_page_key_pk" PRIMARY KEY("stage_id","page_key"),
	CONSTRAINT "data_connector_stage_pages_size" CHECK (octet_length("data_connector_stage_pages"."payload"::text) <= 2097152)
);
--> statement-breakpoint
CREATE TABLE "data_connector_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"connector_id" text NOT NULL,
	"key" text NOT NULL,
	"dataset_key" text NOT NULL,
	"schema_version" integer NOT NULL,
	"metadata" jsonb NOT NULL,
	"digest" text NOT NULL,
	"byte_size" integer NOT NULL,
	"source_collected_at" timestamp with time zone NOT NULL,
	"source_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "data_connector_stages_tenant_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "data_connector_stages_connection_key" UNIQUE("connection_id","key"),
	CONSTRAINT "data_connector_stages_size" CHECK ("data_connector_stages"."byte_size" between 0 and 134217728)
);
--> statement-breakpoint
ALTER TABLE "data_connector_stage_pages" ADD CONSTRAINT "data_connector_stage_pages_stage_fk" FOREIGN KEY ("stage_id","workspace_id") REFERENCES "public"."data_connector_stages"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_connector_stages" ADD CONSTRAINT "data_connector_stages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_connector_stages" ADD CONSTRAINT "data_connector_stages_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_connector_stages_expiry_idx" ON "data_connector_stages" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE data_connector_stages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_connector_stages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_connector_stages_tenant ON data_connector_stages
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_connector_stages TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_connector_stages FROM netrics_app;

--> statement-breakpoint
ALTER TABLE data_connector_stage_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_connector_stage_pages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_connector_stage_pages_tenant ON data_connector_stage_pages
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_connector_stage_pages TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_connector_stage_pages FROM netrics_app;

--> statement-breakpoint
GRANT UPDATE(byte_size) ON data_connector_stages TO netrics_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_set_data_policy(p_workspace uuid, p_overrides jsonb)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE retention bigint;
BEGIN
  IF jsonb_typeof(p_overrides) <> 'object' THEN RAISE EXCEPTION 'invalid data policy'; END IF;
  IF NOT EXISTS (SELECT 1 FROM workspaces WHERE id=p_workspace) THEN RETURN NULL; END IF;
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
  DELETE FROM data_records WHERE (generation_id,record_key) IN (
    SELECT generation_id,record_key FROM data_records WHERE expires_at <= p_now LIMIT p_batch
  );
  GET DIAGNOSTICS n = ROW_COUNT; total := total+n;
  DELETE FROM data_pages WHERE id IN (
    WITH expired AS (
      SELECT id FROM data_refreshes WHERE expires_at <= p_now
      ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT p_batch
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
