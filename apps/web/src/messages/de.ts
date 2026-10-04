import type { Catalog } from "@netrics/domain";

import type { WebMessages } from "./en";

/**
 * German (ADR 0016): informal "du", sentence case.
 *
 * Glossary (extend with each area): Workspace, Dashboard, Widget, Studio,
 * Connector stay; connection → Verbindung; slide → Folie; screen →
 * Bildschirm; sign in → anmelden; settings → Einstellungen; owner, admin,
 * editor, viewer → Inhaber, Admin, Bearbeiter, Betrachter.
 */
export const de: Catalog<WebMessages> = {
  common: {
    save: "Speichern",
    saving: "Wird gespeichert…",
    roles: {
      owner: "Inhaber",
      admin: "Admin",
      editor: "Bearbeiter",
      viewer: "Betrachter",
    },
  },
  nav: {
    status: "Status",
    signIn: "Anmelden",
    account: "Konto",
  },
  account: {
    title: "Konto",
    profile: "Profil",
    name: "Name",
    email: "E-Mail",
    memberships: "Workspace-Mitgliedschaften",
    noMemberships: "Noch keine Mitgliedschaften.",
    changePassword: "Passwort ändern",
    currentPassword: "Aktuelles Passwort",
    newPassword: "Neues Passwort",
    changing: "Wird geändert…",
    passwordChanged: "Passwort geändert.",
    passwordChangeFailed: "Das Passwort konnte nicht geändert werden.",
    session: "Sitzung",
    signOut: "Abmelden",
    signingOut: "Wird abgemeldet…",
    language: {
      title: "Sprache",
      label: "Sprache",
      automatic: "Automatisch ({language})",
      hint: "Die Sprache, in der netrics für dich erscheint. Automatisch folgt der Vorgabe dieser Installation, sonst deinem Browser.",
      saved: "Sprache gespeichert.",
    },
  },
  workspaceSettings: {
    screenLanguage: {
      label: "Bildschirmsprache",
      automatic: "Vorgabe der Installation ({language})",
      hint: "Kiosks und Apple TVs dieses Workspaces zeigen Beschriftungen in dieser Sprache. Jedes Mitglied wählt seine eigene Sprache unter Konto.",
    },
  },
  errors: {
    generic: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
  },
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
