import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { currencyExponent } from "./currency.js";
import { DecimalAmountError, parseDecimalAmount } from "./decimal-amount.js";

interface DecimalAmountVectors {
  exponents: Record<string, number>;
  valid: Array<{
    amount: string;
    currency: string;
    minor: number;
    rounded: boolean;
  }>;
  invalid: Array<{ amount: string; currency: string }>;
}

// Shared with packages/connectors/src/decimal-amount.test.ts.
const vectors = JSON.parse(
  readFileSync(
    new URL("../test-vectors/decimal-amounts.json", import.meta.url),
    "utf8",
  ),
) as DecimalAmountVectors;

describe("decimal amount vectors", () => {
  it("use the ISO 4217 exponents of currency.ts", () => {
    for (const [currency, exponent] of Object.entries(vectors.exponents)) {
      expect(currencyExponent(currency), currency).toBe(exponent);
    }
  });

  it.each(vectors.valid)(
    "$amount $currency is $minor (rounded: $rounded)",
    ({ amount, currency, minor, rounded }) => {
      const parsed = parseDecimalAmount(amount, currency);
      expect(parsed).toEqual({ minor, rounded });
      expect(Object.is(parsed.minor, -0)).toBe(false);
    },
  );

  it.each(vectors.invalid)(
    "refuses $amount ($currency)",
    ({ amount, currency }) => {
      expect(() => parseDecimalAmount(amount, currency)).toThrow(
        DecimalAmountError,
      );
    },
  );
});

describe("parseDecimalAmount", () => {
  it("covers no decimals (JPY), two (EUR), three (KWD) and credits", () => {
    expect(parseDecimalAmount("1500", "JPY").minor).toBe(1500);
    expect(parseDecimalAmount("12.34", "EUR").minor).toBe(1234);
    expect(parseDecimalAmount("1.234", "KWD").minor).toBe(1234);
    expect(parseDecimalAmount("-12.34", "EUR").minor).toBe(-1234);
  });

  it("rounds half to even, never through a float", () => {
    // As doubles, 1.005 is 1.00499999999999989…; the string is exact.
    expect(parseDecimalAmount("1.005", "EUR").minor).toBe(100);
    expect(parseDecimalAmount("1.015", "EUR").minor).toBe(102);
    expect(parseDecimalAmount("0.285", "EUR").minor).toBe(28);
  });

  it("refuses a value that is not a string", () => {
    expect(() => parseDecimalAmount(12.34 as unknown as string, "EUR")).toThrow(
      DecimalAmountError,
    );
  });

  it("does not echo the input in its error", () => {
    expect(() => parseDecimalAmount("12,34 secret", "EUR")).toThrow(
      "the amount is not a plain decimal string",
    );
  });
});
