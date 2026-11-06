import {
  AppStoreConnectApiError,
  ascErrorBody,
  type AppStoreConnectClient,
  type AscErrorBody,
} from "./api.js";
import { SALES_REPORT_VERSION } from "./sales-report.js";

// The key, role and vendor-number check (ADR 0014, "Validation before
// anything is stored"). The same two probes run on the host before a key is
// stored (the signed-key provider's probes) and in the connector's check on
// every sync, so a key that was revoked or lost its role later is caught the
// same way. Each probe gets a freshly signed token.
//
// Apple's error shapes (`ErrorResponse.errors[]` with status, code, title,
// detail, source):
// - 401 NOT_AUTHORIZED for a token Apple cannot verify: wrong issuer ID, key
//   ID or private key, or a revoked key
//   (https://developer.apple.com/documentation/appstoreconnectapi/get-v1-salesreports
//   lists 400, 401, 403 and 429).
// - 403 FORBIDDEN_ERROR "The API key in use does not allow this request"
//   when the key's role cannot read sales reports
//   (https://developer.apple.com/forums/thread/747095).
// - 403 FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED when the Account
//   Holder has not accepted the current agreements
//   (https://developer.apple.com/forums/thread/700371).
// - 400 PARAMETER_ERROR.INVALID with source.parameter
//   "filter[vendorNumber]", detail "Invalid vendor number specified. Try
//   again." for a vendor number the team does not have
//   (https://developer.apple.com/forums/thread/704777).
// - 404 NOT_FOUND for a day without sales, or a report that is not
//   available yet (https://developer.apple.com/forums/thread/667759): the
//   key, role and vendor number were accepted, so it counts as success.

/** A probe's answer: a CheckResult whose failure always has a message. */
export type ProbeResult = { ok: true } | { ok: false; message: string };

export const KEY_MISMATCH_MESSAGE =
  "App Store Connect refused the key: the issuer ID, key ID and private key do not belong together, or the key was revoked. Check the three values, or create a new team key and upload it.";

export const ROLE_MESSAGE =
  "This key cannot read sales reports. It needs the Sales or Finance role; Admin also works, but grants more than netrics needs. Create a team key with the Sales role and upload it.";

export const AGREEMENTS_MESSAGE =
  "App Store Connect requires an agreement that is missing or has expired. The Account Holder must accept the latest agreements in App Store Connect (Business), then try again.";

export function vendorNumberMessage(vendorNumber: string): string {
  return `App Store Connect does not know vendor number ${vendorNumber} for this key's team. Copy the vendor number from Payments and Financial Reports, under your legal entity name.`;
}

export const VENDOR_NUMBER_FORMAT_MESSAGE =
  "The vendor number is the number shown in Payments and Financial Reports, under your legal entity name (digits only, e.g. 85012345).";

const VENDOR_NUMBER = /^\d{1,20}$/;

/** The trimmed vendor number of a config, or undefined when malformed. */
export function vendorNumberOf(
  config: Readonly<Record<string, unknown>>,
): string | undefined {
  const raw = config.vendorNumber;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return VENDOR_NUMBER.test(value) ? value : undefined;
}

/** The daily SALES/SUMMARY report the probe and the sync read. */
export const SALES_REPORT_FILTERS = {
  "filter[frequency]": "DAILY",
  "filter[reportType]": "SALES",
  "filter[reportSubType]": "SUMMARY",
  "filter[version]": SALES_REPORT_VERSION,
} as const;

const PACIFIC = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
});

const DAY_MS = 24 * 60 * 60 * 1000;

