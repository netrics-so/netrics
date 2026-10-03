import { gunzipSync } from "node:zlib";

// The daily SALES/SUMMARY report (ADR 0014, "Sales and Trends"): one gzip
// file of tab-separated rows per vendor number and Pacific-Time reporting
// day, covering every app of the vendor
// (https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports,
// https://developer.apple.com/help/app-store-connect/reference/reporting/summary-sales-report).

/**
 * The report version the sync asks for. Apple's API reference lists `1_0`
 * as the only version of SALES/SUMMARY ("Allowed values based on sales
 * report type", get-v1-salesreports); the reporting help documents the
 * columns as "Summary Sales Report Version 1_3". A forum thread from January
 * 2024 (https://developer.apple.com/forums/thread/745052) saw a short-lived
 * "latest version for this report is 1_1" error that Apple fixed, after
 * which `1_0` downloaded every day again. Columns are matched by name, so a
 * version with more columns parses the same. The exit gate (#176) confirms
 * the version against a real account.
 */
export const SALES_REPORT_VERSION = "1_0";

/**
 * Inflated size bound of one daily report. The runtime caps the compressed
 * body (10 MiB); this caps what it inflates to, so a gzip bomb fails the
 * call as a provider error (ADR 0014, docs/architecture.md).
 */
export const MAX_REPORT_BYTES = 64 * 1024 * 1024;

export function inflateReport(
  bytes: Uint8Array,
  maxBytes = MAX_REPORT_BYTES,
): string {
  try {
    return gunzipSync(bytes, { maxOutputLength: maxBytes }).toString("utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(
        `App Store sales report exceeds ${maxBytes} bytes when inflated`,
        { cause: error },
      );
    }
    throw new Error("App Store sales report is not a readable gzip file", {
      cause: error,
    });
  }
}

// ─── Product types ──────────────────────────────────────────────────────────

export type ProductCategory =
  "download" | "redownload" | "update" | "iap" | "restore";

/**
 * Product type identifiers per ADR 0014, from Apple's "Product type
 * identifiers" reference
 * (https://developer.apple.com/help/app-store-connect/reference/reporting/product-type-identifiers):
 *
 * - first downloads: free or paid apps (`1` iOS/iPadOS/visionOS/watchOS,
 *   `1F` universal, `1T` iPad, `F1` Mac), app bundles (`1-B`, `F1-B`) and
 *   custom apps (`1E`, `1EP`, `1EU`);
 * - redownloads: `3`, `3F`;
 * - updates: `7`, `7F`, `7T`, `F7`;
 * - in-app purchases: `IA1`, `IA1-M`, `FI1` (Mac), non-renewing
 *   subscriptions `IA9`, `IA9-M`, auto-renewable subscriptions `IAY`,
 *   `IAY-M`;
 * - restored in-app purchases (`IA3`) are known, but counted in no metric.
 *
 * Any other identifier is unknown: counted in no metric and logged by code.
 */
export const PRODUCT_TYPES: Readonly<Record<string, ProductCategory>> = {
  "1": "download",
  "1-B": "download",
  "F1-B": "download",
  "1E": "download",
  "1EP": "download",
  "1EU": "download",
  "1F": "download",
  "1T": "download",
  F1: "download",
  "3": "redownload",
  "3F": "redownload",
  "7": "update",
  "7F": "update",
  "7T": "update",
  F7: "update",
  IA1: "iap",
  "IA1-M": "iap",
  FI1: "iap",
  IA9: "iap",
  "IA9-M": "iap",
  IAY: "iap",
  "IAY-M": "iap",
  IA3: "restore",
};

export function productCategory(code: string): ProductCategory | undefined {
  return Object.hasOwn(PRODUCT_TYPES, code) ? PRODUCT_TYPES[code] : undefined;
}

// ─── Columns ────────────────────────────────────────────────────────────────

/**
 * The columns the sync reads, by header name. Each lists the names Apple
 * uses for it: the files say "Developer Proceeds", the reporting help
 * "Developer Proceeds (per unit)".
 */
const COLUMNS = {
  sku: ["SKU"],
  productType: ["Product Type Identifier"],
  units: ["Units"],
  proceeds: ["Developer Proceeds", "Developer Proceeds (per unit)"],
  countryCode: ["Country Code"],
  currency: ["Currency of Proceeds"],
  appleId: ["Apple Identifier"],
  parentId: ["Parent Identifier"],
  device: ["Device"],
} as const;
type Column = keyof typeof COLUMNS;

