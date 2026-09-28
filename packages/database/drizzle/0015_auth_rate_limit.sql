CREATE TABLE "auth"."rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_last_request_idx" ON "auth"."rate_limit" USING btree ("last_request");--> statement-breakpoint
-- The API (netrics_app) reads and writes the counters. Default privileges from
-- 0002 cover new auth tables too; granting explicitly keeps this migration
-- correct when it runs as a different owner role.
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth"."rate_limit" TO netrics_app;
