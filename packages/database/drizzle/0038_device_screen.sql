-- #276 (ADR 0017 section 7): per-device rotation and display mode, and the
-- screen the device last reported. Defaults keep every paired device as it
-- is today (unrotated, screen view); constant defaults make the new NOT
-- NULL columns instant on existing rows, and the screen stays null until
-- the device reports one.
ALTER TABLE "devices" ADD COLUMN "rotation" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "display_mode" text DEFAULT 'screen' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "screen" jsonb;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_rotation_valid" CHECK ("devices"."rotation" in (0, 90, 180, 270));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_display_mode_valid" CHECK ("devices"."display_mode" in ('screen', 'scroll'));--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_screen_object" CHECK ("devices"."screen" is null or jsonb_typeof("devices"."screen") = 'object');