export interface SalesRow {
  sku: string;
  productType: string;
  /** Negative for refunds. */
  units: number;
  /** Units as written, for exact proceeds. */
  rawUnits: string;
  /** Developer Proceeds per unit, as written (a decimal string). */
  proceeds: string;
  countryCode: string;
  currency: string;
  /** The app's Apple ID, or for an in-app purchase the purchase's own ID. */
  appleId: string;
  /** For an in-app purchase: the SKU of its app. */
  parentId: string;
  device: string;
}

const DECIMAL = /^[-+]?\d+(\.\d+)?$/;

/** A decimal written with a dot, whatever the host's locale; "" is 0. */
export function parseDecimal(raw: string, what: string): number {
  const value = raw.trim();
  if (value === "") return 0;
  if (!DECIMAL.test(value)) {
    throw new Error(`App Store sales report has a malformed ${what} value`);
  }
  return Number(value);
}

/**
 * Parses a report's tab-separated text. Columns are matched by header name,
 * never by position: a missing column the sync needs fails the report, and
 * columns it does not know are ignored.
 */
export function parseSalesReport(text: string): SalesRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = (lines[0] ?? "").split("\t").map((name) => name.trim());
  const index = {} as Record<Column, number>;
  const missing: string[] = [];
  for (const [column, names] of Object.entries(COLUMNS) as Array<
    [Column, readonly string[]]
  >) {
    const position = header.findIndex((name) => names.includes(name));
    if (position < 0) missing.push(names[0]!);
    index[column] = position;
  }
  if (missing.length > 0) {
    throw new Error(
      `App Store sales report lacks the column${missing.length > 1 ? "s" : ""} ${missing.map((name) => `"${name}"`).join(", ")}`,
    );
  }
  const rows: SalesRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const fields = line.split("\t");
    const field = (column: Column) => (fields[index[column]] ?? "").trim();
    rows.push({
      sku: field("sku"),
      productType: field("productType"),
      units: parseDecimal(field("units"), "Units"),
      rawUnits: field("units"),
      proceeds: field("proceeds"),
      countryCode: field("countryCode").toUpperCase(),
      currency: field("currency").toUpperCase(),
      appleId: field("appleId"),
      parentId: field("parentId"),
      device: field("device"),
    });
  }
  return rows;
}

// ─── Money ──────────────────────────────────────────────────────────────────

/**
 * ISO 4217 minor-unit exponents that differ from 2, the same table as
 * packages/domain/src/currency.ts (connectors may not import the domain
 * package; keep both equal). JPY has none, BHD three.
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  CLF: 4,
  UYW: 4,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

/** Decimal places kept exactly while proceeds are summed. */
const AMOUNT_SCALE = 12;

function scaled(raw: string, what: string): bigint {
  const value = raw.trim();
  if (value === "") return 0n;
  if (!DECIMAL.test(value)) {
    throw new Error(`App Store sales report has a malformed ${what} value`);
  }
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^[-+]/, "").split(".");
  if (fraction.length > AMOUNT_SCALE / 2) {
    throw new Error(`App Store sales report has a malformed ${what} value`);
  }
  const digits = BigInt(whole + fraction.padEnd(AMOUNT_SCALE / 2, "0"));
  return negative ? -digits : digits;
}

/**
 * Units × Developer Proceeds (per unit) of one row, exact, at AMOUNT_SCALE
 * decimals (each factor has at most AMOUNT_SCALE / 2).
 */
export function rowProceeds(units: string, proceeds: string): bigint {
  return scaled(units, "Units") * scaled(proceeds, "Developer Proceeds");
}

/**
 * An exact amount (AMOUNT_SCALE decimals) as integer minor units of its
 * currency, rounded half away from zero once, after summing: 1234.565 USD
 * → 123457, 840 JPY → 840.
 */
export function toMinorUnits(amount: bigint, currency: string): number {
  const divisor = 10n ** BigInt(AMOUNT_SCALE - currencyExponent(currency));
  const negative = amount < 0n;
  const magnitude = negative ? -amount : amount;
  let minor = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) minor += 1n;
  const value = Number(negative ? -minor : minor);
  if (!Number.isSafeInteger(value)) {
    throw new Error("App Store proceeds exceed the exact integer range");
  }
  return value;
}
