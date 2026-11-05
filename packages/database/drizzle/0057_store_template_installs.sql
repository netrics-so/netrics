CREATE TABLE "data_template_installs" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_template_installs_workspace_id_request_id_pk" PRIMARY KEY("workspace_id","request_id"),
	CONSTRAINT "data_template_installs_hash" CHECK ("data_template_installs"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "data_template_installs" ADD CONSTRAINT "data_template_installs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE data_template_installs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_template_installs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_template_installs_tenant ON data_template_installs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON data_template_installs TO netrics_app;
