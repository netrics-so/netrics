// Exact decimal sums of Vercel's charges (#905).
//
// Vercel's FOCUS export sends costs as JSON numbers with as many decimals
// as a charge has ($0.0049996). They are summed as exact decimals, never as
// floating point and never rounded per charge: only a cumulative total is
// rounded, to the currency's minor unit (ADR 0008). The checkpoint keeps a
// day's sum as a plain decimal string; one taken before #905 kept it as an
// integer number of millionths, which is read as such.

/** An exact decimal: `digits` × 10^-`scale`. */
export interface ExactAmount {
  digits: bigint;
  scale: number;
}

/**
 * Fraction digits kept at most. A double's shortest form can have hundreds
 * (1e-300); anything past this is far below a minor unit, and the bound
 * keeps the checkpoint small. Beyond it, rounding is half away from zero.
 */
export const MAX_SCALE = 18;

const ZERO: ExactAmount = { digits: 0n, scale: 0 };

/** A JavaScript number's shortest decimal form: "0.1", "5e-7", "1.5e+21". */
const NUMBER_FORM = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

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

function bounded(amount: ExactAmount): ExactAmount {
  if (amount.scale <= MAX_SCALE) return amount;
  return {
    digits: divideRounded(amount.digits, amount.scale - MAX_SCALE),
    scale: MAX_SCALE,
  };
}

/**
 * The amount a finite number stands for, exactly as its shortest decimal
 * form writes it: the number a JSON literal like 0.0049996 was parsed to
 * gives back 0.0049996, not the binary fraction nearest to it.
 */
export function exactOf(value: number): ExactAmount {
  if (!Number.isFinite(value)) return ZERO;
  const match = NUMBER_FORM.exec(String(value));
  if (!match) return ZERO;
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  let digits = BigInt(`${whole}${fraction}`);
  let scale = fraction.length - Number(exponent);
  if (scale < 0) {
    digits *= pow10(-scale);
    scale = 0;
  }
  return bounded({ digits: sign === "-" ? -digits : digits, scale });
}

export function addExact(a: ExactAmount, b: ExactAmount): ExactAmount {
  const scale = Math.max(a.scale, b.scale);
  return {
    digits:
      a.digits * pow10(scale - a.scale) + b.digits * pow10(scale - b.scale),
    scale,
  };
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

const PLAIN = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * A day's sum as the checkpoint keeps it: a plain decimal string, or (a
 * checkpoint from before #905) an integer number of millionths. Anything
 * else is no cost.
 */
export function storedExact(value: unknown): ExactAmount {
  if (typeof value === "number") {
    return Number.isSafeInteger(value)
      ? { digits: BigInt(value), scale: 6 }
      : ZERO;
  }
  if (typeof value !== "string" || value.length > 64) return ZERO;
  const match = PLAIN.exec(value);
  if (!match) return ZERO;
  const [, sign, whole, fraction = ""] = match;
  const digits = BigInt(`${whole}${fraction}`);
  return bounded({
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
