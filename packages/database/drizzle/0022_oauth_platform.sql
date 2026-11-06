-- ADR 0012, #131: OAuth authorizations in progress, the OAuth grant of a
-- connection, and the needs_reauthorization state. Existing rows: every
-- connection_state row has auth_state ok, auth_failed or outage, which the
-- wider check accepts, and the new auth_reason column is null, which both
-- new checks accept. No existing connection gets a connection_oauth row.
CREATE TABLE "connection_oauth" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_sub" text NOT NULL,
	"account_email" text,
	"granted_scopes" text[] NOT NULL,
	"access_token_encrypted" "bytea",
	"access_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_oauth_access_token_expiry" CHECK (("connection_oauth"."access_token_encrypted" is null) = ("connection_oauth"."access_token_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "oauth_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connector_id" text NOT NULL,
	"connection_id" uuid,
	"purpose" text NOT NULL,
	"allow_account_change" boolean DEFAULT false NOT NULL,
	"return_path" text NOT NULL,
	"state_hash" text NOT NULL,
	"nonce" text NOT NULL,
	"code_verifier_encrypted" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_authorizations_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "oauth_authorizations_purpose_valid" CHECK ("oauth_authorizations"."purpose" in ('connect', 'reauthorize')),
	CONSTRAINT "oauth_authorizations_purpose_connection" CHECK (("oauth_authorizations"."purpose" = 'reauthorize') = ("oauth_authorizations"."connection_id" is not null)),
	CONSTRAINT "oauth_authorizations_account_change" CHECK (not "oauth_authorizations"."allow_account_change" or "oauth_authorizations"."purpose" = 'reauthorize'),
	CONSTRAINT "oauth_authorizations_return_path" CHECK ("oauth_authorizations"."return_path" like '/%' and "oauth_authorizations"."return_path" not like '//%')
);
--> statement-breakpoint
ALTER TABLE "connection_state" DROP CONSTRAINT "connection_state_auth_state_valid";--> statement-breakpoint
ALTER TABLE "connection_state" ADD COLUMN "auth_reason" text;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_oauth" ADD CONSTRAINT "connection_oauth_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_oauth_provider_sub_idx" ON "connection_oauth" USING btree ("provider","account_sub");--> statement-breakpoint
CREATE INDEX "connection_oauth_workspace_idx" ON "connection_oauth" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "oauth_authorizations_workspace_idx" ON "oauth_authorizations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "oauth_authorizations_connection_idx" ON "oauth_authorizations" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "oauth_authorizations_expires_idx" ON "oauth_authorizations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "connection_state" ADD CONSTRAINT "connection_state_auth_reason_valid" CHECK ("connection_state"."auth_reason" in ('invalid_grant', 'scope_missing'));--> statement-breakpoint
ALTER TABLE "connection_state" ADD CONSTRAINT "connection_state_auth_reason_state" CHECK ("connection_state"."auth_reason" is null or "connection_state"."auth_state" = 'needs_reauthorization');--> statement-breakpoint
ALTER TABLE "connection_state" ADD CONSTRAINT "connection_state_auth_state_valid" CHECK ("connection_state"."auth_state" in ('ok', 'auth_failed', 'needs_reauthorization', 'outage'));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "oauth_authorizations", "connection_oauth" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "oauth_authorizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "oauth_authorizations_select" ON "oauth_authorizations" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "oauth_authorizations_insert" ON "oauth_authorizations" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "oauth_authorizations_update" ON "oauth_authorizations" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "oauth_authorizations_delete" ON "oauth_authorizations" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "connection_oauth" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "connection_oauth" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "connection_oauth_select" ON "connection_oauth" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_oauth_insert" ON "connection_oauth" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_oauth_update" ON "connection_oauth" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "connection_oauth_delete" ON "connection_oauth" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The OAuth callback learns the workspace only from the state, so it looks
-- the authorization up by the state's SHA-256 and consumes it in the same
-- statement (the pattern of resolve_principal_token, ADR 0009). Unknown,
-- expired or already consumed states return no row; of two concurrent calls
-- with one state, the second waits on the row lock and then finds it
-- consumed. Returns what the callback needs to validate and finish, nothing
-- else. The migration role owns the table and is superuser/BYPASSRLS, like
-- for the other definer functions.
CREATE FUNCTION consume_oauth_authorization(p_state_hash text)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  user_id uuid,
  provider text,
  connector_id text,
  connection_id uuid,
  purpose text,
  allow_account_change boolean,
  return_path text,
  nonce text,
  code_verifier_encrypted bytea
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE oauth_authorizations a
  SET consumed_at = now()
  WHERE a.state_hash = p_state_hash
    AND a.consumed_at IS NULL
    AND a.expires_at > now()
  RETURNING
    a.id,
    a.workspace_id,
    a.user_id,
    a.provider,
    a.connector_id,
    a.connection_id,
    a.purpose,
    a.allow_account_change,
    a.return_path,
    a.nonce,
    a.code_verifier_encrypted;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION consume_oauth_authorization(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION consume_oauth_authorization(text) TO netrics_app;
