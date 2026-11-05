import { createHash } from "node:crypto";

import type {
  DatasetField,
  DatasetRecord,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";
import { z } from "zod";

import { csvTable, reportDecimal, reportText, reportZip } from "./tabular.js";

function field(
  id: string,
  name: string,
  type: DatasetField["type"],
  extra: Partial<DatasetField> = {},
): DatasetField {
  return {
    id,
    name,
    type,
    nullable: false,
    classification: "internal",
    ...extra,
  };
}
export const installDataset: SourceDatasetDefinition = {
  key: "install_rows",
  name: "Google Play install report rows",
  version: 1,
  mode: "replace_window",
  keyFields: ["app_id", "day", "row_id"],
  reportingField: "day",
  reportingTimeZone: "America/Los_Angeles",
  grain: "One original country install report row per app and reporting day",
  retentionDays: null,
  fields: [
    field("app_id", "Android package name", "string"),
    field("day", "Reporting day (Pacific)", "date"),
    field("row_id", "Report row identity", "string"),
    field("country", "Country", "string"),
    field("daily_user_installs", "Daily user installs", "decimal", {
      nullable: true,
      scale: 0,
      unit: "installs",
    }),
    field("daily_device_installs", "Daily device installs", "decimal", {
      nullable: true,
      scale: 0,
      unit: "installs",
    }),
    field("report_file", "Report object", "string"),
    field("object_generation", "Object generation", "string"),
    field("provider_fields", "Original provider columns", "json"),
  ],
};
export const earningsDataset: SourceDatasetDefinition = {
  key: "earning_rows",
  name: "Google Play earnings report rows",
  version: 1,
  mode: "replace_window",
  keyFields: ["app_id", "report_month", "report_file", "row_id"],
  reportingField: "report_month",
  reportingTimeZone: "America/Los_Angeles",
  grain:
    "One original earnings line, including fees/refunds/adjustments; replacement is by report month, not transaction day",
  retentionDays: null,
  fields: [
    field("app_id", "Android package name", "string"),
    field("report_month", "Report month", "date"),
    field("transaction_day", "Provider transaction date (Pacific)", "date"),
    field("row_id", "Report row identity", "string"),
    field("transaction_type", "Transaction type", "string"),
    field("country", "Buyer country", "string"),
    field("merchant_amount", "Amount in merchant currency", "decimal", {
      unit: "currency",
      currencyField: "currency",
    }),
    field("currency", "Merchant currency", "string"),
    field("report_file", "Report object and member", "string"),
    field("object_generation", "Object generation", "string"),
    field("provider_fields", "Original provider columns", "json", {
      classification: "personal",
      retentionDays: null,
    }),
  ],
};
export const listingRatingDataset: SourceDatasetDefinition = {
  key: "store_ratings",
  name: "Google Play listing rating snapshots",
  version: 1,
  mode: "upsert",
  keyFields: ["app_id", "storefront", "locale", "form_factor", "day"],
  reportingField: "day",
  reportingTimeZone: "UTC",
  grain:
    "One public listing snapshot per app, country, language, default form factor and UTC collection day",
  retentionDays: null,
  fields: [
    field("app_id", "Android package name", "string", {
      classification: "public",
    }),
    field("app_name", "App name", "string", {
      nullable: true,
      classification: "public",
    }),
    field("storefront", "Listing country", "string", {
      classification: "public",
    }),
    field("locale", "Listing language", "string", { classification: "public" }),
    field("form_factor", "Form factor", "string", { classification: "public" }),
    field("day", "Collection day (UTC)", "date", { classification: "public" }),
    field("captured_at", "Collected at", "timestamp", {
      classification: "public",
    }),
    field("rating", "Public listing rating", "decimal", {
      unit: "stars",
      nullable: true,
      classification: "public",
    }),
    field("rating_count", "Public listing rating count", "integer", {
      nullable: true,
      classification: "public",
    }),
    field("availability", "Rating availability", "string", {
      classification: "public",
    }),
    field("provider_fields", "Original aggregate rating", "json", {
      nullable: true,
      classification: "public",
    }),
  ],
};
export const reportStatusDataset: SourceDatasetDefinition = {
  key: "report_status",
  name: "Google Play report availability",
  version: 1,
  mode: "upsert",
  keyFields: ["app_id", "report_type", "report_month"],
  reportingField: "report_month",
  reportingTimeZone: "America/Los_Angeles",
  grain: "Latest report availability per app, report type and report month",
  retentionDays: null,
  fields: [
    field("app_id", "Android package name", "string"),
    field("report_type", "Report type", "string"),
    field("report_month", "Report month", "date"),
    field("availability", "Availability", "string"),
    field("captured_at", "Checked at", "timestamp"),
    field("provider_updated_at", "Provider object updated at", "timestamp", {
      nullable: true,
    }),
    field("object_names", "Report objects", "json"),
    field("unmapped_rows", "Unmapped account rows", "integer"),
  ],
};

function requiredColumns(headers: string[], columns: string[]): void {
  if (columns.some((name) => !headers.includes(name)))
    throw new Error("Google Play report is missing required columns");
}
function date(raw: string): string {
  const value = raw.trim();
  if (!z.iso.date().safeParse(value).success)
    throw new Error("Google Play report has an invalid reporting date");
  return value;
}
function integer(raw: string): string | null {
  if (!raw.trim()) return null;
  if (!/^\d+$/.test(raw.trim()))
    throw new Error("Google Play install report has an invalid count");
  return reportDecimal(raw);
}
function rowIdentity(
  original: Record<string, string>,
  duplicates: Map<string, number>,
): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(original).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex");
  const ordinal = duplicates.get(hash) ?? 0;
  duplicates.set(hash, ordinal + 1);
  return `${hash}-${ordinal}`;
}

