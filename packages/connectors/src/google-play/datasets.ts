import { createHash } from "node:crypto";

import type {
  DatasetField,
  DatasetRecord,
  SourceDatasetDefinition,
} from "@netrics/connector-sdk";
import { z } from "zod";

import {
  REPORT_MAX_BYTES,
  reportCsv,
  reportDecimal,
  reportZip,
  reportZipStream,
  ReportFormatError,
  ReportTooLargeError,
  type ByteSink,
  type ReportSource,
} from "./tabular.js";

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
  // Version 2 adds the nullable `reason` (#611). Registered versions are
  // immutable: a changed definition always takes a new version.
  version: 2,
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
    // A safe code such as "missing_columns:Package Name" or "scope_mismatch"
    // for an invalid_report; never row data or object names.
    field("reason", "Why the report could not be read", "string", {
      nullable: true,
    }),
  ],
};

/**
 * How a delivered header is compared with a column the parser reads: case,
 * repeated or odd whitespace and compatibility forms are not significant.
 * Play Console has delivered both "Package Name" and "Package name" (#611).
 */
export function headerKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}
/**
 * The delivered header for each canonical column the parser reads. Records
 * keep the delivered names (provider_fields stay as delivered); the parser
 * looks values up through this map. A missing required column, or one that
 * two delivered headers would both match, makes the report invalid with a
 * reason naming only the canonical columns.
 */
export function resolveColumns<R extends string, O extends string = never>(
  headers: string[],
  required: readonly R[],
  optional: readonly O[] = [],
): Record<R, string> & Partial<Record<O, string>> {
  const delivered = new Map<string, string[]>();
  for (const header of headers) {
    const key = headerKey(header);
    delivered.set(key, [...(delivered.get(key) ?? []), header]);
  }
  const columns: Record<string, string> = {};
  const missing: string[] = [],
    ambiguous: string[] = [];
  for (const name of [...required, ...optional]) {
    const matches = delivered.get(headerKey(name)) ?? [];
    if (matches.length > 1) ambiguous.push(name);
    else if (matches.length === 1) columns[name] = matches[0]!;
    else if ((required as readonly string[]).includes(name)) missing.push(name);
  }
  if (missing.length)
    throw new ReportFormatError(
      `missing_columns:${missing.join(",")}`,
      "Google Play report is missing required columns",
    );
  if (ambiguous.length)
    throw new ReportFormatError(
      `ambiguous_columns:${ambiguous.join(",")}`,
      "Google Play report has ambiguous columns",
    );
  return columns as Record<R, string> & Partial<Record<O, string>>;
}
// Built once: a schema per parsed row was a large share of a report's
// garbage (#528).
const isoDate = z.iso.date();
function date(raw: string): string {
  const value = raw.trim();
  if (!isoDate.safeParse(value).success)
    throw new ReportFormatError(
      "invalid_value",
      "Google Play report has an invalid reporting date",
    );
  return value;
}
function integer(raw: string): string | null {
  if (!raw.trim()) return null;
  if (!/^\d+$/.test(raw.trim()))
    throw new ReportFormatError(
      "invalid_value",
      "Google Play install report has an invalid count",
    );
  return reportDecimal(raw);
}
/**
 * Row ids for one report file: sha256 of the row's columns as JSON
 * `[[name, value], ...]` sorted by name with localeCompare, plus an ordinal
 * among identical lines. Every row of a file has the same columns, so their
 * order and JSON prefixes are worked out once, from the first row (#528).
 */
function rowIdentities(): (original: Record<string, string>) => string {
  const duplicates = new Map<string, number>();
  let columns: Array<[name: string, prefix: string]> | undefined;
  return (original) => {
    columns ??= Object.keys(original)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => [name, "[" + JSON.stringify(name) + ","]);
    // The same bytes as JSON.stringify of the sorted [name, value] entries.
    let text = "[";
    for (let i = 0; i < columns.length; i++) {
      const [name, prefix] = columns[i]!;
      text += (i ? "," : "") + prefix + JSON.stringify(original[name]) + "]";
    }
    const hash = createHash("sha256")
      .update(text + "]")
      .digest("hex");
    // Ordinals only have to tell identical lines of one file apart, so they are
    // counted per 96-bit prefix: a third of the memory of the full hash per
    // line. Two different lines with the same prefix only get different
    // ordinals; their row_id still differs by the full hash.
    const prefix = hash.slice(0, 24);
    const ordinal = duplicates.get(prefix) ?? 0;
    duplicates.set(prefix, ordinal + 1);
    return `${hash}-${ordinal}`;
  };
}

