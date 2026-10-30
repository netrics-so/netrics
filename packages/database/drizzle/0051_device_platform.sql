-- #406 (ADR 0021): the platform a device runs on, as it reports it when it
-- starts pairing (kept on the pairing, copied to the device at approval) or
-- in a heartbeat. Nullable without a default: paired TVs and kiosks keep
-- null ("not reported") until a heartbeat fills it in, and no row is
-- rewritten. The checks see only nulls on existing rows.
ALTER TABLE "device_pairings" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_platform_valid" CHECK ("device_pairings"."platform" is null or "device_pairings"."platform" in ('tvos', 'ipados', 'ios', 'web'));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_platform_valid" CHECK ("devices"."platform" is null or "devices"."platform" in ('tvos', 'ipados', 'ios', 'web'));