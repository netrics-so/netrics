-- A paired screen's fixed scope (#500). Null for every existing device: it
-- keeps showing its dashboard as saved.
ALTER TABLE "devices" ADD COLUMN "scope" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_scope_shape" CHECK ("devices"."scope" is null or coalesce(jsonb_typeof("devices"."scope" -> 'dashboardId') = 'string' and jsonb_typeof("devices"."scope" -> 'values') = 'object', false));
