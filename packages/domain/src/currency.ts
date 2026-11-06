/**
 * Currency amounts (ADR 0008, ADR 0014). Amounts are stored as integer minor
 * units. A single-currency metric names its currency in the unit
 * ("EUR_minor"); a metric whose currency varies per observation has the unit
 * "currency_minor" and carries the ISO 4217 code in its "currency"
 * dimension. Amounts in different currencies are never added up: there is no
 * FX conversion.
 */

/** Unit of a metric whose currency is in the `currency` dimension. */
export const CURRENCY_MINOR_UNIT = "currency_minor";
/** The dimension holding the ISO 4217 code of a `currency_minor` value. */
export const CURRENCY_DIMENSION = "currency";

const CURRENCY_CODE = /^[A-Z]{3}$/;
const SINGLE_CURRENCY_UNIT = /^([A-Z]{3})_minor$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE.test(value);
}

/**
 * ISO 4217 minor-unit exponents that differ from 2. Taken from the ISO
 * table, not from CLDR (which Intl uses): CLDR shows, for example, IQD
 * without decimals although ISO defines three.
 */
const EXPONENTS: Record<string, number> = {
  // 0: no minor unit.
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
  // 3: thousandths.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // 4.
  CLF: 4,
  UYW: 4,
};

/** Decimal places of the minor unit: JPY 0, EUR 2, BHD 3. */
export function currencyExponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

/** Minor units to the major unit: 123456 EUR → 1234.56, 500 JPY → 500. */
export function toMajorUnits(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}

/** Whether a metric's values are amounts in a per-observation currency. */
export function isPerCurrencyUnit(unit: string): boolean {
  return unit === CURRENCY_MINOR_UNIT;
}

/**
 * The currency of an amount: from a single-currency unit ("EUR_minor"), or
 * for "currency_minor" from the currency it was filtered to. Null when the
 * value is not an amount, or its currency is not known.
 */
export function amountCurrency(
  unit: string,
  currency?: string | null,
): string | null {
  const single = SINGLE_CURRENCY_UNIT.exec(unit);
  if (single) {
    return single[1]!;
  }
  if (isPerCurrencyUnit(unit) && currency && isCurrencyCode(currency)) {
    return currency;
  }
  return null;
}
