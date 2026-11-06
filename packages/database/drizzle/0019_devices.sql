-- ADR 0011: paired devices, pairings in progress and device credentials.
-- No device tokens exist yet, so the new principal_tokens check holds for
-- every existing row (all are kind 'service').
CREATE TABLE "device_pairing_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"poll_secret_hash" text NOT NULL,
	"client_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"workspace_id" uuid,
	"device_id" uuid,
	"claimed_at" timestamp with time zone,
	CONSTRAINT "device_pairings_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "device_pairings_approval_complete" CHECK (("device_pairings"."approved_at" is null) = ("device_pairings"."device_id" is null))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"dashboard_id" uuid,
	"approved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_id_workspace_unique" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
ALTER TABLE "principal_tokens" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "device_pairing_failures" ADD CONSTRAINT "device_pairing_failures_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_pairing_failures_user_idx" ON "device_pairing_failures" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "device_pairings_client_idx" ON "device_pairings" USING btree ("client_key","created_at");--> statement-breakpoint
CREATE INDEX "device_pairings_expires_idx" ON "device_pairings" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "devices_workspace_idx" ON "devices" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "principal_tokens" ADD CONSTRAINT "principal_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "principal_tokens_device_idx" ON "principal_tokens" USING btree ("device_id");--> statement-breakpoint
ALTER TABLE "principal_tokens" ADD CONSTRAINT "principal_tokens_device_id" CHECK (("principal_tokens"."kind" = 'device') = ("principal_tokens"."device_id" is not null));
--> statement-breakpoint
-- A device shows a dashboard of its own workspace. Deleting the dashboard
-- clears only dashboard_id (a column-list SET NULL, which drizzle cannot
-- express).
ALTER TABLE "devices" ADD CONSTRAINT "devices_dashboard_fk" FOREIGN KEY ("dashboard_id","workspace_id") REFERENCES "public"."dashboards"("id","workspace_id") ON DELETE SET NULL ("dashboard_id") ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "devices", "device_pairings", "device_pairing_failures" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "devices_select" ON "devices" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "devices_insert" ON "devices" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "devices_update" ON "devices" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "devices_delete" ON "devices" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Token resolution now also reports the device a token belongs to. The
-- result type changes, so the function is replaced, not altered.
DROP FUNCTION resolve_principal_token(text);
--> statement-breakpoint
CREATE FUNCTION resolve_principal_token(p_token_hash text)
RETURNS TABLE (id uuid, kind text, name text, scopes text[], workspace_id uuid, device_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT t.id, t.kind, t.name, t.scopes, t.workspace_id, t.device_id
    FROM principal_tokens t
    WHERE t.token_hash = p_token_hash
      AND t.revoked_at IS NULL
      AND (t.expires_at IS NULL OR t.expires_at > now());
  -- Usage tracking at minute resolution, so a busy client does not write on
  -- every request.
  UPDATE principal_tokens t SET last_used_at = now()
  WHERE t.token_hash = p_token_hash
    AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute');
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION resolve_principal_token(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION resolve_principal_token(text) TO netrics_app;
--> statement-breakpoint
-- Issues a device's access and refresh tokens (hashes only). The device must
-- exist in the given workspace and not be revoked; the caller runs in that
-- workspace's tenant context, so RLS on devices agrees.
CREATE FUNCTION issue_device_tokens(
  p_device_id uuid,
  p_workspace_id uuid,
  p_name text,
  p_access_hash text,
  p_access_expires_at timestamptz,
  p_refresh_hash text,
  p_refresh_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM devices d
    WHERE d.id = p_device_id
      AND d.workspace_id = p_workspace_id
      AND d.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'device % is not active in workspace %', p_device_id, p_workspace_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO principal_tokens (kind, name, token_hash, scopes, workspace_id, device_id, expires_at)
  VALUES
    ('device', p_name, p_access_hash, ARRAY['device:read'], p_workspace_id, p_device_id, p_access_expires_at),
    ('device', p_name, p_refresh_hash, ARRAY['device:refresh'], p_workspace_id, p_device_id, p_refresh_expires_at);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION issue_device_tokens(uuid, uuid, text, text, timestamptz, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION issue_device_tokens(uuid, uuid, text, text, timestamptz, text, timestamptz) TO netrics_app;
--> statement-breakpoint
-- Revokes every live token of a device. Returns how many were revoked.
CREATE FUNCTION revoke_device_tokens(p_device_id uuid, p_workspace_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  revoked integer;
BEGIN
  UPDATE principal_tokens t SET revoked_at = now()
  WHERE t.device_id = p_device_id
    AND t.workspace_id = p_workspace_id
    AND t.revoked_at IS NULL;
  GET DIAGNOSTICS revoked = ROW_COUNT;
  RETURN revoked;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION revoke_device_tokens(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION revoke_device_tokens(uuid, uuid) TO netrics_app;
