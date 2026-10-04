-- #335 (ADR 0019 section 4): goals, a named target for one metric in a
-- period to date, shared by gauge widgets (#339) and later alert rules. A
-- workspace table under RLS like the others; the composite key keeps a goal
-- on a connection of its own workspace and deletes it with the connection.
--
-- Existing rows: a new table, nothing is rewritten.
CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"aggregation" text NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display_currency" text,
	"period" text NOT NULL,
	"target" double precision NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_id_workspace_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "goals_name_valid" CHECK (char_length("goals"."name") between 1 and 60),
	CONSTRAINT "goals_aggregation_valid" CHECK ("goals"."aggregation" in ('sum', 'last')),
	CONSTRAINT "goals_period_valid" CHECK ("goals"."period" in ('today', 'this_week', 'this_month', 'this_quarter', 'this_year')),
	CONSTRAINT "goals_target_valid" CHECK ("goals"."target" > 0 and "goals"."target" <= 1e15),
	CONSTRAINT "goals_dimensions_object" CHECK (jsonb_typeof("goals"."dimensions") = 'object'),
	CONSTRAINT "goals_version_positive" CHECK ("goals"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goals_name_unique" ON "goals" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "goals_connection_idx" ON "goals" USING btree ("connection_id");

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "goals" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "goals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "goals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "goals_select" ON "goals" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "goals_insert" ON "goals" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "goals_update" ON "goals" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "goals_delete" ON "goals" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
