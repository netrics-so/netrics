-- #371 (ADR 0020 §3): pending generated keys. The host generates an EC
-- P-256 key pair for a signed-key provider whose user pastes the public key
-- at the provider (Apple Ads); the private key waits here, sealed in an
-- AES-GCM envelope bound to the row, until a connection is created (or its
-- key replaced) with the row's id. Then it moves into the connection's
-- envelope and the row is deleted in the same commit.
--
-- A row belongs to its workspace and to the user who generated it: RLS
-- checks both (app.workspace_id and app.user_id), and the queries name both
-- again. Rows never change (no UPDATE grant). They expire after 24 hours;
-- the scheduler deletes expired rows (prune_signed_key_pending_keys, as the
-- owner, like prune_oauth_authorizations in 0024).
--
-- Existing rows: none; this is a new table.
CREATE TABLE "signed_key_pending_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"private_key_encrypted" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signed_key_pending_keys" ADD CONSTRAINT "signed_key_pending_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signed_key_pending_keys" ADD CONSTRAINT "signed_key_pending_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signed_key_pending_keys_workspace_user_idx" ON "signed_key_pending_keys" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "signed_key_pending_keys_expires_idx" ON "signed_key_pending_keys" USING btree ("expires_at");--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "signed_key_pending_keys" TO netrics_app;
--> statement-breakpoint
-- The schema's default privileges also grant UPDATE; pending keys never change.
REVOKE UPDATE ON "signed_key_pending_keys" FROM netrics_app;
--> statement-breakpoint
ALTER TABLE "signed_key_pending_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "signed_key_pending_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "signed_key_pending_keys_select" ON "signed_key_pending_keys" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "signed_key_pending_keys_insert" ON "signed_key_pending_keys" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "signed_key_pending_keys_delete" ON "signed_key_pending_keys" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    AND "user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE FUNCTION prune_signed_key_pending_keys(p_batch integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM signed_key_pending_keys
  WHERE id IN (
    SELECT k.id FROM signed_key_pending_keys k
    WHERE k.expires_at <= now()
    LIMIT p_batch
  );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_signed_key_pending_keys(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_signed_key_pending_keys(integer) TO netrics_scheduler;
