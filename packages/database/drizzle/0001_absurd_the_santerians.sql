CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_unique" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "memberships_role_valid" CHECK ("memberships"."role" in ('owner', 'admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_user_id" text,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_auth_user_id_unique" UNIQUE("auth_user_id"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Roles (hand-written, idempotent per ADR 0001). Dev passwords only; production
-- must provision these roles with its own secrets before applying migrations.
-- The duplicate_object guard tolerates concurrent first-run migrations racing
-- on the shared pg_roles catalog (roles are cluster-global, not per-database).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netrics_app') THEN
    BEGIN
      CREATE ROLE netrics_app LOGIN NOINHERIT PASSWORD 'netrics_app';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'netrics_scheduler') THEN
    BEGIN
      CREATE ROLE netrics_scheduler LOGIN NOINHERIT PASSWORD 'netrics_scheduler';
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO netrics_app', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO netrics_scheduler', current_database());
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO netrics_app;
--> statement-breakpoint
GRANT SELECT ON "schema_info" TO netrics_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "users", "workspaces", "memberships", "projects" TO netrics_app;
--> statement-breakpoint
-- audit_events is append-only: no UPDATE/DELETE grant.
GRANT SELECT, INSERT ON "audit_events" TO netrics_app;
--> statement-breakpoint
-- netrics_scheduler is intentionally narrow: no table grants until a later
-- milestone grants exactly what it needs.
-- Default privileges: tables created by future migrations (run by the same
-- migration role = current_user here) inherit app-role grants automatically.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO netrics_app',
    current_user
  );
END
$$;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Tenant context is carried by transaction-local settings app.workspace_id /
-- app.user_id (see packages/database/src/context.ts). Unset or empty = NULL.
-- INSERT with no workspace context is allowed so create_workspace() can insert
-- the workspace row before a tenant context exists; every other operation is
-- scoped to the current workspace.
CREATE POLICY "workspaces_select" ON "workspaces" FOR SELECT
  USING ("id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "workspaces_insert" ON "workspaces" FOR INSERT
  WITH CHECK (
    nullif(current_setting('app.workspace_id', true), '') IS NULL
    OR "id" = nullif(current_setting('app.workspace_id', true), '')::uuid
  );
--> statement-breakpoint
CREATE POLICY "workspaces_update" ON "workspaces" FOR UPDATE
  USING ("id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "workspaces_delete" ON "workspaces" FOR DELETE
  USING ("id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- The user_id path lets a session list its own memberships before any
-- workspace context exists (workspace discovery); it only ever exposes the
-- caller's own rows.
CREATE POLICY "memberships_select" ON "memberships" FOR SELECT
  USING (
    "workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR "user_id" = nullif(current_setting('app.user_id', true), '')::uuid
  );
--> statement-breakpoint
-- All membership writes require tenant context. Workspace creation (which has
-- no context yet) goes through the SECURITY DEFINER create_workspace()
-- function, so there is deliberately no no-context INSERT path here.
CREATE POLICY "memberships_insert" ON "memberships" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "memberships_update" ON "memberships" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "memberships_delete" ON "memberships" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "projects_select" ON "projects" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "projects_insert" ON "projects" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "projects_update" ON "projects" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "projects_delete" ON "projects" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Append-only: any caller may INSERT (installation-level events included),
-- but SELECT is scoped to the current workspace, so installation-level events
-- (workspace_id NULL) are never visible to tenants.
CREATE POLICY "audit_events_insert" ON "audit_events" FOR INSERT
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "audit_events_select" ON "audit_events" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Workspace + owner membership creation. SECURITY DEFINER under the migration
-- role, which owns the tables and is itself subject to FORCE RLS, so the
-- function drives the same policies: it clears any caller context (workspace
-- INSERT requires a NULL context), inserts the workspace, adopts it as the
-- tenant context, then inserts the owner membership (allowed because
-- workspace_id now matches the context). This is the ONLY way to create a
-- workspace; because the workspace id is generated inside the function, the
-- no-context memberships INSERT path that could be abused to join someone
-- else's workspace does not exist at all.
CREATE OR REPLACE FUNCTION create_workspace(p_name text, p_owner_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id uuid;
BEGIN
  PERFORM set_config('app.workspace_id', '', true);
  INSERT INTO workspaces (name) VALUES (p_name) RETURNING id INTO v_workspace_id;
  PERFORM set_config('app.workspace_id', v_workspace_id::text, true);
  INSERT INTO memberships (workspace_id, user_id, role)
    VALUES (v_workspace_id, p_owner_user_id, 'owner');
  RETURN v_workspace_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION create_workspace(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION create_workspace(text, uuid) TO netrics_app;
--> statement-breakpoint
-- Last-owner guard: runs as the invoking role, which is fine because all
-- membership writes happen inside a tenant transaction whose RLS context
-- already exposes every membership of that workspace.
CREATE OR REPLACE FUNCTION guard_last_workspace_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  remaining_owners integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.role <> 'owner' THEN
      RETURN OLD;
    END IF;
    SELECT count(*) INTO remaining_owners FROM memberships
      WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND id <> OLD.id;
    IF remaining_owners = 0 THEN
      RAISE EXCEPTION 'cannot remove the last owner of workspace %', OLD.workspace_id;
    END IF;
    RETURN OLD;
  ELSE
    IF OLD.role <> 'owner' OR NEW.role = 'owner' THEN
      RETURN NEW;
    END IF;
    SELECT count(*) INTO remaining_owners FROM memberships
      WHERE workspace_id = OLD.workspace_id AND role = 'owner' AND id <> OLD.id;
    IF remaining_owners = 0 THEN
      RAISE EXCEPTION 'cannot demote the last owner of workspace %', OLD.workspace_id;
    END IF;
    RETURN NEW;
  END IF;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "memberships_guard_last_owner"
  BEFORE DELETE OR UPDATE OF role ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION guard_last_workspace_owner();
