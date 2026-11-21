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
    dataTables: "{count, plural, one {# Datentabelle} other {# Datentabellen}}",
    moreMetrics: "+{count}",
    cta: {
      connect: "Verbinden",
      addAnother: "Weitere hinzufügen",
      fix: "Beheben",
      details: "Details",
      selected: "Ausgewählt",
      build: "Bauen",
      connectExisting: "Vorhandene verbinden",
    },
    connectName: "{name} verbinden",
    addAnotherName: "Weitere {name}-Verbindung hinzufügen",
    fixName: "{name} reparieren",
    detailsName: "Warum {name} nicht verfügbar ist",
    preview: "Vorschau",
    previewHint: "Noch nicht fertig: Dieser Connector kann sich noch ändern.",
    customApi: {
      name: "Eigene API",
      tag: "Selbst gebaut",
      description: "Mach deine eigene JSON-API zur Quelle, ganz ohne Code.",
      buildName: "Eigene API bauen",
      connectExistingName: "Vorhandene eigene API verbinden",
    },
    recordSkips: {
      title: "Übersprungene Einträge",
      summary:
        "{stream}: {count, plural, one {# Eintrag} other {# Einträge}} bei der letzten Synchronisierung übersprungen · {time}",
      none: "{stream}: keine Einträge bei der letzten Synchronisierung übersprungen · {time}",
      field:
        "{path} war in {count, plural, one {# Eintrag} other {# Einträgen}} leer oder nicht lesbar",
      help: "Ein Feld, das nicht leer sein darf, überspringt den ganzen Eintrag. Damit diese Einträge bleiben, lass das Feld in einer neuen Version der eigenen API leer sein.",
    },
    itemImages: {
      title: "Bilder",
      summary:
        "{stored, plural, one {# Bild} other {# Bilder}} für {stream} gespeichert · geprüft {time}",
      skipped:
        "{skipped, plural, one {# Bild übersprungen} other {# Bilder übersprungen}}",
      reasons: {
        invalid_url: "Kein gültiger https-Link",
        host_not_allowed: "Host steht nicht in den Bild-Hosts der Definition",
        fetch_failed: "Konnte nicht geladen werden",
        too_large: "Größer als 2 MB",
        unsupported_type: "Kein PNG-, JPEG- oder WebP-Bild",
        invalid_image: "Beschädigt, animiert oder zu viele Pixel",
        quota_exceeded:
          "Der Bildspeicher deines Workspace für eigene APIs ist voll",
      },
    },
  },
};
