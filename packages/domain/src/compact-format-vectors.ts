/**
 * Test vectors for compact numbers in each language (compact-format.ts),
 * computed from the TypeScript implementation. They are checked in at
 * packages/domain/test-vectors/compact-numbers.json; the domain tests fail
 * when the file and this output differ, and the Swift tests in
 * apps/tvos/NetricsKit run the same file (MetricFormat). Regenerate with
 * `pnpm vectors:compact` after a deliberate change, and port the change to
 * Formatting.swift.
 *
 * Not exported from the package index: only tests use it.
 */
import { localeCompactNumber, narrowCompactNumber } from "./compact-format.js";
import { SUPPORTED_LOCALES } from "./i18n/locale.js";

/** Values from 10,000, where tiles switch to the compact form. */
const FULL = [
  10_000, 10_049, 10_050, 12_345, 12_345.5, 12_900, 12_949, 12_950, 99_949,
  99_950, 99_999, 100_000, 123_456, 999_499, 999_949, 999_950, 999_999,
  1_000_000, 1_049_999, 1_050_000, 4_200_000, 4_249_999, 4_250_000, 999_949_999,
  999_950_000, 1_500_000_000, 999_950_000_000, 1_500_000_000_000,
  999_950_000_000_000, 1_500_000_000_000_000,
];

/** The narrow form also applies below 10,000 (a widget too narrow). */
const NARROW = [
  0,
  0.5,
  3.14159,
  42.25,
  999,
  999.6,
  1_000,
  1_234,
  9_999,
  ...FULL,
];

const CURRENCIES = ["EUR", "USD"] as const;

const withNegatives = (values: number[]) =>
  values.flatMap((value) => (value === 0 ? [value] : [value, -value]));

export function buildCompactNumberVectors() {
  const locales = Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => [
      locale,
      {
        full: withNegatives(FULL).map((value) => ({
          value,
          text: localeCompactNumber(value, locale),
        })),
        fullCurrency: CURRENCIES.flatMap((currency) =>
          withNegatives(FULL).map((value) => ({
            value,
            currency,
            text: localeCompactNumber(value, locale, currency),
          })),
        ),
        narrow: withNegatives(NARROW).map((value) => ({
          value,
          text: narrowCompactNumber(value, locale),
        })),
        narrowCurrency: CURRENCIES.flatMap((currency) =>
          withNegatives(NARROW).map((value) => ({
            value,
            currency,
            text: narrowCompactNumber(value, locale, currency),
          })),
        ),
      },
    ]),
  );
  return {
    about:
      "Generated from packages/domain/src/compact-format.ts by `pnpm vectors:compact`. Do not edit by hand. Values are in the major unit; text uses U+00A0 where the language puts a non-breaking space.",
    locales,
  };
}
