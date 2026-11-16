-- Product settings of store-template installs (#708): paid or free and
-- the linked website. A new table only; existing installs have no rows and
-- read as the defaults (pricing auto, no website). The website foreign key
-- is hand-edited: deleting a connection clears only the website
-- connection (Postgres 15+ column list), never workspace_id or the row;
-- a project id left without its connection reads as no website.
CREATE TABLE "data_template_products" (
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"pricing" text DEFAULT 'auto' NOT NULL,
	"website_connection_id" uuid,
	"website_resource_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_template_products_workspace_id_request_id_product_id_pk" PRIMARY KEY("workspace_id","request_id","product_id"),
	CONSTRAINT "data_template_products_pricing_valid" CHECK ("data_template_products"."pricing" in ('auto','paid','free')),
	CONSTRAINT "data_template_products_website_pair" CHECK ("data_template_products"."website_connection_id" is null or "data_template_products"."website_resource_id" is not null),
	CONSTRAINT "data_template_products_ids_length" CHECK (length("data_template_products"."product_id") between 1 and 65600 and ("data_template_products"."website_resource_id" is null or length("data_template_products"."website_resource_id") between 1 and 1024))
);
--> statement-breakpoint
ALTER TABLE "data_template_products" ADD CONSTRAINT "data_template_products_install_fk" FOREIGN KEY ("workspace_id","request_id") REFERENCES "public"."data_template_installs"("workspace_id","request_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_template_products" ADD CONSTRAINT "data_template_products_website_fk" FOREIGN KEY ("website_connection_id","workspace_id") REFERENCES "public"."connections"("id","workspace_id") ON DELETE SET NULL ("website_connection_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_template_products_website_idx" ON "data_template_products" USING btree ("website_connection_id") WHERE "data_template_products"."website_connection_id" is not null;--> statement-breakpoint
ALTER TABLE data_template_products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE data_template_products FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY data_template_products_tenant ON data_template_products
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON data_template_products TO netrics_app;
