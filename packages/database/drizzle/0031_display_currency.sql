-- #191: display currency. ECB euro reference rates as installation-level
-- reference data (no tenant rows, so no RLS, like the connector catalog):
-- netrics_app may only read them, and only the scheduler's rate job
-- (netrics_scheduler) writes them. Workspaces and tiles get an optional
-- display currency; null keeps today's behaviour (amounts per currency,
-- exact), so existing rows are untouched.
CREATE TABLE "exchange_rates" (
	"rate_date" date NOT NULL,
	"currency" text NOT NULL,
	"units_per_eur" numeric NOT NULL,
	"source" text DEFAULT 'ecb' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_pk" PRIMARY KEY("source","rate_date","currency"),
	CONSTRAINT "exchange_rates_currency_valid" CHECK ("exchange_rates"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "exchange_rates_rate_positive" CHECK ("exchange_rates"."units_per_eur" > 0)
);
--> statement-breakpoint
ALTER TABLE "dashboard_tiles" ADD COLUMN "display_currency" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "display_currency" text;
--> statement-breakpoint
-- Default privileges (0001) gave netrics_app full DML on the new table.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "exchange_rates" FROM netrics_app;
--> statement-breakpoint
GRANT SELECT ON "exchange_rates" TO netrics_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "exchange_rates" TO netrics_scheduler;
