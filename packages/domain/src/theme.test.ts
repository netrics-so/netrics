import { describe, expect, it } from "vitest";

import {
  BUILTIN_THEMES,
  BUILTIN_THEME_KEYS,
  CONTRAST_RECOMMENDED,
  THEME_COLOR_TOKENS,
  THEME_FONT_SCALES,
  checkAccentContrast,
  checkThemeContrast,
  contrastLevel,
  contrastRatio,
  isBuiltinThemeKey,
  isHexColor,
  relativeLuminance,
} from "./theme.js";

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("matches the WCAG formula for primaries", () => {
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 4);
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 4);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 4);
  });

  it("refuses anything but #rrggbb", () => {
    expect(() => relativeLuminance("#fff")).toThrow();
    expect(() => relativeLuminance("red")).toThrow();
  });
});

describe("contrastRatio", () => {
  // Reference values from the WebAIM contrast checker.
  it.each([
    ["#000000", "#ffffff", 21],
    ["#ffffff", "#ffffff", 1],
    ["#767676", "#ffffff", 4.54],
    ["#777777", "#ffffff", 4.47],
    ["#949494", "#ffffff", 3.03],
    ["#0000ff", "#ffffff", 8.59],
    ["#ff0000", "#ffffff", 4],
  ])("%s on %s is %d:1", (a, b, expected) => {
    expect(contrastRatio(a, b)).toBeCloseTo(expected, 1);
    expect(contrastRatio(b, a)).toBeCloseTo(expected, 1);
  });

  it("puts #767676 above and #777777 below AA on white", () => {
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });
});

describe("contrastLevel", () => {
  it("fails below 3, warns below 4.5, passes from 4.5", () => {
    expect(contrastLevel(2.99)).toBe("fail");
    expect(contrastLevel(3)).toBe("warn");
    expect(contrastLevel(4.49)).toBe("warn");
    expect(contrastLevel(4.5)).toBe("pass");
  });
});

describe("checkThemeContrast", () => {
  it("checks the text pairs and rounds ratios down", () => {
    const checks = checkThemeContrast({
      ...BUILTIN_THEMES.netrics_dark.tokens,
      muted: "#3a404a",
    });
    expect(checks.map((c) => `${c.foreground}/${c.background}`)).toEqual([
      "text/surface",
      "label/surface",
      "muted/surface",
      "text/background",
      "accent/surface",
    ]);
    const muted = checks.find((c) => c.foreground === "muted")!;
    expect(muted.level).toBe("fail");
    expect(muted.ratio).toBe(Math.floor(muted.ratio * 100) / 100);
  });

  it("checks a brand accent against the surface", () => {
    expect(checkAccentContrast("#11141a", { surface: "#11141a" }).level).toBe(
      "fail",
    );
    expect(checkAccentContrast("#ffffff", { surface: "#11141a" }).level).toBe(
      "pass",
    );
  });
});

describe("built-in themes", () => {
  it("are the five keys of ADR 0015", () => {
    expect(Object.keys(BUILTIN_THEMES)).toEqual([...BUILTIN_THEME_KEYS]);
    for (const key of BUILTIN_THEME_KEYS) {
      expect(BUILTIN_THEMES[key].key).toBe(key);
      expect(isBuiltinThemeKey(key)).toBe(true);
    }
    expect(isBuiltinThemeKey("nope")).toBe(false);
  });

  it("have every token in its stored form", () => {
    for (const theme of Object.values(BUILTIN_THEMES)) {
      expect(Object.keys(theme.tokens).sort()).toEqual(
        [...THEME_COLOR_TOKENS, "fontScale"].sort(),
      );
      for (const token of THEME_COLOR_TOKENS) {
        expect(isHexColor(theme.tokens[token])).toBe(true);
      }
      expect(THEME_FONT_SCALES).toContain(theme.tokens.fontScale);
    }
  });

  it.each(BUILTIN_THEME_KEYS)("%s passes AA for every text pair", (key) => {
    for (const check of checkThemeContrast(BUILTIN_THEMES[key].tokens)) {
      expect(check.ratio).toBeGreaterThanOrEqual(CONTRAST_RECOMMENDED);
    }
  });

  it("netrics Dark is today's TV palette", () => {
    // apps/web/src/app/globals.css (.tv, .tile, .sparkline) and the tvOS
    // Theme enum (apps/tvos/NetricsTV/NetricsTVApp.swift).
    expect(BUILTIN_THEMES.netrics_dark).toEqual({
      key: "netrics_dark",
      name: "netrics Dark",
      tokens: {
        background: "#07090c",
        surface: "#11141a",
        border: "#23272e",
        text: "#e6e9ed",
        label: "#c5cad3",
        muted: "#8a919c",
        accent: "#7aa2f7",
        up: "#9fd6a8",
        down: "#f0a3a3",
        warning: "#e3b341",
        chartLine: "#7aa2f7",
        chartFill: "#7aa2f7",
        fontScale: 1,
      },
    });
  });
});
