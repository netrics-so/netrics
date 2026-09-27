CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"delivery" text NOT NULL,
	"invited_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by_user_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invitations_role_valid" CHECK ("invitations"."role" in ('owner', 'admin', 'editor', 'viewer')),
	CONSTRAINT "invitations_delivery_valid" CHECK ("invitations"."delivery" in ('email', 'manual')),
	CONSTRAINT "invitations_email_lowercase" CHECK ("invitations"."email" = lower("invitations"."email"))
);
--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_open_email" ON "invitations" USING btree ("workspace_id","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
-- Tenant table: RLS scoped to the context workspace. Invitations are never
-- deleted (revoked/accepted rows remain as history).
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON "invitations" FROM netrics_app;
--> statement-breakpoint
CREATE POLICY "invitations_select" ON "invitations" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "invitations_insert" ON "invitations" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "invitations_update" ON "invitations" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The invitee is not a member yet, so looking an invitation up by token must
-- work without a tenant context. SECURITY DEFINER functions keep that surface
-- to exactly two operations keyed by the token hash (a 256-bit secret).
--
-- Preview: what the invite page shows before sign-in.
CREATE OR REPLACE FUNCTION invitation_preview(p_token_hash text)
RETURNS TABLE (
  invitation_id uuid,
  workspace_name text,
  email text,
  role text,
  delivery text,
  status text,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    i.id,
    w.name,
    i.email,
    i.role,
    i.delivery,
    CASE
      WHEN i.revoked_at IS NOT NULL THEN 'revoked'
      WHEN i.accepted_at IS NOT NULL THEN 'accepted'
      WHEN i.expires_at <= now() THEN 'expired'
      ELSE 'pending'
    END,
    i.expires_at
  FROM invitations i
  JOIN workspaces w ON w.id = i.workspace_id
  WHERE i.token_hash = p_token_hash;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION invitation_preview(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION invitation_preview(text) TO netrics_app;
--> statement-breakpoint
-- Accept: grants the membership to the account whose email matches the
-- invitation. Idempotent for the same user; an existing membership keeps its
-- role. Errors are raised with stable messages the API maps to responses.
CREATE OR REPLACE FUNCTION accept_invitation(p_token_hash text, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_invitation invitations%ROWTYPE;
  v_email text;
BEGIN
  SELECT * INTO v_invitation FROM invitations
    WHERE token_hash = p_token_hash
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation_not_found';
  END IF;
  IF v_invitation.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'invitation_revoked';
  END IF;
  IF v_invitation.accepted_at IS NOT NULL THEN
    IF v_invitation.accepted_by_user_id = p_user_id THEN
      RETURN v_invitation.workspace_id;
    END IF;
    RAISE EXCEPTION 'invitation_used';
  END IF;
  IF v_invitation.expires_at <= now() THEN
    RAISE EXCEPTION 'invitation_expired';
  END IF;
  SELECT lower(email) INTO v_email FROM users WHERE id = p_user_id;
  IF v_email IS DISTINCT FROM v_invitation.email THEN
    RAISE EXCEPTION 'invitation_email_mismatch';
  END IF;

  PERFORM set_config('app.workspace_id', v_invitation.workspace_id::text, true);
  INSERT INTO memberships (workspace_id, user_id, role)
    VALUES (v_invitation.workspace_id, p_user_id, v_invitation.role)
    ON CONFLICT (workspace_id, user_id) DO NOTHING;
  UPDATE invitations
    SET accepted_at = now(), accepted_by_user_id = p_user_id
    WHERE id = v_invitation.id;
  INSERT INTO audit_events (workspace_id, actor_user_id, action, target, metadata)
    VALUES (
      v_invitation.workspace_id,
      p_user_id,
      'invitation.accepted',
      v_invitation.id::text,
      jsonb_build_object('role', v_invitation.role, 'email', v_invitation.email)
    );
  RETURN v_invitation.workspace_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION accept_invitation(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION accept_invitation(text, uuid) TO netrics_app;
