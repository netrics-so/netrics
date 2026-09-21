import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const schemaInfo = pgTable("schema_info", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
