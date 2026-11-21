import { describe, expect, it } from "vitest";

import { conversionNote } from "../../exchange-rates.js";
import { PERIODS } from "../../metrics.js";
import { allResourcesName, tileLabel } from "../../resource.js";
import { compareCatalogs } from "../catalog.js";

import {
  aggregationName,
  comparisonLabel,
  itemsNeedNewerAppText,
  itemsWidgetLabel,
  localizedProviderFailure,
  localizedProviderMessage,
  PROVIDER_MESSAGE_CODES,
  providerMessageForCode,
  othersLabel,
  periodLabel,
  sharedDe,
  sharedEn,
} from "./index.js";

describe("shared catalog", () => {
  it("has every English key in German with the same arguments", () => {
    expect(compareCatalogs(sharedEn, sharedDe)).toEqual([]);
  });

  it("names every period and its comparison in both languages", () => {
    for (const period of PERIODS) {
      expect(periodLabel(period)).not.toContain("periods.");
      expect(periodLabel(period, "de")).not.toBe(periodLabel(period));
      expect(comparisonLabel(period, "de")).toMatch(/^vs\. /);
    }
    expect(periodLabel("last_30_days")).toBe("Last 30 days");
    expect(periodLabel("last_30_days", "de")).toBe("Letzte 30 Tage");
    expect(comparisonLabel("last_30_days")).toBe("vs previous 30 days");
    expect(comparisonLabel("last_30_days", "de")).toBe("vs. vorherige 30 Tage");
    expect(comparisonLabel("this_month", "de")).toBe("vs. Vormonat");
    // Periods to date (ADR 0019 §3).
    expect(periodLabel("this_week")).toBe("This week");
    expect(comparisonLabel("this_week")).toBe("vs last week to date");
    expect(comparisonLabel("this_quarter")).toBe("vs last quarter to date");
    expect(comparisonLabel("this_year")).toBe("vs last year to date");
    expect(periodLabel("this_quarter", "de")).toBe("Dieses Quartal");
    expect(comparisonLabel("this_year", "de")).toBe("vs. Vorjahr bis heute");
  });

  it("names aggregations, a daily gauge's by day", () => {
    const gauge = { kind: "gauge", granularity: "day" };
    expect(aggregationName("sum")).toBe("Total");
    expect(aggregationName("sum", null, "de")).toBe("Summe");
    expect(aggregationName("last", gauge)).toBe("Latest day");
    expect(aggregationName("last", gauge, "de")).toBe("Letzter Tag");
    expect(aggregationName("avg", gauge, "de")).toBe("Mittelwert");
  });

  it("names the remainder of a breakdown", () => {
    expect(othersLabel()).toBe("Others");
    expect(othersLabel("de")).toBe("Andere");
  });

  it("writes the conversion note in the screen language", () => {
    expect(conversionNote([], "de")).toBe("EZB-Referenzkurse");
    expect(conversionNote(["AED", "TWD"], "de")).toBe(
      "EZB-Referenzkurse · AED, TWD nicht umgerechnet",
    );
    expect(conversionNote(["TWD"])).toBe(
      "ECB reference rates · TWD not converted",
    );
  });
});

describe("scope labels in German", () => {
  it("builds the scope with the noun capitalised", () => {
    const apps = { singular: "app", plural: "apps" };
    expect(allResourcesName(apps, 2, "de")).toBe("Alle Apps");
    expect(allResourcesName(apps, 2, "en")).toBe("All apps");
    // A connector's German noun is used as given.
    expect(
      allResourcesName({ singular: "Website", plural: "Websites" }, 3, "de"),
    ).toBe("Alle Websites");
    expect(allResourcesName(null, 3, "de")).toBe("Alle Ressourcen");
    expect(allResourcesName(apps, 1, "de")).toBeNull();
  });

  it("joins a German scope into the tile label", () => {
    expect(
      tileLabel({
        title: null,
        metricName: "Downloads",
        dimensions: {},
        resourceName: null,
        allResourcesName: allResourcesName(
          { singular: "app", plural: "apps" },
          2,
          "de",
        ),
      }),
    ).toBe("Downloads · Alle Apps");
  });
});

