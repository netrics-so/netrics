import { STUDIO_FONT_SCALES } from "./studio-layout.js";

// Dashboard themes (ADR 0015, section 6). A theme is a fixed set of tokens;
// every renderer (web, kiosk, tvOS) reads the same tokens, so they are plain
// data here and the device payload carries them resolved (#219).

/** The colour tokens of a theme, each `#rrggbb` (lowercase). */
export const THEME_COLOR_TOKENS = [
  "background",
  "surface",
  "border",
  "text",
  "label",
  "muted",
  "accent",
  "up",
  "down",
  "warning",
  "chartLine",
  "chartFill",
] as const;

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];

/**
 * Text size multipliers a theme may choose; never below the minimums. The
 * same list studioLayout scales text by.
 */
export const THEME_FONT_SCALES = STUDIO_FONT_SCALES;

export type ThemeFontScale = (typeof THEME_FONT_SCALES)[number];

export type ThemeTokens = Record<ThemeColorToken, string> & {
  fontScale: ThemeFontScale;
};

export const BUILTIN_THEME_KEYS = [
  "netrics_dark",
  "light",
  "high_contrast",
  "midnight",
  "paper",
] as const;

export type BuiltinThemeKey = (typeof BUILTIN_THEME_KEYS)[number];

/** The default theme, and the one every existing dashboard migrates to. */
export const DEFAULT_THEME_KEY: BuiltinThemeKey = "netrics_dark";

export interface BuiltinTheme {
  key: BuiltinThemeKey;
  name: string;
  tokens: ThemeTokens;
}

export const BUILTIN_THEMES: Readonly<Record<BuiltinThemeKey, BuiltinTheme>> = {
  // Today's TV palette, value for value: apps/web globals.css (.tv,
  // .tile, .sparkline) and the tvOS `Theme` enum. chartFill is new (bars,
  // area under lines) and takes the web's primary button blue.
  netrics_dark: {
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
      chartLine: "#5c6470",
      chartFill: "#2f5fd0",
      fontScale: 1,
    },
  },
  light: {
    key: "light",
    name: "Light",
    tokens: {
      background: "#eef0f3",
      surface: "#ffffff",
      border: "#d5d9e0",
      text: "#14171c",
      label: "#343a44",
      muted: "#5a616c",
      accent: "#2f5fd0",
      up: "#1a7f37",
      down: "#c22f2f",
      warning: "#8f5f00",
      chartLine: "#7a828e",
      chartFill: "#9db6ee",
      fontScale: 1,
    },
  },
  high_contrast: {
    key: "high_contrast",
    name: "High contrast",
    tokens: {
      background: "#000000",
      surface: "#000000",
      border: "#ffffff",
      text: "#ffffff",
      label: "#ffffff",
      muted: "#d9d9d9",
      accent: "#ffd60a",
      up: "#5cf08a",
      down: "#ff8080",
      warning: "#ffd60a",
      chartLine: "#ffffff",
      chartFill: "#ffd60a",
      fontScale: 1.15,
    },
  },
  midnight: {
    key: "midnight",
    name: "Midnight",
    tokens: {
      background: "#050a1a",
      surface: "#0c1630",
      border: "#1f2d52",
      text: "#e8eefc",
      label: "#c2cdec",
      muted: "#8d9cc2",
      accent: "#5cc8ff",
      up: "#7ee2a8",
      down: "#ff9e9e",
      warning: "#f2c14e",
      chartLine: "#6b7fb3",
      chartFill: "#2c4c94",
      fontScale: 1,
    },
  },
  paper: {
    key: "paper",
    name: "Paper",
    tokens: {
      background: "#f2ede2",
      surface: "#fbf8f1",
      border: "#ddd3bf",
      text: "#2b2620",
      label: "#474036",
      muted: "#6b6252",
      accent: "#a64b22",
      up: "#2e6e31",
      down: "#a8281f",
      warning: "#865600",
      chartLine: "#8c7e68",
      chartFill: "#dcc19c",
      fontScale: 1,
    },
  },
};

export function isBuiltinThemeKey(value: string): value is BuiltinThemeKey {
  return (BUILTIN_THEME_KEYS as readonly string[]).includes(value);
}

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** A `#rrggbb` colour in lowercase, the only form tokens are stored in. */
export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a `#rrggbb` colour (0 black … 1 white). */
export function relativeLuminance(hex: string): number {
  if (!HEX_COLOR.test(hex.toLowerCase())) {
    throw new Error(`not a #rrggbb colour: ${hex}`);
  }
  const value = Number.parseInt(hex.slice(1), 16);
  const r = channel((value >> 16) & 0xff);
  const g = channel((value >> 8) & 0xff);
  const b = channel(value & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio of two colours, 1 … 21, order-independent. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

/** Below this the server refuses a theme: unreadable on a TV. */
export const CONTRAST_MINIMUM = 3;
/** Below this the editor and the API warn (WCAG AA for normal text). */
export const CONTRAST_RECOMMENDED = 4.5;

export type ContrastLevel = "pass" | "warn" | "fail";

export interface ContrastCheck {
  foreground: ThemeColorToken;
  background: ThemeColorToken;
  /** Rounded down to two decimals, so a shown 4.49 never passes as 4.5. */
  ratio: number;
  level: ContrastLevel;
}

/**
 * The token pairs that carry text: values, titles and secondary lines on a
 * widget, values on the canvas, and the accent where it is text (the clock,
 * highlights).
 */
export const CONTRAST_PAIRS: ReadonlyArray<
  readonly [ThemeColorToken, ThemeColorToken]
> = [
  ["text", "surface"],
  ["label", "surface"],
  ["muted", "surface"],
  ["text", "background"],
  ["accent", "surface"],
];

export function contrastLevel(ratio: number): ContrastLevel {
  if (ratio < CONTRAST_MINIMUM) {
    return "fail";
  }
  return ratio < CONTRAST_RECOMMENDED ? "warn" : "pass";
}

function check(
  foreground: ThemeColorToken,
  background: ThemeColorToken,
  ratio: number,
): ContrastCheck {
  const floored = Math.floor(ratio * 100) / 100;
  return {
    foreground,
    background,
    ratio: floored,
    level: contrastLevel(ratio),
  };
}

/** Every text pair of a theme with its ratio and level. */
export function checkThemeContrast(
  tokens: Pick<ThemeTokens, ThemeColorToken>,
): ContrastCheck[] {
  return CONTRAST_PAIRS.map(([foreground, background]) =>
    check(
      foreground,
      background,
      contrastRatio(tokens[foreground], tokens[background]),
    ),
  );
}

/**
 * A brand accent that overrides the theme's (ADR 0015, section 1), checked
 * against the theme surface it is drawn on.
 */
export function checkAccentContrast(
  accent: string,
  tokens: Pick<ThemeTokens, "surface">,
): ContrastCheck {
  return check("accent", "surface", contrastRatio(accent, tokens.surface));
}
