-- The project a new OAuth connection starts in (#589). Authorizations in
-- flight (short-lived) keep no project. consume_oauth_authorization() also
-- returns it; a function's result columns cannot change in place, so it is
-- recreated with the same body, settings and grants as in 0022.
ALTER TABLE "oauth_authorizations" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_project_connect" CHECK ("oauth_authorizations"."project_id" is null or "oauth_authorizations"."purpose" = 'connect');--> statement-breakpoint
DROP FUNCTION consume_oauth_authorization(text);
--> statement-breakpoint
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
  code_verifier_encrypted bytea,
  project_id uuid
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
    a.code_verifier_encrypted,
    a.project_id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION consume_oauth_authorization(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION consume_oauth_authorization(text) TO netrics_app;