describe("provider messages (#378)", () => {
  const refused = sharedEn.providerMessages.appleAds.invalidClient;

  it("shows a refused Apple Ads key in the viewer's language", () => {
    expect(localizedProviderMessage(refused, "de")).toBe(
      sharedDe.providerMessages.appleAds.invalidClient,
    );
    expect(localizedProviderMessage(refused, "de")).toMatch(
      /^Apple Ads hat den Schlüssel abgelehnt/,
    );
    expect(localizedProviderMessage(` ${refused}\n`, "en")).toBe(refused);
  });

  it("formats every message to its catalog text, apostrophes included", () => {
    for (const english of Object.values(sharedEn.providerMessages.appleAds)) {
      expect(localizedProviderMessage(english)).toBe(english);
      expect(localizedProviderMessage(english, "de")).not.toBe(english);
    }
  });

  it("leaves any other text to the caller", () => {
    expect(localizedProviderMessage("Apple Ads answered 500")).toBeNull();
  });
});

describe("provider reason codes (#795)", () => {
  it("shows a refused key by its code, whatever the recorded English says", () => {
    // The server's wording changed since the row was written: the code
    // still finds the text, where the exact-text match no longer does.
    const reworded = "Apple Ads did not accept this key. Set up a new one.";
    expect(localizedProviderMessage(reworded, "de")).toBeNull();
    expect(
      localizedProviderFailure(
        { code: "apple_ads.invalid_client", message: reworded },
        "de",
      ),
    ).toBe(sharedDe.providerMessages.appleAds.invalidClient);
    expect(
      localizedProviderFailure(
        { code: "app_store_connect.unauthorized", message: reworded },
        "de",
      ),
    ).toBe(sharedDe.providerMessages.appStoreConnect.unauthorized);
    expect(providerMessageForCode("app_store_connect.forbidden", "de")).toMatch(
      /^App Store Connect hat den Zugriff verweigert/,
    );
  });

  it("has an English and a German text for every code", () => {
    for (const code of Object.keys(PROVIDER_MESSAGE_CODES)) {
      const english = providerMessageForCode(code, "en");
      const german = providerMessageForCode(code, "de");
      expect(english, code).toEqual(expect.any(String));
      expect(german, code).toEqual(expect.any(String));
      expect(german, code).not.toBe(english);
    }
  });

  it("finds a row recorded before codes by its exact English text", () => {
    const english = sharedEn.providerMessages.appleAds.forbidden;
    for (const code of [null, undefined]) {
      expect(localizedProviderFailure({ code, message: english }, "de")).toBe(
        sharedDe.providerMessages.appleAds.forbidden,
      );
    }
  });

  it("leaves an unknown code and unknown text to the caller", () => {
    expect(providerMessageForCode("acme.quota_used_up", "de")).toBeNull();
    // Not a code of the map, although the map object has the property.
    expect(providerMessageForCode("constructor", "de")).toBeNull();
    expect(providerMessageForCode(null)).toBeNull();
    expect(
      localizedProviderFailure(
        { code: "acme.quota_used_up", message: "Acme answered 500" },
        "de",
      ),
    ).toBeNull();
    expect(localizedProviderFailure({ code: null, message: null })).toBeNull();
  });
});

describe("latest items (#810)", () => {
  it("labels an untitled widget and words the older-screen placeholder", () => {
    expect(itemsWidgetLabel(null)).toBe("Latest items");
    expect(itemsWidgetLabel("  ", "de")).toBe("Neueste Einträge");
    expect(itemsWidgetLabel("Photos", "de")).toBe("Photos");
    expect(itemsNeedNewerAppText()).toBe(
      "Update netrics TV to show the latest items.",
    );
    expect(itemsNeedNewerAppText("de")).toBe(
      "Aktualisiere netrics TV, um die neuesten Einträge zu sehen.",
    );
  });
});
