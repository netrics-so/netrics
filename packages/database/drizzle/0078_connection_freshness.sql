-- #702 (ADR 0025 section 4): how far a connection's data reaches per
-- freshness stream, one row per connection × stream × resource ('' for the
-- connection entry). Written by the sync engine in a succeeded run's final
-- commit; the engine also computes next_due_at from it, so the scheduler
-- role needs no grant here. RLS scopes it to the tenant like every other
-- workspace table, and the rows go with their connection. A new, empty
-- table: existing data is untouched.
CREATE TABLE "connection_freshness" (
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"resource" text DEFAULT '' NOT NULL,
	"data_through" date,
	"time_zone" text,
	"expected_from" timestamp with time zone,
	"next_expected_at" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL,
	"advanced_at" timestamp with time zone,
	CONSTRAINT "connection_freshness_connection_id_stream_resource_pk" PRIMARY KEY("connection_id","stream","resource"),
	CONSTRAINT "connection_freshness_stream_length" CHECK (char_length("connection_freshness"."stream") between 1 and 64),
	CONSTRAINT "connection_freshness_resource_length" CHECK (char_length("connection_freshness"."resource") <= 200),
	CONSTRAINT "connection_freshness_zone_with_date" CHECK (("connection_freshness"."data_through" is null) = ("connection_freshness"."time_zone" is null)),
	CONSTRAINT "connection_freshness_expected_order" CHECK ("connection_freshness"."expected_from" is null or ("connection_freshness"."next_expected_at" is not null and "connection_freshness"."expected_from" <= "connection_freshness"."next_expected_at"))
);
--> statement-breakpoint
ALTER TABLE "connection_freshness" ADD CONSTRAINT "connection_freshness_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_freshness_workspace_idx" ON "connection_freshness" USING btree ("workspace_id");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "connection_freshness" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "connection_freshness" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection_freshness" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connection_freshness_tenant" ON "connection_freshness"
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
