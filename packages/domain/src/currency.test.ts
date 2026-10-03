import { describe, expect, it } from "vitest";

import {
  amountCurrency,
  currencyExponent,
  isCurrencyCode,
  isPerCurrencyUnit,
  toMajorUnits,
} from "./currency.js";

describe("currencyExponent", () => {
  it.each([
    ["EUR", 2],
    ["USD", 2],
    ["JPY", 0],
    ["KRW", 0],
    ["BHD", 3],
    ["KWD", 3],
    // ISO, not CLDR: Intl shows IQD without decimals.
    ["IQD", 3],
    ["CLF", 4],
  ])("%s has %i decimals", (currency, exponent) => {
    expect(currencyExponent(currency)).toBe(exponent);
  });

  it("converts minor to major units", () => {
    expect(toMajorUnits(123_456, "EUR")).toBe(1234.56);
    expect(toMajorUnits(500, "JPY")).toBe(500);
    expect(toMajorUnits(1_234, "BHD")).toBe(1.234);
  });
});

describe("amountCurrency", () => {
  it("reads a single-currency unit", () => {
    expect(amountCurrency("EUR_minor")).toBe("EUR");
    expect(amountCurrency("EUR_minor", "USD")).toBe("EUR");
  });

  it("takes a per-currency amount's currency from its filter", () => {
    expect(isPerCurrencyUnit("currency_minor")).toBe(true);
    expect(amountCurrency("currency_minor", "JPY")).toBe("JPY");
    expect(amountCurrency("currency_minor")).toBeNull();
    expect(amountCurrency("currency_minor", "yen")).toBeNull();
  });

  it("is null for other units", () => {
    expect(amountCurrency("visitors", "EUR")).toBeNull();
    expect(isCurrencyCode("EU")).toBe(false);
    expect(isCurrencyCode("eur")).toBe(false);
  });
});
