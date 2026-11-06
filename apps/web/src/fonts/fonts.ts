import localFont from "next/font/local";

/*
 * Self-hosted fonts (ADR 0018 section 3): the content security policy
 * allows fonts from 'self' only and builds never touch the network, so the
 * woff2 files are vendored here with their OFL licences. They are the latin
 * and latin-ext subsets of the variable fonts from @fontsource-variable
 * (version 5.3.0): manrope, ibm-plex-sans and jetbrains-mono.
 *
 * next/font/local gives every call its own hashed family name and cannot
 * set unicode-range per file, so each subset is its own call with its range
 * (the latin and latin-ext ranges of Fontsource; next/font needs literals);
 * globals.css joins them into one stack (--font-admin, --font-tv,
 * --font-mono). Fallback metrics are off: a stack of two families cannot
 * place the generated fallback between them.
 */

/** Admin: Manrope, variable 200–800. */
const manrope = localFont({
  src: "./manrope/manrope-latin-wght-normal.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-manrope",
  adjustFontFallback: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const manropeExt = localFont({
  src: "./manrope/manrope-latin-ext-wght-normal.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-manrope-ext",
  adjustFontFallback: false,
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

/** Web TV rendering: IBM Plex Sans, variable 100–700 (not applied yet). */
const plex = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-latin-wght-normal.woff2",
  weight: "100 700",
  style: "normal",
  variable: "--font-plex",
  adjustFontFallback: false,
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const plexExt = localFont({
  src: "./ibm-plex-sans/ibm-plex-sans-latin-ext-wght-normal.woff2",
  weight: "100 700",
  style: "normal",
  variable: "--font-plex-ext",
  adjustFontFallback: false,
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

/** Codes and keys: JetBrains Mono, variable 100–800. */
const jetbrainsMono = localFont({
  src: "./jetbrains-mono/jetbrains-mono-latin-wght-normal.woff2",
  weight: "100 800",
  style: "normal",
  variable: "--font-jetbrains-mono",
  adjustFontFallback: false,
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const jetbrainsMonoExt = localFont({
  src: "./jetbrains-mono/jetbrains-mono-latin-ext-wght-normal.woff2",
  weight: "100 800",
  style: "normal",
  variable: "--font-jetbrains-mono-ext",
  adjustFontFallback: false,
  preload: false,
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
    },
  ],
});

/** The classes that define the font variables, for the root element. */
export const fontVariables = [
  manrope,
  manropeExt,
  plex,
  plexExt,
  jetbrainsMono,
  jetbrainsMonoExt,
]
  .map((font) => font.variable)
  .join(" ");
