import { currencyExponent, isCurrencyCode } from "./currency.js";
import { addDays, type BucketValue, type CivilDate } from "./metrics.js";

/**
 * Display currency (ADR 0014, #191): amounts of a "currency_minor" metric
 * converted into one currency with the ECB euro reference rates of each
 * reporting day. Stored observations never change; conversion happens when
 * a tile is read, and the result is approximate.
 */

export const EXCHANGE_RATE_SOURCE = {
  id: "ecb",
  name: "ECB euro foreign exchange reference rates",
  shortName: "ECB reference rates",
  url: "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html",
} as const;

/** The ECB publishes units of each currency per euro. */
export const RATE_BASE_CURRENCY = "EUR";

/**
 * A reporting day without a rate (weekend, TARGET holiday, today before
 * 16:00 CET) uses the last rate published before it, at most this many days
 * earlier. Older rates are not used: the amount stays unconverted.
 */
export const RATE_LOOKBACK_DAYS = 14;

/** "1.1225", "176.99", "137": a positive decimal as the ECB writes it. */
const RATE = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

export function isRateString(value: string): boolean {
  const match = RATE.exec(value);
  return match !== null && /[1-9]/.test(value);
}

/** An exact rational number; den > 0. */
interface Fraction {
  num: bigint;
  den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x === 0n ? 1n : x;
}

function reduce(f: Fraction): Fraction {
  const d = gcd(f.num, f.den);
  return { num: f.num / d, den: f.den / d };
}

function parseRate(rate: string): Fraction {
  const match = RATE.exec(rate);
  if (!match || !isRateString(rate)) {
    throw new RangeError("not a positive decimal rate");
  }
  const decimals = match[2] ?? "";
  return reduce({
    num: BigInt(`${match[1]}${decimals}`),
    den: 10n ** BigInt(decimals.length),
  });
}

function add(a: Fraction, b: Fraction): Fraction {
  return reduce({ num: a.num * b.den + b.num * a.den, den: a.den * b.den });
}

/** To the nearest integer, halves away from zero. */
function round(f: Fraction): bigint {
  const negative = f.num < 0n;
  const abs = negative ? -f.num : f.num;
  const rounded = (2n * abs + f.den) / (2n * f.den);
  return negative ? -rounded : rounded;
}

/**
 * `amountMinor` minor units of `from` as minor units of `to`, exactly:
 * amount ÷ 10^exp(from) ÷ rate(from) × rate(to) × 10^exp(to), where rates
 * are units per euro (EUR itself is 1). ISO 4217 exponents: JPY 0, EUR 2.
 */
function convertExact(
  amountMinor: bigint,
  from: string,
  to: string,
  fromPerEur: string,
  toPerEur: string,
): Fraction {
  const rateFrom = parseRate(fromPerEur);
  const rateTo = parseRate(toPerEur);
  return reduce({
    num:
      amountMinor *
      rateTo.num *
      rateFrom.den *
      10n ** BigInt(currencyExponent(to)),
    den: rateTo.den * rateFrom.num * 10n ** BigInt(currencyExponent(from)),
  });
}

/**
 * One amount converted and rounded to whole minor units of `to`. Exposed for
 * tests and single values; tiles add up exact fractions per bucket first.
 */
export function convertMinorUnits(
  amountMinor: number,
  from: string,
  to: string,
  fromPerEur: string,
  toPerEur: string,
): number {
  return Number(
    round(
      convertExact(
        BigInt(Math.round(amountMinor)),
        from,
        to,
        fromPerEur,
        toPerEur,
      ),
    ),
  );
}

export interface ExchangeRate {
  date: CivilDate;
  currency: string;
  /** Units of the currency per euro, as a decimal string (never a float). */
  unitsPerEur: string;
}

/**
 * Published rates by currency, for looking up the rate of a reporting day.
 */
export class RateTable {
  private readonly byCurrency = new Map<string, ExchangeRate[]>();

  constructor(rates: Iterable<ExchangeRate>) {
    for (const rate of rates) {
      const list = this.byCurrency.get(rate.currency) ?? [];
      list.push(rate);
      this.byCurrency.set(rate.currency, list);
    }
    for (const list of this.byCurrency.values()) {
      list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }
  }

