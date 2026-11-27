// Exact decimal sums of Vercel's charges (#905, #925).
//
// Vercel's FOCUS export sends costs as JSON numbers with as many decimals
// as a charge has ($0.0049996). They are read from the number's own text
// in the export, never through a double, and summed as exact decimals at
// full scale: nothing is rounded per charge, per day or in the checkpoint.
// Only a cumulative total is rounded, to the currency's minor unit
// (ADR 0008). The checkpoint keeps a day's sum as a plain decimal string;
// one taken before #905 kept it as an integer number of millionths, which
// is read as such.

/** An exact decimal: `digits` × 10^-`scale`. */
export interface ExactAmount {
  digits: bigint;
  scale: number;
}

/**
 * The most fraction digits, and integer digits, an amount of the export may
 * have; a number beyond them is not a cost (an invalid answer). Far beyond
 * any currency's precision, these bounds keep every sum, and so the
 * checkpoint, small: a sum has at most MAX_SCALE fraction digits.
 */
export const MAX_SCALE = 64;
export const MAX_WHOLE_DIGITS = 30;

export const ZERO: ExactAmount = { digits: 0n, scale: 0 };

/** A JSON number's text (RFC 8259 §6). */
const JSON_NUMBER = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/** A day's sum as the checkpoint keeps it. */
const PLAIN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Longest stored sum read: a sign, the digits and the point. */
const MAX_STORED_LENGTH = MAX_WHOLE_DIGITS + 10 + MAX_SCALE + 2;

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** `value` / 10^`by`, half away from zero. */
function divideRounded(value: bigint, by: number): bigint {
  if (by <= 0) return value * pow10(-by);
  const divisor = pow10(by);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  let quotient = magnitude / divisor;
  if ((magnitude % divisor) * 2n >= divisor) quotient += 1n;
  return negative ? -quotient : quotient;
}

/** Trailing zero fraction digits dropped: the same amount, a shorter form. */
function normalized(amount: ExactAmount): ExactAmount {
  let { digits, scale } = amount;
  while (scale > 0 && digits % 10n === 0n) {
    digits /= 10n;
    scale -= 1;
  }
  return { digits, scale };
}

/**
 * The amount a JSON number's text stands for, exactly ("1.00499999999999999"
 * stays that, where a double would be 1.005), or null when it is no JSON
 * number or exceeds MAX_SCALE or MAX_WHOLE_DIGITS.
 */
export function exactOfToken(token: string): ExactAmount | null {
  if (token.length > 400) return null;
  const match = JSON_NUMBER.exec(token);
  if (!match) return null;
  const [, sign, whole = "0", fraction = "", exponentText = "0"] = match;
  const exponent = Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return null;
  const significant = `${whole}${fraction}`.replace(/^0+/, "");
  if (significant === "") return ZERO;
  const scale = fraction.length - exponent;
  // Digits left of the point once the exponent is applied.
  if (significant.length - scale > MAX_WHOLE_DIGITS) return null;
  if (scale > MAX_SCALE) {
    // Only zeros may be dropped: "0.5e-70" is beyond the bound, "1.50e-63" is not.
    const kept = normalized({ digits: BigInt(significant), scale });
    if (kept.scale > MAX_SCALE) return null;
    return {
      digits: sign === "-" ? -kept.digits : kept.digits,
      scale: kept.scale,
    };
  }
  const digits =
    scale < 0 ? BigInt(significant) * pow10(-scale) : BigInt(significant);
  return normalized({
    digits: sign === "-" ? -digits : digits,
    scale: Math.max(scale, 0),
  });
}

export function addExact(a: ExactAmount, b: ExactAmount): ExactAmount {
  const scale = Math.max(a.scale, b.scale);
  return normalized({
    digits:
      a.digits * pow10(scale - a.scale) + b.digits * pow10(scale - b.scale),
    scale,
  });
}

/** A plain decimal string, as the checkpoint keeps it ("-0.0049996"). */
export function formatExact(amount: ExactAmount): string {
  const negative = amount.digits < 0n;
  const text = (negative ? -amount.digits : amount.digits)
    .toString()
    .padStart(amount.scale + 1, "0");
  const whole = text.slice(0, text.length - amount.scale);
  const fraction = text.slice(text.length - amount.scale).replace(/0+$/, "");
  const plain = fraction ? `${whole}.${fraction}` : whole;
  return negative && /[1-9]/.test(plain) ? `-${plain}` : plain;
}

/**
 * A day's sum as the checkpoint keeps it: a plain decimal string, at full
 * scale, or (a checkpoint from before #905) an integer number of
 * millionths. Anything else is no cost.
 */
export function storedExact(value: unknown): ExactAmount {
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? normalized({ digits: BigInt(value), scale: 6 })
      : ZERO;
  }
  if (typeof value !== "string" || value.length > MAX_STORED_LENGTH) {
    return ZERO;
  }
  const match = PLAIN.exec(value);
  if (!match) return ZERO;
  const [, sign, whole, fraction = ""] = match;
  const digits = BigInt(`${whole}${fraction}`);
  return normalized({
    digits: sign === "-" ? -digits : digits,
    scale: fraction.length,
  });
}

/** An amount in minor units (`perUnit` of them to a unit), half away from zero. */
export function minorOfExact(amount: ExactAmount, perUnit: number): number {
  const minor = Number(
    divideRounded(amount.digits * BigInt(perUnit), amount.scale),
  );
  return minor === 0 ? 0 : minor;
}
