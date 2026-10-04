import { describe, expect, it } from "vitest";

import { BUILTIN_THEMES } from "@netrics/domain";

import { resolveDashboardTheme, themeStyle } from "./studio-theme";

const builtin = (key: string | null) => ({
  themeBuiltin: key,
  themeId: null,
  accentColor: null,
});

describe("resolveDashboardTheme", () => {
  it("uses the built-in, netrics Dark by default", () => {
    expect(resolveDashboardTheme(builtin("paper"), null)).toEqual({
      name: "Paper",
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
    expect(resolveDashboardTheme(settings, custom)).toEqual(custom);
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
    expect(style["--t-chart-fill"]).toBe("#2f5fd0");
    expect(style["--t-font-scale"]).toBe("1");
    expect(Object.keys(style)).toHaveLength(13);
  });
});
