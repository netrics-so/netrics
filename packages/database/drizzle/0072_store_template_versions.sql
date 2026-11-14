CREATE TABLE "data_template_records" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"record_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"original" jsonb,
	"widget_keys" jsonb,
	"detached_at" timestamp with time zone,
	CONSTRAINT "data_template_records_workspace_id_request_id_key_pk" PRIMARY KEY("workspace_id","request_id","key"),
	CONSTRAINT "data_template_records_kind_valid" CHECK ("data_template_records"."kind" in ('preparation','model','dashboard','dataset')),
	CONSTRAINT "data_template_records_original" CHECK (("data_template_records"."kind" = 'dataset') = ("data_template_records"."original" is null))
);
--> statement-breakpoint
CREATE TABLE "data_template_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"decisions" jsonb NOT NULL,
	"drafts" jsonb NOT NULL,
	"dashboards" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "data_template_updates_versions" CHECK ("data_template_updates"."from_version" > 0 and "data_template_updates"."to_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "data_template_installs" ADD COLUMN "template_id" text DEFAULT 'store_portfolio' NOT NULL;--> statement-breakpoint
ALTER TABLE "data_template_installs" ADD COLUMN "template_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "data_template_installs" ADD COLUMN "inputs" jsonb;--> statement-breakpoint
ALTER TABLE "data_template_installs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "data_template_records" ADD CONSTRAINT "data_template_records_install_fk" FOREIGN KEY ("workspace_id","request_id") REFERENCES "public"."data_template_installs"("workspace_id","request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_template_updates" ADD CONSTRAINT "data_template_updates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_template_updates" ADD CONSTRAINT "data_template_updates_install_fk" FOREIGN KEY ("workspace_id","request_id") REFERENCES "public"."data_template_installs"("workspace_id","request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_template_records_record_idx" ON "data_template_records" USING btree ("workspace_id","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_template_updates_one_open" ON "data_template_updates" USING btree ("workspace_id","request_id") WHERE "data_template_updates"."closed_at" is null;--> statement-breakpoint
ALTER TABLE "data_template_installs" ADD CONSTRAINT "data_template_installs_version_positive" CHECK ("data_template_installs"."template_version" > 0);--> statement-breakpoint
ALTER TABLE data_template_records ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_template_records FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_template_records_tenant ON data_template_records
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE data_template_updates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_template_updates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_template_updates_tenant ON data_template_updates
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON data_template_records, data_template_updates TO netrics_app;
--> statement-breakpoint
-- Completing a baseline install and recording a new version update the row.
GRANT UPDATE ON data_template_installs TO netrics_app;
--> statement-breakpoint
-- Baseline for installs made before template versions (11E, builder-check
-- call): every existing install is version 1 (the only version that ever
-- existed); the original of each preparation and model is its first
-- published version / release (the install published those at creation); a
-- dashboard's original is its content now, so it reads as unchanged by the
-- customer. Preparations keep `legacy:<id>` keys until the server completes
-- the install (store-template-legacy.ts), which also derives the inputs.
-- The backfill reads and writes every workspace. The migration role is the
-- superuser/BYPASSRLS owner (see 0006); with row_security off, any other
-- role fails here instead of silently seeing no rows.
SET LOCAL row_security = off;
--> statement-breakpoint
INSERT INTO "data_template_records" ("workspace_id", "request_id", "key", "kind", "record_id", "template_version", "original")
SELECT i."workspace_id", i."request_id", 'legacy:' || p."id", 'preparation', p."id", 1,
       jsonb_build_object('graph', v."graph")
FROM "data_template_installs" i
CROSS JOIN LATERAL jsonb_array_elements_text(i."result" -> 'preparationIds') AS e("id")
JOIN "data_preparations" p
  ON p."id" = e."id"::uuid AND p."workspace_id" = i."workspace_id"
CROSS JOIN LATERAL (
  SELECT pv."graph" FROM "data_preparation_versions" pv
  WHERE pv."preparation_id" = p."id" AND pv."workspace_id" = p."workspace_id"
  ORDER BY pv."version" LIMIT 1
) v;
--> statement-breakpoint
INSERT INTO "data_template_records" ("workspace_id", "request_id", "key", "kind", "record_id", "template_version", "original")
SELECT i."workspace_id", i."request_id", 'model:' || m."metric", 'model', dm."id", 1,
       jsonb_build_object('definition', r."definition")
FROM "data_template_installs" i
CROSS JOIN LATERAL jsonb_each_text(i."result" -> 'models') AS m("metric", "id")
JOIN "data_models" dm
  ON dm."id" = m."id"::uuid AND dm."workspace_id" = i."workspace_id"
CROSS JOIN LATERAL (
  SELECT mr."definition" FROM "data_model_releases" mr
  WHERE mr."model_id" = dm."id" AND mr."workspace_id" = dm."workspace_id"
  ORDER BY mr."version" LIMIT 1
) r;
--> statement-breakpoint
-- The dashboard as it is now, slides by position with their widgets as rows;
-- widget keys are assigned when the install is completed. Rows go through
-- to_jsonb(alias.*): a bare alias would resolve to a column of that name
-- first (dashboard_widgets has a column "w").
INSERT INTO "data_template_records" ("workspace_id", "request_id", "key", "kind", "record_id", "template_version", "original")
SELECT i."workspace_id", i."request_id", 'dashboard:portfolio', 'dashboard', d."id", 1,
       jsonb_build_object('legacySnapshot', jsonb_build_object(
         'dashboard', to_jsonb(d.*),
         'slides', coalesce((
           SELECT jsonb_agg(to_jsonb(s.*) || jsonb_build_object('widgets', coalesce((
             SELECT jsonb_agg(to_jsonb(wd.*) ORDER BY wd."y", wd."x", wd."id")
             FROM "dashboard_widgets" wd
             WHERE wd."slide_id" = s."id" AND wd."workspace_id" = s."workspace_id"
           ), '[]'::jsonb)) ORDER BY s."position")
           FROM "dashboard_slides" s
           WHERE s."dashboard_id" = d."id" AND s."workspace_id" = d."workspace_id"
         ), '[]'::jsonb)
       ))
FROM "data_template_installs" i
JOIN "dashboards" d
  ON d."id" = (i."result" ->> 'dashboardId')::uuid AND d."workspace_id" = i."workspace_id";
--> statement-breakpoint
INSERT INTO "data_template_records" ("workspace_id", "request_id", "key", "kind", "record_id", "template_version", "original")
SELECT i."workspace_id", i."request_id", k."key", 'dataset', (i."result" ->> k."field")::uuid, 1, NULL
FROM "data_template_installs" i
CROSS JOIN (VALUES ('dataset:mapping', 'mappingDatasetId'), ('dataset:products', 'productDatasetId')) AS k("key", "field")
WHERE i."result" ->> k."field" IS NOT NULL;
--> statement-breakpoint
-- Every model that still exists got its baseline.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "data_template_installs" i
    CROSS JOIN LATERAL jsonb_each_text(i."result" -> 'models') AS m("metric", "id")
    JOIN "data_models" dm
      ON dm."id" = m."id"::uuid AND dm."workspace_id" = i."workspace_id"
    WHERE NOT EXISTS (
      SELECT 1 FROM "data_template_records" r
      WHERE r."workspace_id" = i."workspace_id" AND r."request_id" = i."request_id"
        AND r."key" = 'model:' || m."metric"
    )
  ) THEN
    RAISE EXCEPTION 'store template versions migration: an installed model has no baseline';
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL row_security = on;
