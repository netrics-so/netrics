import { describe, expect, it } from "vitest";

import {
  choiceValue,
  conversionNote,
  currencyOptionLabel,
  effectiveChoice,
  needsCurrency,
  tileCurrencyFields,
  tileCurrencySummary,
  workspaceChoiceLabel,
} from "./tile-currency";

const totals = [
  { currency: "JPY", total: 1_200_000 },
  { currency: "EUR", total: 345_600 },
  { currency: "USD", total: 0 },
];
const convertible = ["EUR", "JPY", "USD"];

describe("tile currency choice", () => {
  it("is offered only for per-currency amounts", () => {
    expect(needsCurrency({ unit: "currency_minor" })).toBe(true);
    expect(needsCurrency({ unit: "EUR_minor" })).toBe(false);
    expect(needsCurrency({ unit: "visitors" })).toBe(false);
    expect(needsCurrency(undefined)).toBe(false);
  });

  it("follows the workspace by default", () => {
    expect(effectiveChoice("", totals, convertible)).toEqual({
      kind: "workspace",
    });
    expect(choiceValue({ kind: "workspace" })).toBe("");
  });

  it("keeps a pick while it is still on offer", () => {
    expect(effectiveChoice("only:USD", totals, convertible)).toEqual({
      kind: "only",
      currency: "USD",
    });
    expect(effectiveChoice("convert:EUR", totals, convertible)).toEqual({
      kind: "convert",
      currency: "EUR",
    });
    // Another metric without CHF, or rates off: back to the workspace.
    expect(effectiveChoice("only:CHF", totals, convertible).kind).toBe(
      "workspace",
    );
    expect(effectiveChoice("convert:EUR", totals, []).kind).toBe("workspace");
    expect(choiceValue({ kind: "convert", currency: "EUR" })).toBe(
      "convert:EUR",
    );
  });

  it("names the workspace's choice", () => {
    expect(workspaceChoiceLabel("EUR", totals, "en")).toBe(
      "Workspace: converted to EUR (≈)",
    );
    expect(workspaceChoiceLabel(null, totals, "en")).toBe(
      "Workspace: per currency, the largest (now JPY)",
    );
    expect(workspaceChoiceLabel(null, [], "en")).toBe(
      "Workspace: per currency, the largest",
    );
  });

  it("labels each currency with its own total in its currency", () => {
    expect(totals.map((option) => currencyOptionLabel(option, "en"))).toEqual([
      "JPY · ¥1.2M",
      "EUR · €3,456",
      "USD · $0",
    ]);
  });

  it("saves one currency as a filter and a conversion as the tile's display currency", () => {
    const amount = { unit: "currency_minor" };
    expect(
      tileCurrencyFields(amount, { kind: "only", currency: "EUR" }),
    ).toEqual({ dimensions: { currency: "EUR" }, displayCurrency: null });
    expect(
      tileCurrencyFields(amount, { kind: "convert", currency: "USD" }),
    ).toEqual({ dimensions: {}, displayCurrency: "USD" });
    expect(tileCurrencyFields(amount, { kind: "workspace" })).toEqual({
      dimensions: {},
      displayCurrency: null,
    });
    expect(
      tileCurrencyFields(
        { unit: "signups" },
        { kind: "only", currency: "EUR" },
      ),
    ).toEqual({ dimensions: {}, displayCurrency: null });
  });

  it("summarises a saved tile's choice", () => {
    expect(
      tileCurrencySummary({
        dimensions: { currency: "EUR" },
        displayCurrency: null,
      }),
    ).toBe("EUR");
    expect(
      tileCurrencySummary({ dimensions: {}, displayCurrency: "USD" }),
    ).toBe("≈ USD");
    expect(
      tileCurrencySummary({ dimensions: {}, displayCurrency: null }),
    ).toBeNull();
  });

  it("marks converted values approximate, cites the ECB and lists what was left out", () => {
    const note = conversionNote(
      {
        displayCurrency: "EUR",
        approximate: true,
        source: {
          name: "ECB euro foreign exchange reference rates",
          url: "https://www.ecb.europa.eu/",
        },
        unconverted: [
          { currency: "TWD", value: 3_000, previousValue: null },
          { currency: "AED", value: null, previousValue: 100 },
        ],
      },
      "en",
    );
    expect(note.text).toBe("≈ EUR, ECB reference rates");
    expect(note.title).toContain("ECB reference rate of each day");
    expect(note.unconverted).toEqual(["NT$30 not converted"]);
  });
});
