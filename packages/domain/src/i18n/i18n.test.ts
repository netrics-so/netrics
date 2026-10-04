import { describe, expect, it } from "vitest";

import {
  compareCatalogs,
  createNamespacedTranslator,
  createTranslator,
  formatMessage,
  formatMessageToParts,
  localeFromAcceptLanguage,
  matchLocale,
  messageArguments,
  parseAcceptLanguage,
  parseMessage,
  resolveLocale,
  type Catalog,
} from "../index.js";

describe("Accept-Language", () => {
  it("orders tags by weight, keeping header order for equal weights", () => {
    expect(
      parseAcceptLanguage("fr;q=0.5, de-AT, en;q=0.9, it;q=0, es;q=0.9"),
    ).toEqual(["de-AT", "en", "es", "fr"]);
  });

  it("drops malformed entries and tolerates spaces", () => {
    expect(parseAcceptLanguage(" de ; q=0.8 , <script>, en ")).toEqual([
      "en",
      "de",
    ]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });

  it("picks the most preferred supported language", () => {
    expect(localeFromAcceptLanguage("fr-FR, de-CH;q=0.8, en;q=0.5")).toBe("de");
    expect(localeFromAcceptLanguage("fr, it")).toBeNull();
    expect(localeFromAcceptLanguage("*")).toBeNull();
  });
});

describe("resolveLocale", () => {
  it("returns the first supported candidate", () => {
    // user setting → instance default → Accept-Language → en
    expect(resolveLocale(["de", "en", "en"])).toBe("de");
    expect(resolveLocale([null, "de", "en"])).toBe("de");
    expect(resolveLocale([null, undefined, "de"])).toBe("de");
    expect(resolveLocale([null, null, null])).toBe("en");
  });

  it("skips unsupported values instead of failing", () => {
    expect(resolveLocale(["fr", "", "de-AT"])).toBe("de");
    expect(resolveLocale(["xx"])).toBe("en");
  });

  it("matches by primary language, case-insensitively", () => {
    expect(matchLocale("DE")).toBe("de");
    expect(matchLocale("en_GB")).toBe("en");
    expect(matchLocale("deu")).toBeNull();
  });
});

describe("formatMessage", () => {
  it("fills arguments and formats numbers in the locale", () => {
    expect(formatMessage("en", "Hello {name}", { name: "Ada" })).toBe(
      "Hello Ada",
    );
    expect(formatMessage("de", "{n} Zeilen", { n: 12345.5 })).toBe(
      "12.345,5 Zeilen",
    );
    expect(formatMessage("en", "{n} rows", { n: 12345.5 })).toBe(
      "12,345.5 rows",
    );
  });

  it("shows a missing argument rather than hiding it", () => {
    expect(formatMessage("en", "Hi {name}")).toBe("Hi {name}");
  });

  const apps = "{count, plural, =0 {no apps} one {# app} other {# apps}}";
  const appsDe = "{count, plural, =0 {keine Apps} one {# App} other {# Apps}}";

  it("chooses plural forms per locale", () => {
    expect(formatMessage("en", apps, { count: 0 })).toBe("no apps");
    expect(formatMessage("en", apps, { count: 1 })).toBe("1 app");
    expect(formatMessage("en", apps, { count: 1200 })).toBe("1,200 apps");
    expect(formatMessage("de", appsDe, { count: 1 })).toBe("1 App");
    expect(formatMessage("de", appsDe, { count: 1200 })).toBe("1.200 Apps");
  });

  it("supports offset and select, with # inside a nested select", () => {
    const message =
      "{n, plural, offset:1 =0 {nobody} =1 {{who}} other {{who} and # {kind, select, team {teammates} other {others}}}}";
    expect(formatMessage("en", message, { n: 0, who: "Ada" })).toBe("nobody");
    expect(formatMessage("en", message, { n: 1, who: "Ada" })).toBe("Ada");
    expect(
      formatMessage("en", message, { n: 3, who: "Ada", kind: "team" }),
    ).toBe("Ada and 2 teammates");
    expect(formatMessage("en", message, { n: 2, who: "Ada" })).toBe(
      "Ada and 1 others",
    );
  });

  it("quotes like ICU: '' and '{…}', other apostrophes are literal", () => {
    expect(formatMessage("en", "Don't worry")).toBe("Don't worry");
    expect(formatMessage("en", "It''s '{literal}'")).toBe("It's {literal}");
    expect(
      formatMessage("en", "{n, plural, other {'#' is # }}", { n: 2 }),
    ).toBe("# is 2 ");
    expect(formatMessage("en", "# stays outside plurals")).toBe(
      "# stays outside plurals",
    );
  });

  it("rejects what it does not support", () => {
    expect(() => parseMessage("{when, date, short}")).toThrow(/unsupported/);
    expect(() => parseMessage("{n, plural, one {x}}")).toThrow(/other/);
    expect(() =>
      parseMessage("{n, plural, few {x} few {y} other {z}}"),
    ).toThrow(/duplicate/);
    expect(() => parseMessage("open {")).toThrow();
    expect(() => parseMessage("close }")).toThrow(/unmatched/);
    expect(() => parseMessage("{1x}")).toThrow(/argument name/);
  });

  it("keeps rich parts as values", () => {
    const link = { tag: "a" };
    expect(
      formatMessageToParts("en", "Read the {link} first.", { link }),
    ).toEqual(["Read the ", link, " first."]);
  });

  it("lists argument names", () => {
    expect(
      messageArguments("{a} {n, plural, other {{b} {c, select, other {}}}}"),
    ).toEqual(["a", "b", "c", "n"]);
  });
});

describe("catalogs", () => {
  const en = {
    nav: { status: "Status", signIn: "Sign in" },
    rows: "{count, plural, one {# row} other {# rows}}",
  } as const;
  const de: Catalog<typeof en> = {
    nav: { status: "Status", signIn: "Anmelden" },
    rows: "{count, plural, one {# Zeile} other {# Zeilen}}",
  };

  it("translates with typed keys and namespaces", () => {
    const t = createTranslator<typeof en>({ locale: "de", messages: de });
    expect(t("nav.signIn")).toBe("Anmelden");
    expect(t("rows", { count: 2 })).toBe("2 Zeilen");
    const nav = createNamespacedTranslator<typeof en, "nav">(
      { locale: "de", messages: de },
      "nav",
    );
    expect(nav("signIn")).toBe("Anmelden");
    expect(nav.locale).toBe("de");
    // @ts-expect-error: not a key of the namespace
    expect(nav("rows")).toBe("nav.rows");
  });

  it("falls back to English for keys a catalog lacks at runtime", () => {
    const partial = { nav: { status: "Zustand" } } as unknown as Catalog<
      typeof en
    >;
    const t = createTranslator<typeof en>({
      locale: "de",
      messages: partial,
      fallback: en,
    });
    expect(t("nav.status")).toBe("Zustand");
    expect(t("nav.signIn")).toBe("Sign in");
    expect(t.has("nav.signIn")).toBe(true);
    expect(t.has("nav.nothing")).toBe(false);
  });

  it("reports missing keys, extra keys, syntax and argument drift", () => {
    expect(compareCatalogs(en, de)).toEqual([]);
    expect(
      compareCatalogs(en, {
        nav: { status: "Status", extra: "x" },
        rows: "{n, plural, one {# Zeile} other {# Zeilen}}",
      }),
    ).toEqual([
      "nav.signIn: missing in translation",
      "rows: arguments {n} differ from {count}",
      "nav.extra: not in the source catalog",
    ]);
    expect(compareCatalogs({ a: "x" }, { a: "{broken" })[0]).toMatch(/^a: /);
  });
});
