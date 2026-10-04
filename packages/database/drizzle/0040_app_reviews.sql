-- #334 (ADR 0019 §11, amending ADR 0014 decision 2): recent App Store
-- customer reviews with their title, body and reviewer nickname, for the
-- latest-review widget. The nickname is personal data and the text user
-- content, so the table is typed and bounded: lengths are capped here,
-- RLS scopes it to the tenant context like every other workspace table,
-- the rows go with their connection (and so with the workspace), and the
-- hourly maintenance keeps the newest 50 per app and none older than 90
-- days (prune_app_reviews below). A new, empty table: existing data is
-- untouched.
CREATE TABLE "app_reviews" (
	"connection_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_review_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"rating" smallint NOT NULL,
	"title" text,
	"body" text,
	"author" text,
	"territory" text,
	"created_at" timestamp with time zone NOT NULL,
	"hidden_at" timestamp with time zone,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_reviews_connection_id_provider_review_id_pk" PRIMARY KEY("connection_id","provider_review_id"),
	CONSTRAINT "app_reviews_rating" CHECK ("app_reviews"."rating" between 1 and 5),
	CONSTRAINT "app_reviews_title_length" CHECK (char_length("app_reviews"."title") <= 300),
	CONSTRAINT "app_reviews_body_length" CHECK (char_length("app_reviews"."body") <= 4000),
	CONSTRAINT "app_reviews_author_length" CHECK (char_length("app_reviews"."author") <= 100),
	CONSTRAINT "app_reviews_territory" CHECK ("app_reviews"."territory" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
ALTER TABLE "app_reviews" ADD CONSTRAINT "app_reviews_connection_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_reviews_workspace_idx" ON "app_reviews" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "app_reviews_resource_created_idx" ON "app_reviews" USING btree ("connection_id","resource_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "app_reviews_created_at_idx" ON "app_reviews" USING btree ("created_at");
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "app_reviews" TO netrics_app;
--> statement-breakpoint
ALTER TABLE "app_reviews" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app_reviews" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "app_reviews_select" ON "app_reviews" FOR SELECT
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "app_reviews_insert" ON "app_reviews" FOR INSERT
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "app_reviews_update" ON "app_reviews" FOR UPDATE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY "app_reviews_delete" ON "app_reviews" FOR DELETE
  USING ("workspace_id" = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Retention, run by the scheduler's hourly maintenance with the constants
-- in packages/database/src/app-reviews.ts (APP_REVIEW_RETENTION).
-- netrics_scheduler has no grant on the table, so this runs as the owner,
-- like prune_security_records (migration 0029). Per connection and app it
-- keeps the newest p_keep reviews (by creation time, then provider id) and
-- deletes every review created before p_now - p_max_age. Each statement
-- touches at most p_batch rows per call; the next hourly run continues.
CREATE FUNCTION prune_app_reviews(
  p_now timestamptz,
  p_max_age interval,
  p_keep integer,
  p_batch integer
)
RETURNS TABLE (
  expired_deleted integer,
  surplus_deleted integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM app_reviews
  WHERE (connection_id, provider_review_id) IN (
    SELECT r.connection_id, r.provider_review_id FROM app_reviews r
    WHERE r.created_at < p_now - p_max_age
    LIMIT p_batch
  );
  GET DIAGNOSTICS expired_deleted = ROW_COUNT;

  DELETE FROM app_reviews
  WHERE (connection_id, provider_review_id) IN (
    SELECT ranked.connection_id, ranked.provider_review_id
    FROM (
      SELECT r.connection_id, r.provider_review_id,
        row_number() OVER (
          PARTITION BY r.connection_id, r.resource_id
          ORDER BY r.created_at DESC, r.provider_review_id ASC
        ) AS position
      FROM app_reviews r
    ) ranked
    WHERE ranked.position > p_keep
    LIMIT p_batch
  );
  GET DIAGNOSTICS surplus_deleted = ROW_COUNT;

  RETURN NEXT;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION prune_app_reviews(timestamptz, interval, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION prune_app_reviews(timestamptz, interval, integer, integer) TO netrics_scheduler;
