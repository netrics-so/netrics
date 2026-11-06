-- #136: which way is good for a metric ("higher" or "lower", e.g. an average
-- position). Existing definitions default to "higher"; migrate re-syncs the
-- catalog from the manifests afterwards.
ALTER TABLE "metric_definitions" ADD COLUMN "better" text DEFAULT 'higher' NOT NULL;--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_better_valid" CHECK ("metric_definitions"."better" in ('higher', 'lower'));