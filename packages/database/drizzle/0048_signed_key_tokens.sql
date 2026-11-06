-- #369 (ADR 0020 §2): the cached access token of a signed-key connection
-- whose provider exchanges a signed client secret for it (Apple Ads), in its
-- own envelope beside the key envelope in connections.credentials_encrypted.
-- One row per connection, created on the first exchange; it is also the row
-- the exchange locks. Deleted with the connection (cascade) and when the
-- connection's credentials change.
--
-- Existing rows: none are touched; no connection has a row until its first
-- exchange. App Store Connect connections never get one.
CREATE TABLE "connection_signed_key_tokens" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"access_token_encrypted" "bytea",
	"access_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_signed_key_tokens_expiry" CHECK (("connection_signed_key_tokens"."access_token_encrypted" is null) = ("connection_signed_key_tokens"."access_token_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "connection_signed_key_tokens" ADD CONSTRAINT "connection_signed_key_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_signed_key_tokens" ADD CONSTRAINT "connection_signed_key_tokens_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_signed_key_tokens_workspace_idx" ON "connection_signed_key_tokens" USING btree ("workspace_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "connection_signed_key_tokens" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "connection_signed_key_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection_signed_key_tokens" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connection_signed_key_tokens_select" ON "connection_signed_key_tokens" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_signed_key_tokens_insert" ON "connection_signed_key_tokens" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_signed_key_tokens_update" ON "connection_signed_key_tokens" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_signed_key_tokens_delete" ON "connection_signed_key_tokens" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
