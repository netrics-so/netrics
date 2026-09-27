-- #35 / ADR 0008: observation schema v2.
--
-- Metric definitions declare their time granularity. Existing definitions
-- (the demo connector) are daily; the catalog sync refreshes them from the
-- manifests on the next start anyway.
ALTER TABLE "metric_definitions" ADD COLUMN "granularity" text;
--> statement-breakpoint
UPDATE "metric_definitions" SET "granularity" = 'day' WHERE "granularity" IS NULL;
--> statement-breakpoint
ALTER TABLE "metric_definitions" ALTER COLUMN "granularity" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "metric_definitions" ADD CONSTRAINT "metric_definitions_granularity_valid" CHECK ("metric_definitions"."granularity" in ('day', 'hour', 'instant'));
--> statement-breakpoint
-- Credential envelopes carry their key id since #29; the column is unused.
ALTER TABLE "connections" DROP COLUMN "credentials_key_version";
--> statement-breakpoint
-- Observations are identified by (connection, metric, series, timestamp).
-- series_key is derived by the database from the canonical jsonb text of the
-- dimensions (jsonb normalizes key order), so it cannot diverge between code
-- paths.
ALTER TABLE "observations" ADD COLUMN "series_key" text GENERATED ALWAYS AS (md5(dimensions::text)) STORED NOT NULL;
--> statement-breakpoint
-- Rows that collapse onto one key under the new identity keep the most
-- recently ingested value.
DELETE FROM "observations" o
USING "observations" newer
WHERE o."connection_id" = newer."connection_id"
  AND o."metric_definition_id" = newer."metric_definition_id"
  AND o."series_key" = newer."series_key"
  AND o."source_timestamp" = newer."source_timestamp"
  AND (newer."ingested_at", newer."id") > (o."ingested_at", o."id");
--> statement-breakpoint
ALTER TABLE "observations" DROP CONSTRAINT "observations_connection_id_source_identity_unique";
--> statement-breakpoint
-- Covered by the new primary key (its leading column).
DROP INDEX "observations_connection_time_idx";
--> statement-breakpoint
ALTER TABLE "observations" DROP CONSTRAINT "observations_pkey";
--> statement-breakpoint
ALTER TABLE "observations" DROP COLUMN "id";
--> statement-breakpoint
ALTER TABLE "observations" DROP COLUMN "source_identity";
--> statement-breakpoint
-- Includes source_timestamp, as PostgreSQL requires for a unique key on a
-- time-partitioned table.
ALTER TABLE "observations" ADD CONSTRAINT "observations_pkey" PRIMARY KEY ("connection_id", "metric_definition_id", "series_key", "source_timestamp");
