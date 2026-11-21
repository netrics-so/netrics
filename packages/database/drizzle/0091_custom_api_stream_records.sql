-- #834 review: the last sync's records per stream of a custom API
-- connection, next to custom_api_stream_images: how many records were
-- skipped and, by field path, which field that may not be empty was empty
-- or unreadable. Paths and counts only, never values. Additive: a new,
-- empty table; nothing existing is rewritten or locked.
CREATE TABLE "custom_api_stream_records" (
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"stream_key" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"skipped" integer NOT NULL,
	"skipped_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "custom_api_stream_records_pk" PRIMARY KEY("connection_id","stream_key"),
	CONSTRAINT "custom_api_stream_records_counts_valid" CHECK ("custom_api_stream_records"."skipped" >= 0)
);
--> statement-breakpoint
ALTER TABLE "custom_api_stream_records" ADD CONSTRAINT "custom_api_stream_records_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_api_stream_records_workspace_idx" ON "custom_api_stream_records" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE custom_api_stream_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE custom_api_stream_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY custom_api_stream_records_tenant ON custom_api_stream_records
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_api_stream_records TO netrics_app;
