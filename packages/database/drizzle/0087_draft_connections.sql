-- Draft connections of the custom API builder (milestone 13, #806): a
-- custom-api connection with status 'draft' holds the builder's credentials
-- before the definition is saved. It has no pin, is never scheduled (its
-- connection_state.next_due_at stays null), is hidden from every connection
-- path and is deleted 24 hours after it was last touched. Existing rows
-- become 'active' through the column default; their pins and schedules are
-- unchanged.
-- connections is read and written by every request path: a lock not granted
-- within 5 s fails the migration (to be re-run) instead of queueing those
-- requests behind a long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "custom_api_test_rate" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "custom_api_test_rate_count_nonnegative" CHECK ("custom_api_test_rate"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "custom_api_test_rate" ADD CONSTRAINT "custom_api_test_rate_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A constant default: no table rewrite.
ALTER TABLE "connections" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
-- The pin check is relaxed for drafts: dropped, then added again, one
-- statement each. Added without checking the existing rows, then validated.
ALTER TABLE "connections" DROP CONSTRAINT "connections_custom_api_pin";--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_custom_api_pin" CHECK (case when "connections"."status" = 'draft' then "connections"."custom_api_definition_version_id" is null and "connections"."custom_api_environment_id" is null else ("connections"."connector_id" = 'custom-api') = ("connections"."custom_api_definition_version_id" is not null) and ("connections"."custom_api_definition_version_id" is null) = ("connections"."custom_api_environment_id" is null) end) NOT VALID;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_status_valid" CHECK ("connections"."status" in ('active','draft')) NOT VALID;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_draft_custom_api" CHECK ("connections"."status" <> 'draft' or "connections"."connector_id" = 'custom-api') NOT VALID;--> statement-breakpoint
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_custom_api_pin";--> statement-breakpoint
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_status_valid";--> statement-breakpoint
ALTER TABLE "connections" VALIDATE CONSTRAINT "connections_draft_custom_api";--> statement-breakpoint
-- No row is a draft yet, so the partial index is empty when it is built.
CREATE INDEX "connections_draft_updated_idx" ON "connections" USING btree ("updated_at") WHERE "connections"."status" = 'draft';--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;--> statement-breakpoint
ALTER TABLE custom_api_test_rate ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE custom_api_test_rate FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY custom_api_test_rate_tenant ON custom_api_test_rate
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- The default privileges (0001) grant netrics_app everything on new tables:
-- narrow them. A workspace's row is kept and reused; it goes with the
-- workspace.
REVOKE ALL ON custom_api_test_rate FROM netrics_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON custom_api_test_rate TO netrics_app;--> statement-breakpoint
-- Drafts untouched for p_age (24 hours, DRAFT_CONNECTION_TTL_HOURS in
-- packages/database/src/draft-connections.ts) are deleted by the scheduler's
-- maintenance, with their connection_state (ON DELETE CASCADE). The status
-- predicate sits in the DELETE itself, so a draft promoted after the inner
-- select read it is never deleted.
--
-- netrics_scheduler has no grant on connections, so this runs as the owner,
-- like prune_revoked_devices (migration 0070). At most p_batch rows per call;
-- a count equal to p_batch means more remain for the next run. p_now is the
-- caller's clock, so tests can pin it.
CREATE FUNCTION prune_draft_connections(
  p_now timestamptz,
  p_age interval,
  p_batch integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM connections
  WHERE status = 'draft'
    AND updated_at < p_now - p_age
    AND id IN (
      SELECT c.id FROM connections c
      WHERE c.status = 'draft' AND c.updated_at < p_now - p_age
      LIMIT p_batch
    );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_draft_connections(timestamptz, interval, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_draft_connections(timestamptz, interval, integer) TO netrics_scheduler;
