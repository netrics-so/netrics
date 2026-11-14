-- Archived dashboards (template updates, 11E): a dashboard an updated store
-- template copy replaced on its screens. No backfill: every existing
-- dashboard stays unarchived.
ALTER TABLE "dashboards" ADD COLUMN "archived_at" timestamp with time zone;