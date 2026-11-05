-- Retention may already have removed all evidence of an older publication.
-- Conservatively mark pre-migration sources as historical; their first new
-- complete generation restores normal queries. Never revive pruned history
-- as a newly connected empty source.
ALTER TABLE "data_datasets" ADD COLUMN "has_published_data" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "data_datasets" ALTER COLUMN "has_published_data" SET DEFAULT false;
