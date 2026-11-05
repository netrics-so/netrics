CREATE TABLE "data_model_query_snapshots" (
	"release_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"query_key" text NOT NULL,
	"generations" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_model_query_snapshots_release_id_query_key_pk" PRIMARY KEY("release_id","query_key")
);
--> statement-breakpoint
CREATE TABLE "data_model_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"dependencies" jsonb NOT NULL,
	"schema_bindings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_model_releases_tenant_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "data_model_releases_version_key" UNIQUE("model_id","workspace_id","version"),
	CONSTRAINT "data_model_releases_positive" CHECK ("data_model_releases"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "data_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_models_tenant_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "data_models_versions" CHECK ("data_models"."version" > 0 and ("data_models"."published_version" is null or "data_models"."published_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "data_preparation_versions" (
	"preparation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"graph" jsonb NOT NULL,
	"output_schemas" jsonb NOT NULL,
	"dependencies" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_preparation_versions_preparation_id_workspace_id_version_pk" PRIMARY KEY("preparation_id","workspace_id","version"),
	CONSTRAINT "data_preparation_versions_positive" CHECK ("data_preparation_versions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "data_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"graph" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_preparations_tenant_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "data_preparations_versions" CHECK ("data_preparations"."version" > 0 and ("data_preparations"."published_version" is null or "data_preparations"."published_version" > 0))
);
--> statement-breakpoint
ALTER TABLE "data_datasets" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_datasets" ADD COLUMN "kind" text DEFAULT 'source' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_model_query_snapshots" ADD CONSTRAINT "data_model_query_snapshots_release_fk" FOREIGN KEY ("release_id","workspace_id") REFERENCES "public"."data_model_releases"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_model_releases" ADD CONSTRAINT "data_model_releases_parent_fk" FOREIGN KEY ("model_id","workspace_id") REFERENCES "public"."data_models"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_models" ADD CONSTRAINT "data_models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_preparation_versions" ADD CONSTRAINT "data_preparation_versions_parent_fk" FOREIGN KEY ("preparation_id","workspace_id") REFERENCES "public"."data_preparations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_preparations" ADD CONSTRAINT "data_preparations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_model_query_snapshots_expiry_idx" ON "data_model_query_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "data_datasets_manual_key" ON "data_datasets" USING btree ("workspace_id","key") WHERE "data_datasets"."kind" = 'manual';--> statement-breakpoint
ALTER TABLE "data_datasets" ADD CONSTRAINT "data_datasets_kind_valid" CHECK ("data_datasets"."kind" in ('source','manual') and ("data_datasets"."kind" = 'source') = ("data_datasets"."connection_id" is not null));
--> statement-breakpoint
ALTER TABLE data_preparations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_preparations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_preparations_tenant ON data_preparations
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_preparations TO netrics_app;
--> statement-breakpoint
ALTER TABLE data_preparation_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_preparation_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_preparation_versions_tenant ON data_preparation_versions
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_preparation_versions TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_preparation_versions FROM netrics_app;
--> statement-breakpoint
ALTER TABLE data_models ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_models FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_models_tenant ON data_models
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_models TO netrics_app;
--> statement-breakpoint
ALTER TABLE data_model_releases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_model_releases FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_model_releases_tenant ON data_model_releases
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_model_releases TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_model_releases FROM netrics_app;
--> statement-breakpoint
ALTER TABLE data_model_query_snapshots ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_model_query_snapshots FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_model_query_snapshots_tenant ON data_model_query_snapshots
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_model_query_snapshots TO netrics_app;
--> statement-breakpoint
GRANT UPDATE (generations, expires_at, updated_at) ON data_model_query_snapshots TO netrics_app;
--> statement-breakpoint
ALTER TABLE data_preparations ADD CONSTRAINT data_preparations_published_fk FOREIGN KEY (id,workspace_id,published_version) REFERENCES data_preparation_versions(preparation_id,workspace_id,version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE data_models ADD CONSTRAINT data_models_published_fk FOREIGN KEY (id,workspace_id,published_version) REFERENCES data_model_releases(model_id,workspace_id,version) DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
CREATE TABLE "data_prepared_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"input_key" text NOT NULL,
	"generations" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"byte_size" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_prepared_generations_input_key" UNIQUE("preparation_id","workspace_id","version","input_key"),
	CONSTRAINT "data_prepared_generations_size_check" CHECK ("data_prepared_generations"."byte_size" >= 0 AND "data_prepared_generations"."byte_size" <= 16777216)
);
--> statement-breakpoint
ALTER TABLE "data_prepared_generations" ADD CONSTRAINT "data_prepared_generations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_prepared_generations" ADD CONSTRAINT "data_prepared_generations_version_fk" FOREIGN KEY ("preparation_id","workspace_id","version") REFERENCES "public"."data_preparation_versions"("preparation_id","workspace_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_prepared_generations_expiry_idx" ON "data_prepared_generations" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE data_prepared_generations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_prepared_generations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_prepared_generations_tenant ON data_prepared_generations
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
 WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_prepared_generations TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_prepared_generations FROM netrics_app;
--> statement-breakpoint
CREATE TABLE "data_workspace_policies" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"overrides" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_generations" DROP CONSTRAINT "data_generations_counts";--> statement-breakpoint
ALTER TABLE "data_prepared_generations" DROP CONSTRAINT "data_prepared_generations_size_check";--> statement-breakpoint
ALTER TABLE "data_refreshes" DROP CONSTRAINT "data_refreshes_counts";--> statement-breakpoint
ALTER TABLE "data_workspace_policies" ADD CONSTRAINT "data_workspace_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_generations" ADD CONSTRAINT "data_generations_counts" CHECK ("data_generations"."sequence" > 0 and "data_generations"."row_count" >= 0);--> statement-breakpoint
ALTER TABLE "data_prepared_generations" ADD CONSTRAINT "data_prepared_generations_size_check" CHECK ("data_prepared_generations"."byte_size" >= 0);--> statement-breakpoint
ALTER TABLE "data_refreshes" ADD CONSTRAINT "data_refreshes_counts" CHECK ("data_refreshes"."page_count" >= 0 and "data_refreshes"."row_count" >= 0);
--> statement-breakpoint
ALTER TABLE data_workspace_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_workspace_policies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_workspace_policies_read ON data_workspace_policies FOR SELECT
 USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT ON data_workspace_policies TO netrics_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON data_workspace_policies FROM netrics_app;
--> statement-breakpoint
-- Installation API authorizes the administrator and write scope before this call.
CREATE FUNCTION admin_set_data_policy(p_workspace uuid, p_overrides jsonb)
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
    DELETE FROM data_model_query_snapshots WHERE workspace_id=p_workspace;
    DELETE FROM data_prepared_generations WHERE workspace_id=p_workspace;
  END IF;
  RETURN p_workspace;
END; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_set_data_policy(uuid,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_set_data_policy(uuid,jsonb) TO netrics_app;

--> statement-breakpoint
ALTER TABLE "data_generations" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_records" ALTER COLUMN "expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "data_refreshes" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prune_dataset_history(p_now timestamptz, p_batch integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n integer; total integer := 0;
BEGIN
  IF p_batch < 1 OR p_batch > 10000 THEN RAISE EXCEPTION 'invalid dataset prune batch'; END IF;
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
--> statement-breakpoint
