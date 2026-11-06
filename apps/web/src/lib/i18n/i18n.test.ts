import { describe, expect, it, vi } from "vitest";

import { SUPPORTED_LOCALES, compareCatalogs } from "@netrics/domain";

import { WEB_CATALOGS, webTranslator } from "./catalogs";
import { instanceDefaultLocale, requestLocale } from "./locale";
import { EN_AREAS, en } from "@/messages/en";

describe("web catalogs", () => {
  it.each(SUPPORTED_LOCALES.filter((locale) => locale !== "en"))(
    "%s has every English key, nothing else, and the same arguments",
    (locale) => {
      expect(compareCatalogs(en, WEB_CATALOGS[locale])).toEqual([]);
    },
  );

  it("keeps each area's top-level groups apart", () => {
    // The catalog spreads the areas into one object: a group two areas
    // both define would silently lose one of them.
    const owners = new Map<string, string>();
    const clashes: string[] = [];
    for (const [area, messages] of Object.entries(EN_AREAS)) {
      for (const group of Object.keys(messages)) {
        const owner = owners.get(group);
        if (owner) clashes.push(`${group}: ${owner} and ${area}`);
        owners.set(group, area);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("English parses and formats (no syntax errors in the source)", () => {
    expect(compareCatalogs(en, en)).toEqual([]);
  });

  it("translates by namespace in both languages", () => {
    expect(webTranslator("en", "nav")("signIn")).toBe("Sign in");
    expect(webTranslator("de", "nav")("signIn")).toBe("Anmelden");
    expect(
      webTranslator("de", "account.language")("automatic", {
        language: "Deutsch",
      }),
    ).toBe("Automatisch (Deutsch)");
    expect(webTranslator("de", "common.roles")("owner")).toBe("Inhaber");
  });
});

describe("request language", () => {
  // ADR 0016 section 3: user → instance default → Accept-Language → en.
  it("prefers the user's setting", () => {
    expect(
      requestLocale({
        userLocale: "de",
        instanceDefault: "en",
        acceptLanguage: "en-US",
      }),
    ).toBe("de");
  });

  it("then the instance default, then the browser, then English", () => {
    expect(
      requestLocale({
        userLocale: null,
        instanceDefault: "de",
        acceptLanguage: "en-US",
      }),
    ).toBe("de");
    expect(
      requestLocale({
        userLocale: null,
        instanceDefault: null,
        acceptLanguage: "fr-CH, de;q=0.8",
      }),
    ).toBe("de");
    expect(
      requestLocale({
        userLocale: undefined,
        instanceDefault: null,
        acceptLanguage: "fr",
      }),
    ).toBe("en");
    expect(
      requestLocale({
        userLocale: null,
        instanceDefault: null,
        acceptLanguage: null,
      }),
    ).toBe("en");
  });
});

describe("NETRICS_DEFAULT_LOCALE", () => {
  it("is read from the environment at call time", () => {
    expect(instanceDefaultLocale({})).toBeNull();
    expect(instanceDefaultLocale({ NETRICS_DEFAULT_LOCALE: "" })).toBeNull();
    expect(instanceDefaultLocale({ NETRICS_DEFAULT_LOCALE: "de" })).toBe("de");
    expect(instanceDefaultLocale({ NETRICS_DEFAULT_LOCALE: " en " })).toBe(
      "en",
    );
  });

  it("ignores an unsupported value with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(instanceDefaultLocale({ NETRICS_DEFAULT_LOCALE: "fr" })).toBeNull();
    expect(instanceDefaultLocale({ NETRICS_DEFAULT_LOCALE: "DE" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
