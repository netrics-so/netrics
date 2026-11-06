-- #250 (ADR 0016): the user's language and the workspace's screen
-- language. Both nullable without default: existing rows keep today's
-- behaviour (follow the instance default, else English), and adding the
-- columns is instant. The checks only guard the shape (a primary language
-- subtag); the API validates against the supported languages.
ALTER TABLE "users" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "screen_locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_format" CHECK ("users"."locale" is null or "users"."locale" ~ '^[a-z]{2,3}$');--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_screen_locale_format" CHECK ("workspaces"."screen_locale" is null or "workspaces"."screen_locale" ~ '^[a-z]{2,3}$');