-- #57: the latest device heartbeat. Nullable columns only, safe on existing rows.
ALTER TABLE "devices" ADD COLUMN "app_version" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "uptime_seconds" integer;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "last_heartbeat_at" timestamp with time zone;
