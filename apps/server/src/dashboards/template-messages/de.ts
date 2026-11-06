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
    appleAds: "Apple Ads",
    glance: "Auf einen Blick",
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
    adSpend: "Werbeausgaben",
    adInstalls: "Anzeigen-Installationen",
    costPerInstall: "Kosten pro Installation",
  },
  withPeriod: "{metric}, {days} Tage",
  downloadsByApp: "Downloads nach App",
  topTerritories: "Top-Länder",
  topCountries: "Top-Länder",
  perInstall: "pro Installation",
  topCampaigns: "Top-Kampagnen",
  spendByCountry: "Ausgaben nach Land",
  installsByAttribution: "Installationen: Tap oder Ansicht",
  adsDays: "Tage in {timeZone}, wie in Apple Ads.",
  adsDaysShort: "Tage in {timeZone}.",
  adsDaysUnknownZone: "Tage in der Zeitzone des Werbekontos.",
};
