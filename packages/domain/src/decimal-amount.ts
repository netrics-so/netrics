/**
 * Exact decimal money strings to integer minor units (ADR 0020 section 7):
 * Apple Ads sends `localSpend.amount` as a string ("12.34") so that no
 * precision is lost, and netrics stores amounts as minor units (ADR 0008,
 * ADR 0014). The conversion never goes through a floating-point number.
 *
 * The same rules, with the same vectors (test-vectors/decimal-amounts.json),
 * are in packages/connectors/src/decimal-amount.ts, because connectors may
 * not import this package. Keep both equal.
 */
import { currencyExponent, isCurrencyCode } from "./currency.js";

/**
 * A plain decimal: an optional minus sign, digits, and optionally a point
 * followed by digits. No plus sign, exponent, grouping separator, spaces,
 * or a point without digits on both sides.
 */
const DECIMAL_AMOUNT = /^-?\d+(?:\.\d+)?$/;

/** Longer strings are refused before any arithmetic. */
export const MAX_DECIMAL_AMOUNT_LENGTH = 40;

export class DecimalAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecimalAmountError";
  }
}

export interface MinorUnitAmount {
  /** The amount in minor units of its currency: "12.34" EUR → 1234. */
  minor: number;
  /**
   * True when the string had more decimals than the currency's minor unit
   * and was rounded half to even ("0.125" EUR → 12). The caller notes this
   * once per sync, by code; the value itself is still stored.
   */
  rounded: boolean;
}

/**
 * A decimal money string as integer minor units of `currency`, using the
 * ISO 4217 exponent (JPY 0, EUR 2, KWD 3). Extra decimals are rounded half
 * to even on the magnitude, so a credit rounds like the charge it reverses.
 * Negative amounts (credits) are kept; "-0.00" is 0. A malformed string, an
 * unknown-looking currency code, or a value beyond the exact integer range
 * of a double throws DecimalAmountError.
 */
export function parseDecimalAmount(
  amount: string,
  currency: string,
): MinorUnitAmount {
  if (!isCurrencyCode(currency)) {
    throw new DecimalAmountError("the currency is not an ISO 4217 code");
  }
  if (
    typeof amount !== "string" ||
    amount.length > MAX_DECIMAL_AMOUNT_LENGTH ||
    !DECIMAL_AMOUNT.test(amount)
  ) {
    throw new DecimalAmountError("the amount is not a plain decimal string");
  }
  const exponent = currencyExponent(currency);
  const negative = amount.startsWith("-");
  const [whole = "0", fraction = ""] = (
    negative ? amount.slice(1) : amount
  ).split(".");

  const kept = fraction.slice(0, exponent).padEnd(exponent, "0");
  const dropped = fraction.slice(exponent);
  let magnitude = BigInt(whole + kept);
  let rounded = false;
  if (/[1-9]/.test(dropped)) {
    rounded = true;
    // Half to even: compare the dropped digits with exactly one half.
    const half = "5".padEnd(dropped.length, "0");
    if (dropped > half || (dropped === half && magnitude % 2n === 1n)) {
      magnitude += 1n;
    }
  }
  const value = Number(negative ? -magnitude : magnitude);
  if (!Number.isSafeInteger(value)) {
    throw new DecimalAmountError("the amount exceeds the exact integer range");
  }
  // Number(-0n) is 0, so "-0.00" and a credit rounded to nothing are 0.
  return { minor: value, rounded };
}