/** Receives each typed row as it is parsed, with the app it belongs to. */
export type RowSink = (appId: string, row: DatasetRecord) => void;
/** Awaited between pieces of a report, so a consumer can write out what it holds. */
export type Drain = () => Promise<void>;

/** Columns an install report must have, by their canonical names. */
const INSTALL_COLUMNS = [
  "Date",
  "Package Name",
  "Country",
  "Daily User Installs",
  "Daily Device Installs",
] as const;
/** Columns an earnings report must have, by their canonical names. */
const EARNING_COLUMNS = [
  "Transaction Date",
  "Transaction Type",
  "Package ID",
  "Merchant Currency",
  "Amount (Merchant Currency)",
] as const;
const EARNING_OPTIONAL = ["Buyer Country"] as const;

/** Typed install rows from one country install report, pushed as bytes. */
function installSink(
  appId: string,
  reportMonth: string,
  name: string,
  generation: string,
  emit: RowSink,
): ByteSink {
  const rowIdentity = rowIdentities();
  let column: Record<(typeof INSTALL_COLUMNS)[number], string>;
  return reportCsv(
    (headers) => (column = resolveColumns(headers, INSTALL_COLUMNS)),
    (original) => {
      const day = date(original[column.Date]!);
      if (
        original[column["Package Name"]]!.trim() !== appId ||
        day.slice(0, 7) !== reportMonth.slice(0, 7)
      )
        throw new ReportFormatError(
          "scope_mismatch",
          "Google Play install report has a row outside its app/month scope",
        );
      emit(appId, {
        values: {
          app_id: appId,
          day,
          row_id: rowIdentity(original),
          country: original[column.Country]!.trim().toUpperCase(),
          daily_user_installs: integer(
            original[column["Daily User Installs"]]!,
          ),
          daily_device_installs: integer(
            original[column["Daily Device Installs"]]!,
          ),
          report_file: name,
          object_generation: generation,
          provider_fields: original,
        },
      });
    },
  );
}

export function installRows(
  bytes: Uint8Array,
  appId: string,
  reportMonth: string,
  name: string,
  generation: string,
): DatasetRecord[] {
  const rows: DatasetRecord[] = [];
  const sink = installSink(appId, reportMonth, name, generation, (_, row) =>
    rows.push(row),
  );
  sink.push(bytes);
  sink.end();
  return rows;
}

/**
 * installRows over a ranged source: bytes are decoded and parsed piece by
 * piece, so only the typed rows are retained.
 */
export async function streamInstallRows(
  source: ReportSource,
  appId: string,
  reportMonth: string,
  name: string,
  generation: string,
): Promise<DatasetRecord[]> {
  const rows: DatasetRecord[] = [];
  await readInstallReport(
    source,
    appId,
    reportMonth,
    name,
    generation,
    (_, row) => rows.push(row),
  );
  return rows;
}

/**
 * Parses an install report piece by piece, handing each typed row to `emit`
 * and awaiting `drain` after every piece; nothing is retained here.
 */
export async function readInstallReport(
  source: ReportSource,
  appId: string,
  reportMonth: string,
  name: string,
  generation: string,
  emit: RowSink,
  drain?: Drain,
): Promise<void> {
  reportSize(source);
  const sink = installSink(appId, reportMonth, name, generation, emit);
  // Even an empty object is requested, so access and generation still verify.
  let at = 0;
  do {
    const length = Math.min(REPORT_READ_BYTES, source.size - at);
    sink.push(await source.read(at, length));
    at += length;
    await drain?.();
  } while (at < source.size);
  sink.end();
  await drain?.();
}

/** Largest piece of a plain report pushed through the parser at once. */
export const REPORT_READ_BYTES = 1024 * 1024;
export { ReportTooLargeError };
/** Refuse an oversized object before any of its body is transferred. */
function reportSize(source: ReportSource): void {
  if (source.size > REPORT_MAX_BYTES) throw new ReportTooLargeError();
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
  if (isoDate.safeParse(raw.trim()).success) return raw.trim();
  const invalid = () =>
    new ReportFormatError(
      "invalid_value",
      "Google Play earnings report has an invalid transaction date",
    );
  const match = /^([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})$/.exec(raw.trim());
  if (!match) throw invalid();
  const month = MONTHS.indexOf(match[1]!);
  if (month < 0) throw invalid();
  return date(
    `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`,
  );
}

