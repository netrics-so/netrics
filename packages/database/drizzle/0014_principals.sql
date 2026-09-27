CREATE TABLE "principal_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"workspace_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "principal_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "principal_tokens_kind_valid" CHECK ("principal_tokens"."kind" in ('service', 'device')),
	CONSTRAINT "principal_tokens_device_workspace" CHECK (("principal_tokens"."kind" = 'device') = ("principal_tokens"."workspace_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_instance_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "principal_tokens" ADD CONSTRAINT "principal_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ADR 0009. Tokens are resolved only through resolve_principal_token(); the
-- application role cannot read or write the table (default privileges would
-- otherwise grant full DML).
REVOKE ALL ON "principal_tokens" FROM netrics_app;
--> statement-breakpoint
-- The application may create users and change their contact data, but never
-- grant installation administration. (Column-level grants would not work:
-- ORMs name every column, sending DEFAULT, which needs column privilege.)
CREATE OR REPLACE FUNCTION guard_instance_admin()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user = 'netrics_app' AND (
    (TG_OP = 'INSERT' AND NEW.is_instance_admin)
    OR (TG_OP = 'UPDATE' AND NEW.is_instance_admin IS DISTINCT FROM OLD.is_instance_admin)
  ) THEN
    RAISE EXCEPTION 'permission denied: is_instance_admin is managed by the installation'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_guard_instance_admin
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION guard_instance_admin();
--> statement-breakpoint
-- Existing installations: the account created through first-run setup is
-- the instance administrator.
UPDATE "users" SET "is_instance_admin" = true
WHERE "id" = (SELECT "owner_user_id" FROM "installation_setup" WHERE "id" = 1);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION resolve_principal_token(p_token_hash text)
RETURNS TABLE (id uuid, kind text, name text, scopes text[], workspace_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT t.id, t.kind, t.name, t.scopes, t.workspace_id
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
-- Installation admin API: cross-workspace reads the API authorizes first
-- (instance admin session or a service token with the matching scope).
CREATE OR REPLACE FUNCTION admin_list_workspaces()
RETURNS TABLE (id uuid, name text, created_at timestamptz, member_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.id, w.name, w.created_at, count(m.id)
  FROM workspaces w
  LEFT JOIN memberships m ON m.workspace_id = w.id
  GROUP BY w.id
  ORDER BY w.created_at;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_list_workspaces() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_workspaces() TO netrics_app;
--> statement-breakpoint
-- When first-run setup records its owner, that account becomes the instance
-- administrator. Done by the database (the application role cannot write the
-- column).
CREATE OR REPLACE FUNCTION grant_setup_owner_instance_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.owner_user_id IS NOT NULL THEN
    UPDATE users SET is_instance_admin = true WHERE id = NEW.owner_user_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER installation_setup_owner_admin
  AFTER INSERT OR UPDATE OF owner_user_id ON installation_setup
  FOR EACH ROW EXECUTE FUNCTION grant_setup_owner_instance_admin();
