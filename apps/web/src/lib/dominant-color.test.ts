import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  BUILTIN_THEMES,
  CONTRAST_RECOMMENDED,
  contrastRatio,
} from "@netrics/domain";

import {
  brandAccent,
  dominantColor,
  fromHsl,
  readableAccent,
  toHsl,
} from "./dominant-color";

/** RGBA pixels: `count` of each colour, in order. */
function pixels(
  ...runs: Array<[number, [number, number, number, number?]]>
): Uint8ClampedArray {
  const values: number[] = [];
  for (const [count, [r, g, b, a = 255]] of runs) {
    for (let index = 0; index < count; index += 1) values.push(r, g, b, a);
  }
  return Uint8ClampedArray.from(values);
}

const DARK = BUILTIN_THEMES.netrics_dark.tokens.surface;
const LIGHT = BUILTIN_THEMES.light.tokens.surface;

describe("dominantColor", () => {
  it("picks the most common colour, averaged within its bucket", () => {
    const color = dominantColor(
      pixels([60, [30, 120, 230]], [40, [28, 118, 228]], [30, [230, 60, 40]]),
    );
    expect(color).toBe("#1d77e5");
  });

  it("ignores transparent corners, white backgrounds and grey shadows", () => {
    const color = dominantColor(
      pixels(
        [500, [0, 0, 0, 0]],
        [400, [255, 255, 255]],
        [300, [128, 128, 128]],
        [20, [10, 10, 10]],
        [50, [240, 90, 40]],
      ),
    );
    expect(color).toBe("#f05a28");
  });

  it("treats a cream background as no colour and finds the accent on it", () => {
    // Like an app icon: a cream tile, black glyphs, a small teal mark.
    const color = dominantColor(
      pixels([700, [239, 227, 208]], [250, [24, 24, 24]], [50, [64, 160, 150]]),
    );
    expect(color).toBe("#40a096");
  });

  it("is null for an icon without colour or without opaque pixels", () => {
    expect(
      dominantColor(pixels([100, [255, 255, 255]], [100, [0, 0, 0]])),
    ).toBeNull();
    expect(dominantColor(pixels([10, [200, 30, 30, 0]]))).toBeNull();
    expect(dominantColor([])).toBeNull();
    // A trace of colour (below 0.5 %) is not the icon's colour.
    expect(
      dominantColor(pixels([1000, [250, 250, 250]], [4, [0, 200, 0]])),
    ).toBeNull();
  });
});

describe("readableAccent", () => {
  it("keeps a colour that already reads well on the surface", () => {
    expect(readableAccent("#4f8cff", DARK)).toBe("#4f8cff");
  });

  it("lightens a dark brand colour on a dark theme and darkens a light one on a light theme", () => {
    const navy = readableAccent("#1b2a6b", DARK)!;
    expect(navy).not.toBe("#1b2a6b");
    expect(contrastRatio(navy, DARK)).toBeGreaterThanOrEqual(
      CONTRAST_RECOMMENDED,
    );
    const [hue] = toHsl(0x1b, 0x2a, 0x6b);
    const [navyHue] = toHsl(
      ...((navy.match(/[0-9a-f]{2}/g) ?? []).map((part) =>
        Number.parseInt(part, 16),
      ) as [number, number, number]),
    );
    expect(Math.abs(navyHue - hue)).toBeLessThan(0.02);

    const lemon = readableAccent("#fff176", LIGHT)!;
    expect(contrastRatio(lemon, LIGHT)).toBeGreaterThanOrEqual(
      CONTRAST_RECOMMENDED,
    );
  });

  it("falls back to the theme accent (null) without a colour", () => {
    expect(readableAccent(null, DARK)).toBeNull();
  });
});

describe("brandAccent", () => {
  it("turns an icon into an accent every built-in theme surface can carry", () => {
    const icon = pixels([200, [0, 0, 0, 0]], [800, [24, 96, 200]]);
    for (const theme of Object.values(BUILTIN_THEMES)) {
      const accent = brandAccent(icon, theme.tokens.surface);
      if (accent !== null) {
        expect(
          contrastRatio(accent, theme.tokens.surface),
          `${theme.name}`,
        ).toBeGreaterThanOrEqual(CONTRAST_RECOMMENDED);
      }
    }
    expect(brandAccent(icon, DARK)).not.toBeNull();
  });
});

/**
 * The real App Store icons (#248): the 1024 px PNGs from the public iTunes
 * lookup, scaled to the 64 × 64 sample the browser reads, as raw RGBA.
 */
function icon(name: "voila" | "wurfel" | "paperstand"): Uint8Array {
  return gunzipSync(
    readFileSync(new URL(`./fixtures/${name}-64.rgba.gz`, import.meta.url)),
  );
}

describe("brandAccent on real app icons", () => {
  it("voilà: the purple background, lightened to read on netrics Dark", () => {
    expect(dominantColor(icon("voila"))).toBe("#4f35c5");
    const accent = brandAccent(icon("voila"), DARK);
    expect(accent).toBe("#8572d9");
    expect(contrastRatio(accent!, DARK)).toBeGreaterThanOrEqual(
      CONTRAST_RECOMMENDED,
    );
  });

  it("Wurfel: the green tile, not the cream background or black squares", () => {
    expect(dominantColor(icon("wurfel"))).toBe("#35846a");
    const accent = brandAccent(icon("wurfel"), DARK);
    expect(accent).toBe("#3b9376");
    expect(contrastRatio(accent!, DARK)).toBeGreaterThanOrEqual(
      CONTRAST_RECOMMENDED,
    );
  });

  it("Paperstand: the copper dot next to the P", () => {
    expect(dominantColor(icon("paperstand"))).toBe("#946445");
    const accent = brandAccent(icon("paperstand"), DARK);
    expect(accent).toBe("#af7753");
    expect(contrastRatio(accent!, DARK)).toBeGreaterThanOrEqual(
      CONTRAST_RECOMMENDED,
    );
  });

  it("gives a readable accent (or the theme's) on every built-in theme", () => {
    for (const name of ["voila", "wurfel", "paperstand"] as const) {
      for (const theme of Object.values(BUILTIN_THEMES)) {
        const accent = brandAccent(icon(name), theme.tokens.surface);
        if (accent !== null) {
          expect(
            contrastRatio(accent, theme.tokens.surface),
            `${name} on ${theme.name}`,
          ).toBeGreaterThanOrEqual(CONTRAST_RECOMMENDED);
        }
      }
    }
  });
});

describe("HSL round trip", () => {
  it("returns the same colour", () => {
    for (const color of ["#1f79e7", "#f05a28", "#2bc48a", "#7a3cff"]) {
      const [r, g, b] = (color.match(/[0-9a-f]{2}/g) ?? []).map((part) =>
        Number.parseInt(part, 16),
      ) as [number, number, number];
      expect(fromHsl(...toHsl(r, g, b))).toBe(color);
    }
  });
});
