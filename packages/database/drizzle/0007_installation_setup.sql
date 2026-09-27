CREATE TABLE "installation_setup" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"owner_user_id" uuid,
	CONSTRAINT "installation_setup_singleton" CHECK ("installation_setup"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "installation_setup" ADD CONSTRAINT "installation_setup_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Installation-level (no tenant RLS). Default privileges grant netrics_app
-- full DML; the setup row is only ever upserted and consumed, never deleted.
REVOKE DELETE, TRUNCATE ON "installation_setup" FROM netrics_app;
