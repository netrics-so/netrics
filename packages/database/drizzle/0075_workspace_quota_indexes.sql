-- Workspace-leading indexes for the per-workspace quota and usage queries
-- (#604). datasetWorkspaceBytes read a workspace's generations and
-- refreshes through the (id, workspace_id) tenant keys, which have no
-- usable prefix for workspace_id, so it scanned every leaf page of both; the
-- prepared-cache, staging and source-count quotas were sequential scans.
-- Under serializable isolation each scan is a predicate lock on every
-- workspace's entries (the leaf pages, or the whole relation), so a write
-- in any workspace conflicted with the quota check of every other one.
-- With these indexes each query reads, and locks, its own workspace's
-- pages only.
--
-- Drizzle runs all pending migrations in one transaction, so CREATE INDEX
-- CONCURRENTLY is not available. A plain build holds a SHARE lock on its
-- table until the migration commits: reads go on, writes (ingestion,
-- staging, cache writes, source registration) wait. These are metadata
-- tables, one row per dataset, refresh, generation, cache entry or stage
-- (raw rows live in data_pages and data_records, which get no index here);
-- builds took 0.02-0.1 s per table at 60k-240k rows. All five locks are
-- taken first, in the order ingestion writes the tables, and a lock that
-- is not granted within 5 s fails the migration (to be re-run) instead of
-- queueing every new write behind a long-running transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
LOCK TABLE "data_datasets", "data_refreshes", "data_generations", "data_prepared_generations", "data_connector_stages" IN SHARE MODE;--> statement-breakpoint
CREATE INDEX "data_connector_stages_workspace_idx" ON "data_connector_stages" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "data_datasets_workspace_idx" ON "data_datasets" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "data_generations_workspace_idx" ON "data_generations" USING btree ("workspace_id","dataset_id","sequence");--> statement-breakpoint
CREATE INDEX "data_prepared_generations_workspace_idx" ON "data_prepared_generations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "data_refreshes_workspace_idx" ON "data_refreshes" USING btree ("workspace_id","dataset_id");--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
