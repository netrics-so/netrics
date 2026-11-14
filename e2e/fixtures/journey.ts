import type { DataField } from "@netrics/domain";

/**
 * Deterministic data for the 11C journey (#570). Two sales tables with the
 * same columns, one zero-revenue row each, and an app mapping table that
 * the customer pastes into the reference editor.
 *
 * After appending (8 rows) and dropping zero revenue (6 rows), German
 * revenue is 150.00 of 300.00, so the German share is 0.50.
 */
export const salesFields: DataField[] = [
  { id: "day", name: "Day", type: "date", nullable: false },
  { id: "app", name: "App", type: "string", nullable: false },
  { id: "country", name: "Country", type: "string", nullable: false },
  { id: "revenue", name: "Revenue", type: "decimal", nullable: false },
];

/** Rows are unique by day, app and country. */
export const salesKeyFields = ["day", "app", "country"];

export const salesEu = {
  name: "Sales EU",
  key: "sales_eu",
  fields: salesFields,
  keyFields: salesKeyFields,
  rows: [
    { day: "2026-01-05", app: "app-1", country: "DE", revenue: "100.00" },
    { day: "2026-01-06", app: "app-2", country: "AT", revenue: "30.00" },
    { day: "2026-01-07", app: "app-1", country: "DE", revenue: "0.00" },
    { day: "2026-01-08", app: "app-2", country: "DE", revenue: "50.00" },
  ],
};

export const salesUs = {
  name: "Sales US",
  key: "sales_us",
  fields: salesFields,
  keyFields: salesKeyFields,
  rows: [
    { day: "2026-01-05", app: "app-1", country: "US", revenue: "40.00" },
    { day: "2026-01-06", app: "app-2", country: "US", revenue: "30.00" },
    { day: "2026-01-07", app: "app-1", country: "US", revenue: "0.00" },
    { day: "2026-01-08", app: "app-2", country: "US", revenue: "50.00" },
  ],
};

/** The entity mapping, as pasted into the reference editor (TSV). */
export const apps = {
  name: "Apps",
  tsv: "id\tProduct\napp-1\tPuzzle Quest\napp-2\tRoad Racer\n",
  products: ["Puzzle Quest", "Road Racer"],
};

export const expected = {
  appendedRows: 8,
  filteredRows: 6,
  germanRows: 3,
  germanyFormula: 'EQ([Country], "DE")',
  germanShare: "0.5",
  germanShareFormula: "ROUND(DIVIDE([German revenue], [Revenue]), 2)",
};
