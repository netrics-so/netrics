import type { Catalog } from "@netrics/domain";

import type { TemplateMessages } from "./en.js";

/** Dashboard templates in German ("du", sentence case; ADR 0016). */
export const templateDe: Catalog<TemplateMessages> = {
  overviewName: "Übersicht",
  slides: {
    appStore: "App Store",
    web: "Web",
    today: "Heute",
    trend: "Verlauf",
  },
  metrics: {
    downloads: "Downloads",
    proceeds: "Erlöse",
    reviews: "Rezensionen",
    searchClicks: "Suchklicks",
    impressions: "Impressionen",
    visitors: "Besucher",
    pageViews: "Seitenaufrufe",
    signups: "Registrierungen",
  },
  withPeriod: "{metric}, {days} Tage",
  downloadsByApp: "Downloads nach App",
  topTerritories: "Top-Länder",
  topCountries: "Top-Länder",
};