interface EarningsRows {
  records: Map<string, DatasetRecord[]>;
  unmapped: number;
}
/** One earnings archive member's CSV, typed into `emit` as it is parsed. */
function earningsSink(
  result: { unmapped: number },
  reportMonth: string,
  file: string,
  generation: string,
  selected: Set<string> | undefined,
  emit: RowSink,
): ByteSink {
  const rowIdentity = rowIdentities();
  let column: ReturnType<
    typeof resolveColumns<
      (typeof EARNING_COLUMNS)[number],
      (typeof EARNING_OPTIONAL)[number]
    >
  >;
  return reportCsv(
    (headers) =>
      (column = resolveColumns(headers, EARNING_COLUMNS, EARNING_OPTIONAL)),
    (original) => {
      const appId = original[column["Package ID"]]!.trim() || "__unmapped";
      if (appId === "__unmapped") result.unmapped++;
      if (selected && !selected.has(appId)) return;
      const currency =
        original[column["Merchant Currency"]]!.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency))
        throw new ReportFormatError(
          "invalid_value",
          "Google Play earnings report has an invalid merchant currency",
        );
      const buyerCountry = column["Buyer Country"];
      const row = {
        values: {
          app_id: appId,
          report_month: date(reportMonth),
          transaction_day: transactionDay(
            original[column["Transaction Date"]]!,
          ),
          row_id: rowIdentity(original),
          transaction_type: original[column["Transaction Type"]]!,
          country: (buyerCountry === undefined ? "" : original[buyerCountry]!)
            .trim()
            .toUpperCase(),
          merchant_amount: reportDecimal(
            original[column["Amount (Merchant Currency)"]]!,
          ),
          currency,
          report_file: file,
          object_generation: generation,
          provider_fields: original,
        },
      };
      emit(appId, row);
    },
  );
}
function collect(records: Map<string, DatasetRecord[]>): RowSink {
  return (appId, row) => {
    const list = records.get(appId);
    if (list) list.push(row);
    else records.set(appId, [row]);
  };
}

export function earningsRows(
  bytes: Uint8Array,
  reportMonth: string,
  name: string,
  generation: string,
  selected?: Set<string>,
): EarningsRows {
  const result: EarningsRows = { records: new Map(), unmapped: 0 };
  for (const file of reportZip(bytes)) {
    const sink = earningsSink(
      result,
      reportMonth,
      `${name}/${file.name}`,
      generation,
      selected,
      collect(result.records),
    );
    sink.push(file.bytes);
    sink.end();
  }
  return result;
}

/**
 * earningsRows over a ranged source: members are inflated, decoded and parsed
 * incrementally, and rows outside `selected` are never retained. All archive
 * checks still apply; a failure discards every row read so far.
 */
export async function streamEarningsRows(
  source: ReportSource,
  reportMonth: string,
  name: string,
  generation: string,
  selected?: Set<string>,
): Promise<EarningsRows> {
  const records = new Map<string, DatasetRecord[]>();
  const { unmapped } = await readEarningsReport(
    source,
    reportMonth,
    name,
    generation,
    selected,
    collect(records),
  );
  return { records, unmapped };
}

/**
 * Parses an earnings archive piece by piece, handing each typed row to `emit`
 * and awaiting `drain` after every inflated piece; nothing is retained here.
 * Rows reach `emit` before the archive's final checks: a failure means every
 * row emitted so far must be discarded.
 */
export async function readEarningsReport(
  source: ReportSource,
  reportMonth: string,
  name: string,
  generation: string,
  selected: Set<string> | undefined,
  emit: RowSink,
  drain?: Drain,
): Promise<{ unmapped: number }> {
  reportSize(source);
  const result = { unmapped: 0 };
  await reportZipStream(
    source,
    (member) =>
      earningsSink(
        result,
        reportMonth,
        `${name}/${member}`,
        generation,
        selected,
        emit,
      ),
    { drain },
  );
  await drain?.();
  return result;
}
