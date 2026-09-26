import { defineConfig } from "drizzle-kit";

// Migrations run as the owner role (the migration creates the netrics_app /
// netrics_scheduler roles and owns the tables); the app connects via
// DATABASE_URL as netrics_app instead.
const url =
  process.env.DATABASE_MIGRATION_URL ??
  "postgres://netrics:netrics@localhost:5433/netrics";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/schema.ts", "./src/auth-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url },
});