export function installRows(
  bytes: Uint8Array,
  appId: string,
  reportMonth: string,
  name: string,
  generation: string,
): DatasetRecord[] {
  const { headers, records: rows } = csvTable(reportText(bytes));
  requiredColumns(headers, [
    "Date",
    "Package Name",
    "Country",
    "Daily User Installs",
    "Daily Device Installs",
  ]);
  const duplicates = new Map<string, number>();
  return rows.map((original) => {
    const day = date(original.Date!);
    if (
      original["Package Name"]?.trim() !== appId ||
      day.slice(0, 7) !== reportMonth.slice(0, 7)
    )
      throw new Error(
        "Google Play install report has a row outside its app/month scope",
      );
    return {
      values: {
        app_id: appId,
        day,
        row_id: rowIdentity(original, duplicates),
        country: original.Country!.trim().toUpperCase(),
        daily_user_installs: integer(original["Daily User Installs"]!),
        daily_device_installs: integer(original["Daily Device Installs"]!),
        report_file: name,
        object_generation: generation,
        provider_fields: original,
      },
    };
  });
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function transactionDay(raw: string): string {
  if (z.iso.date().safeParse(raw.trim()).success) return raw.trim();
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})$/.exec(raw.trim());
  if (!match)
    throw new Error(
      "Google Play earnings report has an invalid transaction date",
    );
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0)
    throw new Error(
      "Google Play earnings report has an invalid transaction date",
    );
  return date(
    `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`,
  );
}

export function earningsRows(
  bytes: Uint8Array,
  reportMonth: string,
  name: string,
  generation: string,
  selected?: Set<string>,
): { records: Map<string, DatasetRecord[]>; unmapped: number } {
  const records = new Map<string, DatasetRecord[]>();
  let unmapped = 0;
  for (const file of reportZip(bytes)) {
    const { headers, records: rows } = csvTable(reportText(file.bytes));
    requiredColumns(headers, [
      "Transaction Date",
      "Transaction Type",
      "Package ID",
      "Merchant Currency",
      "Amount (Merchant Currency)",
    ]);
    const duplicates = new Map<string, number>();
    for (const original of rows) {
      const appId = original["Package ID"]!.trim() || "__unmapped";
      if (appId === "__unmapped") unmapped++;
      if (selected && !selected.has(appId)) continue;
      const currency = original["Merchant Currency"]!.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency))
        throw new Error(
          "Google Play earnings report has an invalid merchant currency",
        );
      const row = {
        values: {
          app_id: appId,
          report_month: date(reportMonth),
          transaction_day: transactionDay(original["Transaction Date"]!),
          row_id: rowIdentity(original, duplicates),
          transaction_type: original["Transaction Type"]!,
          country: (original["Buyer Country"] ?? "").trim().toUpperCase(),
          merchant_amount: reportDecimal(
            original["Amount (Merchant Currency)"]!,
          ),
          currency,
          report_file: `${name}/${file.name}`,
          object_generation: generation,
          provider_fields: original,
        },
      };
      const list = records.get(appId) ?? [];
      list.push(row);
      records.set(appId, list);
    }
  }
  return { records, unmapped };
}
