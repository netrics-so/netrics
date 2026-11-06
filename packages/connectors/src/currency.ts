/**
 * ISO 4217 minor-unit exponents that differ from 2, the same table as
 * packages/domain/src/currency.ts (connectors may not import the domain
 * package; keep both equal, test-vectors/decimal-amounts.json checks a
 * sample on both sides). JPY has none, BHD three.
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

/** Decimal places of the minor unit: JPY 0, EUR 2, BHD 3. */
export function currencyExponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

const CURRENCY_CODE = /^[A-Z]{3}$/;

export function isCurrencyCode(value: string): boolean {
  return CURRENCY_CODE.test(value);
}
