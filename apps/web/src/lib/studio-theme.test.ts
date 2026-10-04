import { describe, expect, it } from "vitest";

import { BUILTIN_THEMES } from "@netrics/domain";

import {
  resolveDashboardTheme,
  themeStyle,
  themeSurface,
} from "./studio-theme";

const builtin = (key: string | null) => ({
  themeBuiltin: key,
  themeId: null,
  accentColor: null,
});

describe("resolveDashboardTheme", () => {
  it("uses the built-in, netrics Dark by default", () => {
    expect(resolveDashboardTheme(builtin("paper"), null)).toEqual({
      name: "Paper",
      builtin: "paper",
      tokens: BUILTIN_THEMES.paper.tokens,
    });
    expect(resolveDashboardTheme(builtin(null), null).name).toBe(
      "netrics Dark",
    );
    expect(resolveDashboardTheme(builtin("gone"), null).name).toBe(
      "netrics Dark",
    );
  });

  it("uses the custom theme, and netrics Dark when it could not be loaded", () => {
    const custom = {
      name: "Wurfel",
      tokens: { ...BUILTIN_THEMES.midnight.tokens, accent: "#ff8800" },
    };
    const settings = {
      themeBuiltin: null,
      themeId: "3f0f3c55-77b8-4a5f-a3a5-5f6b2a7f1e01",
      accentColor: null,
    };
    expect(resolveDashboardTheme(settings, custom)).toEqual({
      ...custom,
      builtin: null,
    });
    expect(resolveDashboardTheme(settings, null).builtin).toBe("netrics_dark");
    expect(resolveDashboardTheme(settings, null).name).toBe("netrics Dark");
  });

  it("lets the brand accent replace the theme's", () => {
    const theme = resolveDashboardTheme(
      { themeBuiltin: "light", themeId: null, accentColor: "#A64B22" },
      null,
    );
    expect(theme.tokens.accent).toBe("#a64b22");
    expect(theme.tokens.text).toBe(BUILTIN_THEMES.light.tokens.text);
  });
});

describe("themeStyle", () => {
  it("exposes every token as a CSS variable", () => {
    const style = themeStyle(BUILTIN_THEMES.netrics_dark.tokens) as Record<
      string,
      string
    >;
    expect(style["--t-background"]).toBe("#07090c");
    expect(style["--t-chart-fill"]).toBe("#7aa2f7");
    expect(style["--t-font-scale"]).toBe("1");
    expect(Object.keys(style)).toHaveLength(13);
  });
});

describe("themeSurface (ADR 0018, section 5)", () => {
  it("layers dark themes with hairline borders and keeps the others flat", () => {
    expect(themeSurface(BUILTIN_THEMES.netrics_dark.tokens)).toBe("layered");
    expect(themeSurface(BUILTIN_THEMES.midnight.tokens)).toBe("layered");
    expect(themeSurface(BUILTIN_THEMES.light.tokens)).toBe("flat");
    expect(themeSurface(BUILTIN_THEMES.paper.tokens)).toBe("flat");
    expect(themeSurface(BUILTIN_THEMES.high_contrast.tokens)).toBe("flat");
  });

  it("decides a custom theme by its tokens", () => {
    const dark = BUILTIN_THEMES.netrics_dark.tokens;
    expect(themeSurface({ ...dark, border: "#ffffff" })).toBe("flat");
    expect(themeSurface({ ...dark, background: "#fafafa" })).toBe("flat");
    expect(themeSurface({ ...dark, surface: "#202020" })).toBe("layered");
  });
});
