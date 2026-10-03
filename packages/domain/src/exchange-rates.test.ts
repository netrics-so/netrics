import { describe, expect, it } from "vitest";

import {
  RateTable,
  conversionNote,
  convertBuckets,
  convertMinorUnits,
  isDisplayCurrency,
  isRateString,
} from "./exchange-rates.js";

// ECB rates of Friday 2026-10-02 (units per euro).
const FRIDAY = "2026-10-02";
const rates = new RateTable([
  { date: FRIDAY, currency: "USD", unitsPerEur: "1.1225" },
  { date: FRIDAY, currency: "JPY", unitsPerEur: "176.99" },
  { date: "2026-10-01", currency: "USD", unitsPerEur: "1.1298" },
  { date: "2026-10-05", currency: "USD", unitsPerEur: "2" },
]);

describe("convertMinorUnits", () => {
  it("converts minor units with ISO 4217 exponents, exactly", () => {
    // $100.00 → €89.0868… → 8909 cents.
    expect(convertMinorUnits(10_000, "USD", "EUR", "1.1225", "1")).toBe(8_909);
    // ¥1000 (no minor unit) → €5.65.
    expect(convertMinorUnits(1_000, "JPY", "EUR", "176.99", "1")).toBe(565);
    // €5.65 → ¥999.99 → ¥1000.
    expect(convertMinorUnits(565, "EUR", "JPY", "1", "176.99")).toBe(1_000);
    // Across two non-euro currencies: $100 → ¥15767.48 → ¥15767.
    expect(convertMinorUnits(10_000, "USD", "JPY", "1.1225", "176.99")).toBe(
      15_767,
    );
    // 1.000 BHD (three decimals) at 0.5 per euro → €2.00.
    expect(convertMinorUnits(1_000, "BHD", "EUR", "0.5", "1")).toBe(200);
  });

  it("rounds halves away from zero, refunds included", () => {
    expect(convertMinorUnits(1, "USD", "EUR", "2", "1")).toBe(1);
    expect(convertMinorUnits(-1, "USD", "EUR", "2", "1")).toBe(-1);
    expect(convertMinorUnits(3, "USD", "EUR", "4", "1")).toBe(1);
  });

  it("refuses rates that are not positive decimals", () => {
    expect(() => convertMinorUnits(1, "USD", "EUR", "0", "1")).toThrow();
    expect(() => convertMinorUnits(1, "USD", "EUR", "1e3", "1")).toThrow();
    expect(isRateString("176.99")).toBe(true);
    expect(isRateString("0.000")).toBe(false);
    expect(isRateString("-1.2")).toBe(false);
  });
});

describe("RateTable", () => {
  it("uses the day's rate, else the last one before it", () => {
    expect(rates.rateOn("USD", "2026-10-01")).toBe("1.1298");
    expect(rates.rateOn("USD", FRIDAY)).toBe("1.1225");
    // Weekend: Friday's rate.
    expect(rates.rateOn("USD", "2026-10-03")).toBe("1.1225");
    expect(rates.rateOn("USD", "2026-10-04")).toBe("1.1225");
    expect(rates.rateOn("USD", "2026-10-05")).toBe("2");
    expect(rates.rateOn("EUR", "1999-01-01")).toBe("1");
  });

  it("has no rate before the first one, too long after, or for other currencies", () => {
    expect(rates.rateOn("USD", "2026-09-30")).toBeNull();
    expect(rates.rateOn("JPY", "2026-10-16")).toBe("176.99");
    expect(rates.rateOn("JPY", "2026-10-17")).toBeNull();
    expect(rates.rateOn("TWD", FRIDAY)).toBeNull();
  });
});

describe("convertBuckets", () => {
  const thursday = "2026-10-01T00:00:00.000Z";
  const friday = "2026-10-02T00:00:00.000Z";
  const saturday = "2026-10-03T00:00:00.000Z";

  it("converts each day at its own rate, weekends at Friday's", () => {
    const result = convertBuckets(
      [
        {
          bucket: thursday,
          date: "2026-10-01",
          currency: "USD",
          value: 11_298,
        },
        { bucket: friday, date: FRIDAY, currency: "USD", value: 11_225 },
        {
          bucket: saturday,
          date: "2026-10-03",
          currency: "USD",
          value: 11_225,
        },
        { bucket: friday, date: FRIDAY, currency: "EUR", value: 50 },
      ],
      "EUR",
      rates,
    );
    expect(result.converted).toEqual([
      { bucket: thursday, value: 10_000 },
      { bucket: friday, value: 10_050 },
      { bucket: saturday, value: 10_000 },
    ]);
    expect(result.unconverted.size).toBe(0);
  });

  it("adds a bucket's amounts exactly and rounds once", () => {
    // Two half cents make one cent, not two.
    const halves = new RateTable([
      { date: FRIDAY, currency: "USD", unitsPerEur: "2" },
      { date: FRIDAY, currency: "GBP", unitsPerEur: "2" },
    ]);
    const result = convertBuckets(
      [
        { bucket: friday, date: FRIDAY, currency: "USD", value: 1 },
        { bucket: friday, date: FRIDAY, currency: "GBP", value: 1 },
      ],
      "EUR",
      halves,
    );
    expect(result.converted).toEqual([{ bucket: friday, value: 1 }]);
  });

  it("keeps amounts without a rate apart, never dropped or added", () => {
    const result = convertBuckets(
      [
        { bucket: friday, date: FRIDAY, currency: "USD", value: 11_225 },
        { bucket: friday, date: FRIDAY, currency: "TWD", value: 3_000 },
        { bucket: saturday, date: "2026-10-03", currency: "TWD", value: 500 },
        // Before the first USD rate.
        {
          bucket: "2026-09-30T00:00:00.000Z",
          date: "2026-09-30",
          currency: "USD",
          value: 7,
        },
      ],
      "EUR",
      rates,
    );
    expect(result.converted).toEqual([{ bucket: friday, value: 10_000 }]);
    expect([...result.unconverted]).toEqual([
      [
        "TWD",
        [
          { bucket: friday, value: 3_000 },
          { bucket: saturday, value: 500 },
        ],
      ],
      ["USD", [{ bucket: "2026-09-30T00:00:00.000Z", value: 7 }]],
    ]);
  });

  it("keeps amounts in the display currency exact without any rate", () => {
    const result = convertBuckets(
      [{ bucket: friday, date: FRIDAY, currency: "TWD", value: 123 }],
      "TWD",
      new RateTable([]),
    );
    expect(result.converted).toEqual([{ bucket: friday, value: 123 }]);
  });
});

describe("display currency labels", () => {
  it("accepts EUR and covered currencies", () => {
    expect(isDisplayCurrency("EUR", [])).toBe(true);
    expect(isDisplayCurrency("USD", ["USD"])).toBe(true);
    expect(isDisplayCurrency("TWD", ["USD"])).toBe(false);
    expect(isDisplayCurrency("usd", ["usd"])).toBe(false);
  });

  it("marks values approximate and names what was left out", () => {
    expect(conversionNote("EUR", [])).toBe("≈ EUR, ECB reference rates");
    expect(conversionNote("USD", ["AED", "TWD"])).toBe(
      "≈ USD, ECB reference rates; AED, TWD not converted",
    );
  });
});
