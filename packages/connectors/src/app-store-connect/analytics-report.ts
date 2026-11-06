import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { MAX_REPORT_BYTES } from "./sales-report.js";

// The two standard analytics reports netrics reads (ADR 0014, #174). Their
// fields are documented in Apple's Analytics Reports reference:
//
// - "App Store Discovery and Engagement" (category APP_STORE_ENGAGEMENT):
//   Date, App Name, App Apple Identifier, Event, Page Type, Source Type,
//   Engagement Type, Device, Platform Version, Territory, Counts, Unique
//   Counts in the standard report; Event is "Impression", "Page view" or
//   "Tap"
//   (https://developer.apple.com/documentation/analytics-reports/app-store-discovery-and-engagement).
// - "App Downloads" (category COMMERCE, called "App Store Downloads" in the
//   reference): Date, App Name, App Apple Identifier, Download Type, App
//   Version, Device, Platform Version, Source Type, Page Type, Pre-Order,
//   Territory, Counts; Download Type is "First-time download",
//   "Redownload", "Manual update", "Auto-update" or "Restore"
//   (https://developer.apple.com/documentation/analytics-reports/app-download).
//
// The API names the standard and detailed variants with a suffix ("App
// Store Discovery and Engagement Detailed" in Apple's example,
// https://developer.apple.com/documentation/appstoreconnectapi/downloading-analytics-reports).
// netrics reads the standard ones: they carry every field it maps, with
// fewer privacy thresholds. Segment files are gzip-compressed and, despite
// their ".csv.gz" name, tab-separated in the published samples; the parser
// takes the delimiter from the header line. Columns are matched by name,
// never by position, and unknown columns are ignored.

export const DISCOVERY_REPORT_NAME =
  "App Store Discovery and Engagement Standard";
export const DOWNLOADS_REPORT_NAME = "App Downloads Standard";

/** Source Type values of both reports, as Apple's glossaries spell them. */
export const ANALYTICS_SOURCE_TYPES = [
  "App Store search",
  "App Store browse",
  "App referrer",
  "Web referrer",
  "App Clip",
  "Notification",
  "Institutional purchase",
  "Unavailable",
] as const;
/** A source type Apple adds later: counted, but grouped. */
export const OTHER_SOURCE = "Other";

const SOURCE_LABELS = new Map(
  ANALYTICS_SOURCE_TYPES.map((label) => [label.toLowerCase(), label]),
);

/**
 * The bounded `source` dimension: one of Apple's documented source types,
 * "Unavailable" when empty, and "Other" for anything new, so the series
 * count stays at most nine per app.
 */
export function sourceLabel(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === "") return "Unavailable";
  return SOURCE_LABELS.get(value) ?? OTHER_SOURCE;
}

/**
 * A segment file that cannot be used: wrong checksum, not gzip, too large,
 * or missing columns. It fails the analytics of that app only.
 */
export class AnalyticsReportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AnalyticsReportError";
  }
}

/** Lowercase hex MD5, the checksum Apple lists for every segment. */
export function md5Hex(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("hex");
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Verifies a downloaded segment against Apple's MD5 checksum and inflates
 * it with a bound (64 MiB), so a gzip bomb fails as a provider error. A
 * body that is not gzip is taken as text: an HTTP layer may already have
 * decoded a `Content-Encoding: gzip` object (the checksum still has to
 * match what was received).
 */
export function readSegment(
  bytes: Uint8Array,
  checksum: string | undefined,
  maxBytes = MAX_REPORT_BYTES,
): string {
  if (checksum !== undefined && checksum !== "") {
    if (md5Hex(bytes) !== checksum.trim().toLowerCase()) {
      throw new AnalyticsReportError(
        "App Store analytics segment does not match its checksum",
      );
    }
  }
  if (!isGzip(bytes)) {
    if (bytes.length > maxBytes) {
      throw new AnalyticsReportError(
        `App Store analytics segment exceeds ${maxBytes} bytes`,
      );
    }
    return new TextDecoder().decode(bytes);
  }
  try {
    return gunzipSync(bytes, { maxOutputLength: maxBytes }).toString("utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new AnalyticsReportError(
        `App Store analytics segment exceeds ${maxBytes} bytes when inflated`,
        { cause: error },
      );
    }
    throw new AnalyticsReportError(
      "App Store analytics segment is not a readable gzip file",
      { cause: error },
    );
  }
}

/** Splits delimited text into rows, honoring double-quoted fields. */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

