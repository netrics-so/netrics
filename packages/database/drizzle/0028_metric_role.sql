-- #166: a metric's role, "primary" (default) or "helper" (an input for
-- derived values, not offered for tiles). Existing definitions become
-- "primary"; migrate re-syncs the catalog from the manifests afterwards.
ALTER TABLE "metric_definitions" ADD COLUMN "role" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_role_valid" CHECK ("metric_definitions"."role" in ('primary', 'helper'));