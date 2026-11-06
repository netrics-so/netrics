ALTER TABLE "data_models" ADD COLUMN "restored_from_version" integer;--> statement-breakpoint
ALTER TABLE "data_preparations" ADD COLUMN "restored_from_version" integer;--> statement-breakpoint
-- Match the existing tenant-bound deferred publication FKs. A restore marker
-- can only refer to a retained immutable definition belonging to this draft.
ALTER TABLE data_preparations ADD CONSTRAINT data_preparations_restored_fk
FOREIGN KEY (id, workspace_id, restored_from_version)
REFERENCES data_preparation_versions(preparation_id, workspace_id, version)
DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE data_models ADD CONSTRAINT data_models_restored_fk
FOREIGN KEY (id, workspace_id, restored_from_version)
REFERENCES data_model_releases(model_id, workspace_id, version)
DEFERRABLE INITIALLY DEFERRED;
