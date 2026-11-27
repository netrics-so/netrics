import { describe, expect, it } from "vitest";

import {
  addExact,
  exactOfToken,
  formatExact,
  MAX_SCALE,
  minorOfExact,
  storedExact,
  ZERO,
  type ExactAmount,
} from "./exact-cost.js";

const token = (text: string): ExactAmount => {
  const amount = exactOfToken(text);
  if (amount === null) throw new Error(`not an amount: ${text}`);
  return amount;
};
const sum = (...tokens: string[]) =>
  tokens.reduce((total, text) => addExact(total, token(text)), ZERO);
/** Through the checkpoint: written as text, read back. */
const roundTrip = (amount: ExactAmount) => storedExact(formatExact(amount));

describe("exact Vercel cost sums (#905, #925)", () => {
  it("keeps every digit of a JSON number's text", () => {
    expect(formatExact(token("0.0049996"))).toBe("0.0049996");
    expect(formatExact(token("1.00499999999999999"))).toBe(
      "1.00499999999999999",
    );
    expect(formatExact(token("5e-7"))).toBe("0.0000005");
    expect(formatExact(token("1.5E-10"))).toBe("0.00000000015");
    expect(formatExact(token("-0.25"))).toBe("-0.25");
    expect(formatExact(token("1e21"))).toBe("1000000000000000000000");
    expect(formatExact(token("0.50"))).toBe("0.5");
    expect(formatExact(token("-0"))).toBe("0");
    expect(formatExact(sum("0.1", "0.2"))).toBe("0.3");
  });

  it("refuses what is no JSON number or beyond the bounds", () => {
    for (const text of ["", "1.", ".5", "+1", "01", "1e", "NaN", "0x10"]) {
      expect(exactOfToken(text)).toBeNull();
    }
    expect(exactOfToken("1e-400")).toBeNull();
    expect(exactOfToken("1e400")).toBeNull();
    expect(exactOfToken(`1e-${MAX_SCALE}`)).not.toBeNull();
    expect(exactOfToken(`1e-${MAX_SCALE + 1}`)).toBeNull();
    // Zeros past the bound are not digits of the amount.
    expect(formatExact(token(`1${"0".repeat(10)}e-${MAX_SCALE + 10}`))).toBe(
      `0.${"0".repeat(MAX_SCALE - 1)}1`,
    );
  });

  it("rounds only the total, half away from zero", () => {
    expect(minorOfExact(token("0.0049996"), 100)).toBe(0);
    expect(minorOfExact(token("1.00499999999999999"), 100)).toBe(100);
    expect(minorOfExact(sum("1.2", "0.055"), 100)).toBe(126);
    expect(minorOfExact(token("0.005"), 100)).toBe(1);
    expect(minorOfExact(token("-0.005"), 100)).toBe(-1);
    expect(Object.is(minorOfExact(token("-0.004"), 100), -0)).toBe(false);
    expect(minorOfExact(token("1234.5"), 1)).toBe(1235);
  });

  it("keeps full scale through addition and the checkpoint", () => {
    const total = sum("0.004999999999999999", "6e-19");
    expect(formatExact(total)).toBe("0.0049999999999999996");
    expect(minorOfExact(total, 100)).toBe(0);
    const resumed = addExact(
      roundTrip(token("0.004999999999999999")),
      token("6e-19"),
    );
    expect(minorOfExact(roundTrip(resumed), 100)).toBe(0);
    const tiny = token(`1e-${MAX_SCALE}`);
    expect(roundTrip(tiny)).toEqual(tiny);
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
});