function pacificParts(nowMs: number) {
  const parts = Object.fromEntries(
    PACIFIC.formatToParts(new Date(nowMs)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return {
    /** Today's date in California, as UTC midnight of that date. */
    today: Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
    ),
    hour: Number(parts.hour),
  };
}

/** Today's Pacific-Time date, as UTC midnight of that date (ms). */
export function pacificToday(nowMs: number): number {
  return pacificParts(nowMs).today;
}

/** UTC midnight (ms) of the latest reporting day whose report should exist. */
export function latestReportDay(nowMs: number): number {
  const { today, hour } = pacificParts(nowMs);
  return today - (hour >= 12 ? 1 : 2) * DAY_MS;
}

/**
 * The latest reporting day whose daily report should exist: reporting days
 * are Pacific Time and a day D is published by the next morning, so D is
 * yesterday (PT) from noon PT on, and the day before until then (ADR 0014,
 * "404 has two meanings").
 */
export function latestReportDate(nowMs: number): string {
  return new Date(latestReportDay(nowMs)).toISOString().slice(0, 10);
}

function isAgreements(body: AscErrorBody): boolean {
  return (body.code ?? "").startsWith("FORBIDDEN.REQUIRED_AGREEMENTS");
}

function isVendorError(body: AscErrorBody): boolean {
  return (
    body.parameter === "filter[vendorNumber]" ||
    /vendor/i.test(body.detail ?? "")
  );
}

/** 429 and 5xx are retryable: thrown, so the caller backs off. */
function throwIfRetryable(status: number, body: AscErrorBody): void {
  if (status === 429 || status >= 500) {
    throw new AppStoreConnectApiError(status, body);
  }
}

/**
 * Probe 1: `GET /v1/apps?limit=1`. A 401 means the issuer ID, key ID and
 * private key do not belong together (Apple does not say which), or the
 * key was revoked.
 */
export async function probeApps(
  client: AppStoreConnectClient,
): Promise<ProbeResult> {
  const response = await client.request("/v1/apps", {
    limit: "1",
    "fields[apps]": "name",
  });
  if (response.status >= 200 && response.status < 300) return { ok: true };
  const body = ascErrorBody(response);
  throwIfRetryable(response.status, body);
  if (response.status === 401) {
    return { ok: false, message: KEY_MISMATCH_MESSAGE };
  }
  if (response.status === 403) {
    return {
      ok: false,
      message: isAgreements(body) ? AGREEMENTS_MESSAGE : ROLE_MESSAGE,
    };
  }
  return {
    ok: false,
    message: new AppStoreConnectApiError(response.status, body).message,
  };
}

/**
 * Probe 2: the daily SALES/SUMMARY report of the configured vendor number
 * for the latest available day. 403 names the missing role, a vendor error
 * says the vendor number is wrong, and 404 (no sales that day, or not
 * published yet) is success.
 */
export async function probeSalesReport(
  client: AppStoreConnectClient,
  config: Readonly<Record<string, unknown>>,
  nowMs: number,
): Promise<ProbeResult> {
  const vendorNumber = vendorNumberOf(config);
  if (!vendorNumber) {
    return { ok: false, message: VENDOR_NUMBER_FORMAT_MESSAGE };
  }
  const response = await client.request(
    "/v1/salesReports",
    {
      ...SALES_REPORT_FILTERS,
      "filter[vendorNumber]": vendorNumber,
      "filter[reportDate]": latestReportDate(nowMs),
    },
    "application/a-gzip, application/json",
  );
  if (response.status >= 200 && response.status < 300) return { ok: true };
  if (response.status === 404) return { ok: true };
  const body = ascErrorBody(response);
  throwIfRetryable(response.status, body);
  if (response.status === 401) {
    return { ok: false, message: KEY_MISMATCH_MESSAGE };
  }
  if (response.status === 403) {
    return {
      ok: false,
      message: isAgreements(body) ? AGREEMENTS_MESSAGE : ROLE_MESSAGE,
    };
  }
  if (isVendorError(body)) {
    return { ok: false, message: vendorNumberMessage(vendorNumber) };
  }
  return {
    ok: false,
    message: new AppStoreConnectApiError(response.status, body).message,
  };
}

/**
 * Both probes in order with one client (one token, one hourly budget); the
 * first failure answers. Retryable answers (429, 5xx, a low hourly budget)
 * throw.
 */
export async function checkKey(
  client: AppStoreConnectClient,
  config: Readonly<Record<string, unknown>>,
  nowMs: number,
): Promise<ProbeResult> {
  const apps = await probeApps(client);
  if (!apps.ok) return apps;
  return probeSalesReport(client, config, nowMs);
}
