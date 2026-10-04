import type { Catalog } from "@netrics/domain";

import type { sourcesEn } from "./en";

/** The Sources page and connector catalogue in German; glossary in ../de.ts. */
export const sourcesDe: Catalog<typeof sourcesEn> = {
  sources: {
    subtitle:
      "Verbinde die Tools, über die du berichtest. netrics synchronisiert sie regelmäßig; du wählst, was jede Verbindung liest.",
    connected: "Verbunden",
    catalogue: "Katalog",
    catalogueHint: "Wähle einen Connector, um eine Quelle hinzuzufügen.",
    allConnections: "Alle Verbindungen",
    strip: {
      synced: "Synchronisiert {time}",
      firstSync: "Wartet auf die erste Synchronisierung",
      setupPending: "Einrichtung nicht abgeschlossen",
      needsReconnect: "Zugriff abgelaufen",
      authFailed: "Anmeldung abgelehnt",
      keyRejected: "Schlüssel abgelehnt",
      tokenRejected: "Token abgelehnt",
      outage: "Störung beim Anbieter",
      action: "{problem} · {action}",
    },
    actions: {
      finishSetup: "Einrichtung abschließen",
      reconnect: "Neu verbinden",
      fixKey: "Schlüssel ersetzen",
      fixToken: "Token ersetzen",
      view: "Ansehen",
    },
    categories: {
      all: "Alle",
      seo: "SEO",
      web: "Web",
      apps: "Apps",
      ads: "Werbung",
      revenue: "Umsatz",
      other: "Sonstige",
    },
    filter: "Connectoren nach Kategorie filtern",
    auth: {
      oauth2: "Anmeldung bei {provider}",
      "signed-key": "API-Schlüssel",
      token: "Zugriffstoken",
      none: "Ohne Anmeldung",
    },
    refresh: {
      minutes: "{count, plural, one {jede Minute} other {alle # Min.}}",
      hours: "{count, plural, one {stündlich} other {alle # Stunden}}",
      days: "{count, plural, one {täglich} other {alle # Tage}}",
    },
    moreMetrics: "+{count}",
    cta: {
      connect: "Verbinden",
      addAnother: "Weitere hinzufügen",
      fix: "Beheben",
      details: "Details",
      selected: "Ausgewählt",
      comingLater: "Kommt später",
    },
    connectName: "{name} verbinden",
    addAnotherName: "Weitere {name}-Verbindung hinzufügen",
    fixName: "{name} reparieren",
    detailsName: "Warum {name} nicht verfügbar ist",
    customApi: {
      name: "Eigene API",
      tag: "Kommt später",
      description:
        "Mach deine eigene JSON-API zur Quelle, ganz ohne Code. Geplant für ein späteres Release.",
      plan: "Zum Plan",
    },
  },
};
