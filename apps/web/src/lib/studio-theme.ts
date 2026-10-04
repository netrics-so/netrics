import type { CSSProperties } from "react";

import type { DashboardSettings } from "@netrics/contracts";
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_KEY,
  isBuiltinThemeKey,
  isHexColor,
  type ThemeTokens,
} from "@netrics/domain";

// Dashboard themes on the web (ADR 0015, section 6): a dashboard's settings
// resolve to one set of tokens, which reach every widget as CSS custom
// properties (--t-*). Widgets never hard-code a colour.

export interface ResolvedTheme {
  name: string;
  tokens: ThemeTokens;
}

/**
 * The tokens a dashboard is shown with: its custom theme when it has one
 * (and it could be loaded), else its built-in, else netrics Dark; the brand
 * accent replaces the theme's accent.
 */
export function resolveDashboardTheme(
  settings: Pick<DashboardSettings, "themeBuiltin" | "themeId" | "accentColor">,
  custom: { name: string; tokens: ThemeTokens } | null,
): ResolvedTheme {
  const base =
    settings.themeId && custom
      ? custom
      : BUILTIN_THEMES[
          settings.themeBuiltin && isBuiltinThemeKey(settings.themeBuiltin)
            ? settings.themeBuiltin
            : DEFAULT_THEME_KEY
        ];
  const accent =
    settings.accentColor && isHexColor(settings.accentColor.toLowerCase())
      ? settings.accentColor.toLowerCase()
      : null;
  return {
    name: base.name,
    tokens: accent ? { ...base.tokens, accent } : base.tokens,
  };
}

/** A theme's tokens as CSS custom properties. */
export function themeStyle(tokens: ThemeTokens): CSSProperties {
  return {
    "--t-background": tokens.background,
    "--t-surface": tokens.surface,
    "--t-border": tokens.border,
    "--t-text": tokens.text,
    "--t-label": tokens.label,
    "--t-muted": tokens.muted,
    "--t-accent": tokens.accent,
    "--t-up": tokens.up,
    "--t-down": tokens.down,
    "--t-warning": tokens.warning,
    "--t-chart-line": tokens.chartLine,
    "--t-chart-fill": tokens.chartFill,
    "--t-font-scale": String(tokens.fontScale),
  } as CSSProperties;
}
