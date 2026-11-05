CREATE TABLE "data_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_datasets_tenant_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "data_datasets_connection_key" UNIQUE("connection_id","key")
);
--> statement-breakpoint
CREATE TABLE "data_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"refresh_key" text NOT NULL,
	"source_started_at" timestamp with time zone NOT NULL,
	"sequence" integer NOT NULL,
	"row_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "data_generations_tenant_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "data_generations_sequence_key" UNIQUE("dataset_id","sequence"),
	CONSTRAINT "data_generations_refresh_key" UNIQUE("dataset_id","refresh_key"),
	CONSTRAINT "data_generations_counts" CHECK ("data_generations"."sequence" > 0 and "data_generations"."row_count" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "data_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refresh_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_key" text NOT NULL,
	"sequence" integer NOT NULL,
	"digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "data_pages_refresh_key" UNIQUE("refresh_id","page_key"),
	CONSTRAINT "data_pages_sequence_key" UNIQUE("refresh_id","sequence"),
	CONSTRAINT "data_pages_payload_limit" CHECK (octet_length("data_pages"."payload"::text) <= 2097152)
);
--> statement-breakpoint
CREATE TABLE "data_records" (
	"generation_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_key" text NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"values" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "data_records_generation_id_record_key_pk" PRIMARY KEY("generation_id","record_key"),
	CONSTRAINT "data_records_value_limit" CHECK (octet_length("data_records"."values"::text) <= 131072)
);
--> statement-breakpoint
CREATE TABLE "data_refreshes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"refresh_key" text NOT NULL,
	"replacement_window" jsonb,
	"source_collected_at" timestamp with time zone NOT NULL,
	"last_page_key" text,
	"page_count" integer DEFAULT 0 NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_refreshes_tenant_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "data_refreshes_dataset_key" UNIQUE("dataset_id","refresh_key"),
	CONSTRAINT "data_refreshes_counts" CHECK ("data_refreshes"."page_count" between 0 and 100 and "data_refreshes"."row_count" between 0 and 100000)
);
--> statement-breakpoint
CREATE TABLE "data_schema_versions" (
	"dataset_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_schema_versions_dataset_id_workspace_id_version_pk" PRIMARY KEY("dataset_id","workspace_id","version"),
	CONSTRAINT "data_schema_versions_positive" CHECK ("data_schema_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "data_datasets" ADD CONSTRAINT "data_datasets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_datasets" ADD CONSTRAINT "data_datasets_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_generations" ADD CONSTRAINT "data_generations_schema_fk" FOREIGN KEY ("dataset_id","workspace_id","schema_version") REFERENCES "public"."data_schema_versions"("dataset_id","workspace_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_pages" ADD CONSTRAINT "data_pages_refresh_fk" FOREIGN KEY ("refresh_id","workspace_id") REFERENCES "public"."data_refreshes"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_records" ADD CONSTRAINT "data_records_generation_fk" FOREIGN KEY ("generation_id","workspace_id") REFERENCES "public"."data_generations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_refreshes" ADD CONSTRAINT "data_refreshes_schema_fk" FOREIGN KEY ("dataset_id","workspace_id","schema_version") REFERENCES "public"."data_schema_versions"("dataset_id","workspace_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_schema_versions" ADD CONSTRAINT "data_schema_versions_dataset_fk" FOREIGN KEY ("dataset_id","workspace_id") REFERENCES "public"."data_datasets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_generations_expiry_idx" ON "data_generations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "data_records_expiry_idx" ON "data_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "data_refreshes_expiry_idx" ON "data_refreshes" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE data_datasets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_datasets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_datasets_tenant ON data_datasets
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_datasets TO netrics_app;
--> statement-breakpoint
ALTER TABLE data_schema_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_schema_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_schema_versions_tenant ON data_schema_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_schema_versions TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_schema_versions FROM netrics_app;
--> statement-breakpoint
ALTER TABLE data_refreshes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_refreshes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_refreshes_tenant ON data_refreshes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_refreshes TO netrics_app;
--> statement-breakpoint
ALTER TABLE data_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_pages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_pages_tenant ON data_pages
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_pages TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_pages FROM netrics_app;
--> statement-breakpoint
ALTER TABLE data_generations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_generations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_generations_tenant ON data_generations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_generations TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_generations FROM netrics_app;
--> statement-breakpoint
ALTER TABLE data_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_records_tenant ON data_records
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_records TO netrics_app;
--> statement-breakpoint
REVOKE UPDATE ON data_records FROM netrics_app;
--> statement-breakpoint
CREATE FUNCTION prune_dataset_history(p_now timestamptz, p_batch integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE n integer; total integer := 0;
BEGIN
  IF p_batch < 1 OR p_batch > 10000 THEN RAISE EXCEPTION 'invalid dataset prune batch'; END IF;
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
REVOKE ALL ON FUNCTION prune_dataset_history(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_dataset_history(timestamptz, integer) TO netrics_scheduler;
