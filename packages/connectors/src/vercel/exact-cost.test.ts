import { describe, expect, it } from "vitest";

import {
  addExact,
  exactOf,
  formatExact,
  minorOfExact,
  storedExact,
} from "./exact-cost.js";

const sum = (...values: number[]) =>
  values.reduce((total, value) => addExact(total, exactOf(value)), exactOf(0));

describe("exact Vercel cost sums (#905)", () => {
  it("keeps every decimal of a charge", () => {
    expect(formatExact(exactOf(0.0049996))).toBe("0.0049996");
    expect(formatExact(exactOf(5e-7))).toBe("0.0000005");
    expect(formatExact(exactOf(1.5e-10))).toBe("0.00000000015");
    expect(formatExact(exactOf(-0.25))).toBe("-0.25");
    expect(formatExact(exactOf(1e21))).toBe("1000000000000000000000");
    expect(formatExact(sum(0.1, 0.2))).toBe("0.3");
  });

  it("rounds only the total, half away from zero", () => {
    expect(minorOfExact(exactOf(0.0049996), 100)).toBe(0);
    expect(minorOfExact(sum(1.2, 0.055), 100)).toBe(126);
    expect(minorOfExact(exactOf(0.005), 100)).toBe(1);
    expect(minorOfExact(exactOf(-0.005), 100)).toBe(-1);
    expect(minorOfExact(exactOf(-0.004), 100)).toBe(0);
    expect(Object.is(minorOfExact(exactOf(-0.004), 100), -0)).toBe(false);
    expect(minorOfExact(exactOf(1234.5), 1)).toBe(1235);
  });

  it("reads a day's sum as the checkpoint keeps it, either shape", () => {
    // A plain decimal string (#905), or millionths before it (#894).
    expect(formatExact(storedExact("0.0049996"))).toBe("0.0049996");
    expect(formatExact(storedExact(250_000))).toBe("0.25");
    expect(formatExact(storedExact(-5))).toBe("-0.000005");
    for (const invalid of [undefined, null, "1e5", "abc", 0.5, {}]) {
      expect(formatExact(storedExact(invalid))).toBe("0");
    }
  });

  it("bounds the decimals a sum keeps", () => {
    expect(formatExact(exactOf(1e-300))).toBe("0");
    expect(formatExact(exactOf(6e-19))).toBe("0.000000000000000001");
  });
});
