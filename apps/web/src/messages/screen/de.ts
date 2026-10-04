import type { Catalog } from "@netrics/domain";

import type { screenEn } from "./en";

export const screenDe: Catalog<typeof screenEn> = {
  screen: {
    kiosk: {
      title: "netrics-Kiosk",
      connecting: "Verbinde mit netrics…",
      loading: "Wird geladen…",
      noDashboardTitle: "Noch kein Dashboard zugewiesen",
      noDashboardText:
        "Wähle eines unter TVs in netrics aus; dieser Bildschirm übernimmt es von selbst.",
      pairingPrompt: "Zeig ein netrics-Dashboard auf diesem Bildschirm",
      pairingCode: "Kopplungscode",
      pairingGoTo: "Öffne {url} und gib den Code ein.",
      unreachable: "netrics ist nicht erreichbar – neuer Versuch läuft",
      offline: "Offline",
      offlineSince: "Offline – letzte Aktualisierung {time}",
      noSlides: "Dieses Dashboard hat keine Folien zum Anzeigen.",
      noTiles: "Dieses Dashboard hat noch keine Kacheln.",
      tileFailed: "Diese Kachel konnte nicht geladen werden.",
    },
    tv: {
      allHidden:
        "Alle Folien sind ausgeblendet. Blende mindestens eine Folie ein, um dieses Dashboard abzuspielen.",
      exit: "TV-Modus beenden",
    },
    widget: {
      approximate: "Ungefähr",
      noDataYet: "Noch keine Daten für diesen Zeitraum",
      noDataShort: "Noch keine Daten",
      noComparison: "Keine Daten zum Vergleich ({comparison})",
      noComparisonShort: "Kein Vergleich",
      notEnoughData: "Noch nicht genug Daten für ein Diagramm",
      refreshFailed: "Aktualisierung fehlgeschlagen",
      couldNotLoad: "Konnte nicht geladen werden",
      failed: "Dieses Widget konnte nicht angezeigt werden",
      imageMissing: "Bild nicht verfügbar",
      offline: "Offline",
      mayBeOutdated: "Die Zahlen sind eventuell nicht aktuell",
      lineSummary: "{label}: {value}.",
      lineSummaryPrevious: "{label}: {value}, gestrichelt {comparison}.",
      trend: "Verlauf von {min} bis {max}, zuletzt {latest}.",
      trendAt: "Verlauf von {min} bis {max}, zuletzt {latest} ({date}).",
    },
    notices: {
      removed: "Verbindung entfernt",
      authFailed: "Verbindung braucht neue Zugangsdaten",
      needsReconnect: "Verbindung muss neu verbunden werden",
      outage: "Quelle nicht erreichbar",
      firstSync: "Warte auf die erste Synchronisierung",
      lastSync: "Zuletzt synchronisiert {time}",
      never: "nie",
    },
  },
};
