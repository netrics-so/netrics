import { readFileSync, writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { localeCompactNumber, narrowCompactNumber } from "./compact-format.js";
import { buildCompactNumberVectors } from "./compact-format-vectors.js";

describe("localeCompactNumber", () => {
  it.each([
    [12_900, "en", undefined, "12.9K"],
    [12_900, "de", undefined, "12,9\u00a0Tsd."],
    [4_200_000, "de", undefined, "4,2\u00a0Mio."],
    [1_500_000_000, "de", undefined, "1,5\u00a0Mrd."],
    [-12_900, "de", undefined, "-12,9\u00a0Tsd."],
    [999_950, "de", undefined, "1\u00a0Mio."],
    [999_950, "en", undefined, "1M"],
    [4_200_000, "de", "EUR", "4,2\u00a0Mio.\u00a0€"],
    [4_200_000, "en", "EUR", "€4.2M"],
  ] as const)("%d in %s (%s) is %s", (value, locale, currency, text) => {
    expect(localeCompactNumber(value, locale, currency)).toBe(text);
  });
});

describe("narrowCompactNumber", () => {
  it("keeps the shared suffixes with the language's decimal separator", () => {
    expect(narrowCompactNumber(12_345, "de")).toBe("12,3K");
    expect(narrowCompactNumber(12_345, "en")).toBe("12.3K");
    expect(narrowCompactNumber(-4_200_000, "de")).toBe("-4,2M");
  });
});

describe("compact number vectors", () => {
  const path = new URL("../test-vectors/compact-numbers.json", import.meta.url);

  it("match the checked-in file (pnpm vectors:compact regenerates it)", () => {
    const text = `${JSON.stringify(buildCompactNumberVectors(), null, 2)}\n`;
    if (process.env.UPDATE_COMPACT_VECTORS === "1") {
      writeFileSync(path, text);
    }
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(text));
  });
});

describe("negative values", () => {
  it("round like positive ones (half away from zero)", () => {
    expect(localeCompactNumber(-12_950, "de")).toBe("-13\u00a0Tsd.");
    expect(localeCompactNumber(-1_050_000, "de")).toBe("-1,1\u00a0Mio.");
    expect(localeCompactNumber(-999_950, "de")).toBe("-1\u00a0Mio.");
  });
});

describe("narrow amounts", () => {
  it("take the full compact form, never the long German Intl one", () => {
    expect(narrowCompactNumber(12_345.5, "de", "EUR")).toBe(
      "12,3\u00a0Tsd.\u00a0€",
    );
    expect(narrowCompactNumber(12_345.5, "en", "EUR")).toBe("€12.3K");
    expect(narrowCompactNumber(42.25, "de", "EUR")).toBe("42,3\u00a0€");
  });
});