  /**
   * Units of `currency` per euro on `date`: that day's rate, else the last
   * one published before it within RATE_LOOKBACK_DAYS. EUR is always 1.
   * Null when there is none.
   */
  rateOn(currency: string, date: CivilDate): string | null {
    if (currency === RATE_BASE_CURRENCY) {
      return "1";
    }
    const list = this.byCurrency.get(currency);
    if (!list) {
      return null;
    }
    const earliest = addDays(date, -RATE_LOOKBACK_DAYS);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const rate = list[i]!;
      if (rate.date <= date) {
        return rate.date >= earliest ? rate.unitsPerEur : null;
      }
    }
    return null;
  }
}

/** A bucket's amount in one currency, with the reporting day it belongs to. */
export interface CurrencyBucketValue {
  /** Bucket start (ISO 8601). */
  bucket: string;
  /** The reporting day whose rate applies. */
  date: CivilDate;
  currency: string;
  /** Minor units of `currency`. */
  value: number;
}

export interface ConvertedBuckets {
  /**
   * Per bucket, the amounts that could be converted, added up exactly and
   * rounded once to whole minor units of the display currency. Buckets with
   * nothing convertible are missing.
   */
  converted: BucketValue[];
  /**
   * Amounts without a rate for their day, per currency and bucket, in their
   * own minor units. They are never added to the converted values.
   */
  unconverted: Map<string, BucketValue[]>;
}

/**
 * Converts each bucket's amounts into `to` at the rate of the bucket's
 * reporting day. Amounts already in `to` stay exact.
 */
export function convertBuckets(
  values: readonly CurrencyBucketValue[],
  to: string,
  rates: RateTable,
): ConvertedBuckets {
  const sums = new Map<string, Fraction>();
  const unconverted = new Map<string, Map<string, number>>();
  for (const entry of values) {
    let amount: Fraction | null = null;
    if (entry.currency === to) {
      amount = { num: BigInt(Math.round(entry.value)), den: 1n };
    } else {
      const fromRate = rates.rateOn(entry.currency, entry.date);
      const toRate = rates.rateOn(to, entry.date);
      if (fromRate !== null && toRate !== null) {
        amount = convertExact(
          BigInt(Math.round(entry.value)),
          entry.currency,
          to,
          fromRate,
          toRate,
        );
      }
    }
    if (amount) {
      const sum = sums.get(entry.bucket);
      sums.set(entry.bucket, sum ? add(sum, amount) : amount);
    } else {
      const buckets = unconverted.get(entry.currency) ?? new Map();
      buckets.set(entry.bucket, (buckets.get(entry.bucket) ?? 0) + entry.value);
      unconverted.set(entry.currency, buckets);
    }
  }
  const byBucket = (a: BucketValue, b: BucketValue) =>
    a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0;
  return {
    converted: [...sums]
      .map(([bucket, sum]) => ({ bucket, value: Number(round(sum)) }))
      .sort(byBucket),
    unconverted: new Map(
      [...unconverted]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([currency, buckets]) => [
          currency,
          [...buckets]
            .map(([bucket, value]) => ({ bucket, value }))
            .sort(byBucket),
        ]),
    ),
  };
}

/** Whether a display currency can be chosen: EUR or a code with rates. */
export function isDisplayCurrency(
  currency: string,
  covered: readonly string[],
): boolean {
  return (
    isCurrencyCode(currency) &&
    (currency === RATE_BASE_CURRENCY || covered.includes(currency))
  );
}

/**
 * What a screen shows next to a converted amount, for screens that only
 * read the tile label (tvOS, ADR 0007): "≈ EUR, ECB reference rates", and
 * the currencies left out ("TWD not converted").
 */
export function conversionNote(
  displayCurrency: string,
  unconverted: readonly string[],
): string {
  const note = `≈ ${displayCurrency}, ${EXCHANGE_RATE_SOURCE.shortName}`;
  return unconverted.length > 0
    ? `${note}; ${unconverted.join(", ")} not converted`
    : note;
}
