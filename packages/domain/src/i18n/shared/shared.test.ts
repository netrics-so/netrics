import { describe, expect, it } from "vitest";

import { conversionNote } from "../../exchange-rates.js";
import { PERIODS } from "../../metrics.js";
import { allResourcesName, tileLabel } from "../../resource.js";
import { compareCatalogs } from "../catalog.js";

import {
  aggregationName,
  comparisonLabel,
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
