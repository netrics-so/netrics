import { CONTRAST_RECOMMENDED, contrastRatio } from "@netrics/domain";

// A brand accent from an app icon (#226): the icon's dominant colour,
// picked in the browser from its pixels (the server never decodes images,
// ADR 0015 section 5), then checked against the theme surface it is drawn
// on and, if needed, lightened or darkened until it is readable. When no
// readable colour comes out of it, the theme's own accent stays.

/** Pixels below this alpha are background, not icon. */
const MIN_ALPHA = 128;
/**
 * Chroma (max − min channel, 0–1) from which a pixel counts as a colour.
 * Chroma rather than HSL saturation: a cream or pale grey background has a
 * high HSL saturation near white, yet reads as no colour at all.
 */
const MIN_CHROMA = 0.2;
/** Lightness band (HSL, 0–1) of colourful pixels; outside is near white or black. */
const MIN_LIGHTNESS = 0.12;
const MAX_LIGHTNESS = 0.92;
/** Share of opaque pixels that must be colourful for an icon to have a colour. */
const MIN_COLOURFUL_SHARE = 0.02;

function hex(value: number): string {
  return Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");
}

export function toHex(r: number, g: number, b: number): string {
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function parseHex(color: string): [number, number, number] {
  const value = Number.parseInt(color.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** HSL of an sRGB colour, each 0–1. */
export function toHsl(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [((h * 60 + 360) % 360) / 360, s, l];
}

export function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return toHex((r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255);
}

/**
 * The dominant colour of RGBA pixels (as from a canvas), `#rrggbb`: the
 * most common colourful hue bucket (4 bits per channel), averaged.
 * Transparent, grey, near-white and near-black pixels do not vote. Null
 * when the icon has (almost) no colour, e.g. a black-and-white logo.
 */
export function dominantColor(pixels: ArrayLike<number>): string | null {
  const buckets = new Map<
    number,
    { count: number; r: number; g: number; b: number }
  >();
  let opaque = 0;
  let colourful = 0;
  for (let index = 0; index + 3 < pixels.length; index += 4) {
    const r = pixels[index]!;
    const g = pixels[index + 1]!;
    const b = pixels[index + 2]!;
    if (pixels[index + 3]! < MIN_ALPHA) continue;
    opaque += 1;
    const [, , l] = toHsl(r, g, b);
    const chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
    if (chroma < MIN_CHROMA || l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue;
    colourful += 1;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  if (opaque === 0 || colourful / opaque < MIN_COLOURFUL_SHARE) {
    return null;
  }
  let best: { count: number; r: number; g: number; b: number } | undefined;
  for (const [, bucket] of [...buckets].sort(([a], [b]) => a - b)) {
    if (!best || bucket.count > best.count) best = bucket;
  }
  return best
    ? toHex(best.r / best.count, best.g / best.count, best.b / best.count)
    : null;
}

/** Lightness steps tried, in HSL lightness units. */
const LIGHTNESS_STEP = 0.04;
const MAX_STEPS = 20;

/**
 * A readable version of `color` on `surface`: the colour itself when it
 * reaches the recommended contrast (4.5:1), else the same hue made
 * lighter (on a dark surface) or darker (on a light one) until it does.
 * Null when no such colour exists or `color` is null: the theme accent.
 */
export function readableAccent(
  color: string | null,
  surface: string,
): string | null {
  if (!color) return null;
  if (contrastRatio(color, surface) >= CONTRAST_RECOMMENDED) return color;
  const [h, s, l] = toHsl(...parseHex(color));
  const darkSurface =
    contrastRatio("#ffffff", surface) > contrastRatio("#000000", surface);
  const direction = darkSurface ? 1 : -1;
  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const lightness = l + direction * step * LIGHTNESS_STEP;
    if (lightness < 0 || lightness > 1) break;
    const candidate = fromHsl(h, s, lightness);
    if (contrastRatio(candidate, surface) >= CONTRAST_RECOMMENDED) {
      return candidate;
    }
  }
  return null;
}

/** The accent for a brand dashboard from its icon's pixels. */
export function brandAccent(
  pixels: ArrayLike<number>,
  surface: string,
): string | null {
  return readableAccent(dominantColor(pixels), surface);
}
