import { createEgressFetch } from "@netrics/connector-runtime";
import type { ConnectorResponse } from "@netrics/connector-sdk";
import type { StoredExchangeRate } from "@netrics/database";
import { isCurrencyCode, isRateString } from "@netrics/domain";

// The ECB euro foreign exchange reference rates (#191, ADR 0014): published
// around 16:00 CET on TARGET working days, as XML without a key. A host job,
// not a connector, reads them; the request goes through the same guarded
// fetch as connector egress, limited to the ECB's host.

export const ECB_HOST = "www.ecb.europa.eu";
export const ECB_DAILY_URL = `https://${ECB_HOST}/stats/eurofxref/eurofxref-daily.xml`;
export const ECB_90_DAYS_URL = `https://${ECB_HOST}/stats/eurofxref/eurofxref-hist-90d.xml`;

/** As for connector calls (connector-runtime execute and egress). */
const ECB_TIMEOUT_MS = 60_000;
const ECB_MAX_BYTES = 10 * 1024 * 1024;

/** One GET to the ECB. */
export type RatesHttp = (url: string) => Promise<ConnectorResponse>;

export const ecbHttp: RatesHttp = (url) =>
  createEgressFetch({
    allowedDomains: [ECB_HOST],
    signal: AbortSignal.timeout(ECB_TIMEOUT_MS),
    maxResponseBytes: ECB_MAX_BYTES,
  })(url, { headers: { accept: "application/xml, text/xml" } });

/** The file is not a complete, well-formed rates file; nothing is stored. */
export class EcbFormatError extends Error {
  constructor(message: string) {
    super(`ECB rates file rejected: ${message}`);
    this.name = "EcbFormatError";
  }
}

/**
 * Fewer rates on one day means a partial file: the ECB has published 29 to
 * 41 currencies a day since 1999.
 */
const MIN_RATES_PER_DAY = 20;
/** The 90-day file has about 65 publication days. */
const MAX_DAYS = 400;

const DAY =
  /<Cube\s+time\s*=\s*(['"])(\d{4}-\d{2}-\d{2})\1\s*>([\s\S]*?)<\/Cube>/g;
const RATE =
  /<Cube\s+currency\s*=\s*(['"])([^'"]*)\1\s+rate\s*=\s*(['"])([^'"]*)\3\s*\/>/g;

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Parses eurofxref-daily.xml or eurofxref-hist-90d.xml. All or nothing: a
 * truncated file, an unexpected element, a malformed date, currency or rate,
 * or a day with too few rates rejects the whole file (EcbFormatError), so
 * stored rates are never replaced by a broken download.
 */
export function parseEcbRates(xml: string): StoredExchangeRate[] {
  const text = xml.trim();
  if (
    !text.includes("<gesmes:Envelope") ||
    !text.endsWith("</gesmes:Envelope>")
  ) {
    throw new EcbFormatError("not a complete gesmes envelope");
  }
  const expectedDays = (text.match(/<Cube\s+time\s*=/g) ?? []).length;
  const rates: StoredExchangeRate[] = [];
  const days = new Set<string>();
  for (const day of text.matchAll(DAY)) {
    const date = day[2]!;
    if (!isCalendarDate(date)) {
      throw new EcbFormatError(`invalid date ${date.slice(0, 10)}`);
    }
    if (days.has(date)) {
      throw new EcbFormatError(`day ${date} appears twice`);
    }
    days.add(date);
    const body = day[3]!;
    const currencies = new Set<string>();
    for (const rate of body.matchAll(RATE)) {
      const currency = rate[2]!;
      const value = rate[4]!;
      if (!isCurrencyCode(currency) || currency === "EUR") {
        throw new EcbFormatError(`invalid currency on ${date}`);
      }
      if (!isRateString(value)) {
        throw new EcbFormatError(`invalid rate for ${currency} on ${date}`);
      }
      if (currencies.has(currency)) {
        throw new EcbFormatError(`${currency} appears twice on ${date}`);
      }
      currencies.add(currency);
      rates.push({ date, currency, unitsPerEur: value });
    }
    if (body.replace(RATE, "").trim() !== "") {
      throw new EcbFormatError(`unexpected content on ${date}`);
    }
    if (currencies.size < MIN_RATES_PER_DAY) {
      throw new EcbFormatError(`only ${currencies.size} rates on ${date}`);
    }
  }
  if (days.size === 0 || days.size !== expectedDays) {
    throw new EcbFormatError("days missing or malformed");
  }
  if (days.size > MAX_DAYS) {
    throw new EcbFormatError("too many days");
  }
  return rates;
}