/** A table by column name; missing required columns fail it. */
function parseTable(
  text: string,
  required: readonly string[],
  report: string,
): { rows: string[][]; column: (name: string) => number } {
  const content = text.replace(/^\uFEFF/, "");
  const headerLine = content.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = headerLine.includes("\t") ? "\t" : ",";
  const [header, ...rows] = splitRows(content, delimiter);
  if (!header) {
    // An empty segment: no rows.
    return { rows: [], column: () => -1 };
  }
  const index = new Map(
    header.map((name, position) => [name.trim().toLowerCase(), position]),
  );
  const missing = required.filter((name) => !index.has(name.toLowerCase()));
  if (missing.length > 0) {
    throw new AnalyticsReportError(
      `App Store analytics report "${report}" has no column ${missing
        .map((name) => `"${name}"`)
        .join(", ")}`,
    );
  }
  return {
    rows,
    column: (name) => index.get(name.toLowerCase()) ?? -1,
  };
}

/** YYYY-MM-DD from Apple's date (ISO, or MM/DD/YYYY as sales reports use). */
export function reportDate(raw: string): string | undefined {
  const value = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  const [year, month, day] = iso
    ? [iso[1]!, iso[2]!, iso[3]!]
    : us
      ? [us[3]!, us[1]!, us[2]!]
      : [];
  if (!year || !month || !day) return undefined;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
    ? undefined
    : date;
}

/** A count: digits only (a thousands separator is tolerated), never negative. */
function count(raw: string, report: string): number {
  const value = raw.trim().replace(/[,\s]/g, "");
  if (value === "") return 0;
  if (!/^\d+(\.0+)?$/.test(value)) {
    throw new AnalyticsReportError(
      `App Store analytics report "${report}" has a count that is not a number`,
    );
  }
  return Number(value);
}

function dateOf(raw: string, report: string): string {
  const date = reportDate(raw);
  if (!date) {
    throw new AnalyticsReportError(
      `App Store analytics report "${report}" has a date that is not a date`,
    );
  }
  return date;
}

export interface DiscoveryRow {
  date: string;
  appId: string;
  event: string;
  pageType: string;
  sourceType: string;
  counts: number;
}

/** Rows of an "App Store Discovery and Engagement" segment. */
export function parseDiscoveryReport(text: string): DiscoveryRow[] {
  const report = "App Store Discovery and Engagement";
  const table = parseTable(
    text,
    ["Date", "App Apple Identifier", "Event", "Page Type", "Counts"],
    report,
  );
  const at = (row: string[], name: string) =>
    (row[table.column(name)] ?? "").trim();
  return table.rows.map((row) => ({
    date: dateOf(at(row, "Date"), report),
    appId: at(row, "App Apple Identifier"),
    event: at(row, "Event"),
    pageType: at(row, "Page Type"),
    sourceType: at(row, "Source Type"),
    counts: count(at(row, "Counts"), report),
  }));
}

export interface DownloadRow {
  date: string;
  appId: string;
  downloadType: string;
  sourceType: string;
  counts: number;
}

/** Rows of an "App Downloads" segment. */
export function parseDownloadsReport(text: string): DownloadRow[] {
  const report = "App Downloads";
  const table = parseTable(
    text,
    ["Date", "App Apple Identifier", "Download Type", "Source Type", "Counts"],
    report,
  );
  const at = (row: string[], name: string) =>
    (row[table.column(name)] ?? "").trim();
  return table.rows.map((row) => ({
    date: dateOf(at(row, "Date"), report),
    appId: at(row, "App Apple Identifier"),
    downloadType: at(row, "Download Type"),
    sourceType: at(row, "Source Type"),
    counts: count(at(row, "Counts"), report),
  }));
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Impressions: the app's icon shown in a list (Event "Impression"). */
export function isImpression(row: DiscoveryRow): boolean {
  return same(row.event, "Impression");
}

/**
 * Product page views: Event "Page view" on the app's product page, or on
 * a store sheet (the product page shown inside another app). Views of
 * in-app event pages, the version history, privacy and other pages are not
 * counted.
 */
export function isProductPageView(row: DiscoveryRow): boolean {
  return (
    same(row.event, "Page view") &&
    (same(row.pageType, "Product page") || same(row.pageType, "Store sheet"))
  );
}

/** First-time downloads ("First-time download"; not redownloads, updates or restores). */
export function isFirstTimeDownload(row: DownloadRow): boolean {
  return same(row.downloadType.replace(/\s+/g, " "), "First-time download");
}
