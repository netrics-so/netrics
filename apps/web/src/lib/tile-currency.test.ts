import { describe, expect, it } from "vitest";

import {
  currencyOptionLabel,
  effectiveCurrency,
  needsCurrency,
  tileCurrency,
  tileDimensions,
} from "./tile-currency";

const totals = [
  { currency: "JPY", total: 1_200_000 },
  { currency: "EUR", total: 345_600 },
  { currency: "USD", total: 0 },
];

describe("tile currency picker", () => {
  it("is offered only for per-currency amounts", () => {
    expect(needsCurrency({ unit: "currency_minor" })).toBe(true);
    expect(needsCurrency({ unit: "EUR_minor" })).toBe(false);
    expect(needsCurrency({ unit: "visitors" })).toBe(false);
    expect(needsCurrency(undefined)).toBe(false);
  });

  it("defaults to the currency with the largest total", () => {
    expect(effectiveCurrency(totals, "")).toBe("JPY");
  });

  it("keeps the picked currency while the metric has it", () => {
    expect(effectiveCurrency(totals, "USD")).toBe("USD");
    // Another metric or period without CHF: back to the default.
    expect(effectiveCurrency(totals, "CHF")).toBe("JPY");
  });

  it("has nothing to pick before the first amounts arrive", () => {
    expect(effectiveCurrency([], "")).toBeNull();
  });

  it("labels each option with its own total in its currency", () => {
    expect(totals.map(currencyOptionLabel)).toEqual([
      "JPY · ¥1.2M",
      "EUR · €3,456",
      "USD · $0",
    ]);
  });

  it("saves the currency as the tile's dimension filter", () => {
    expect(tileDimensions({ unit: "currency_minor" }, "EUR")).toEqual({
      currency: "EUR",
    });
    expect(tileDimensions({ unit: "signups" }, "EUR")).toEqual({});
    expect(tileCurrency({ currency: "EUR" })).toBe("EUR");
    expect(tileCurrency({})).toBeNull();
  });
});
