import type { Catalog } from "@netrics/domain";

import type { settingsEn } from "./en";

/** Settings and administration in German; glossary in ../de.ts. */
export const settingsDe: Catalog<typeof settingsEn> = {
  workspaceSettings: {
    title: "{workspace} – Einstellungen",
    metaTitle: "Einstellungen · netrics",
    yourRole: "Deine Rolle: {role}",
    backToWorkspace: "Zurück zum Workspace",
    workspace: {
      title: "Workspace",
      nameLabel: "Name des Workspaces",
      rename: "Umbenennen",
      timeZone: "Zeitzone",
      timeZoneHint:
        "Dashboards zählen „heute“ und Tageswerte in dieser Zeitzone.",
    },
    currency: {
      title: "Währung",
      label: "Beträge",
      perCurrency: "Pro Währung (exakt)",
      convertedTo: "Umgerechnet in {currency} (≈)",
      off: "Beträge in mehreren Währungen werden pro Währung angezeigt. Diese Instanz ruft keine Wechselkurse ab, daher können sie nicht umgerechnet werden.",
      hint: "Umgerechnete Beträge sind Näherungswerte: jeder Tag zum {source} dieses Tages (an Wochenenden und Feiertagen der zuletzt veröffentlichte Kurs). Apples eigene Berichte verwenden andere Kurse. Währungen, die die EZB nicht veröffentlicht, bleiben unumgerechnet und werden getrennt angezeigt. Eine Kachel kann das überschreiben.",
    },
    themes: {
      title: "Designs",
      hint: "Farben und Textgröße von Dashboards auf TVs: fünf eingebaute Designs und deine eigenen.",
      manage: "Designs verwalten",
    },
    screenLanguage: {
      label: "Bildschirmsprache",
      automatic: "Vorgabe der Installation ({language})",
      hint: "Kiosks und Apple TVs dieses Workspaces zeigen Beschriftungen in dieser Sprache. Jedes Mitglied wählt seine eigene Sprache unter Konto.",
    },
  },
  members: {
    title: "Mitglieder",
    you: "(du)",
    remove: "Entfernen",
    confirmRemove: "{name} ({email}) aus diesem Workspace entfernen?",
    roleOf: "Rolle von {name}",
    pendingInvitations: "Offene Einladungen",
    invitedAs: "eingeladen als {role}, läuft am {date} ab",
    invitedAsBy: "von {inviter} eingeladen als {role}, läuft am {date} ab",
    revoke: "Zurückziehen",
    revoking: "Wird zurückgezogen…",
    inviteEmail: "Per E-Mail einladen",
    role: "Rolle",
    invite: "Einladen",
    inviting: "Wird eingeladen…",
    noEmail:
      "Auf dieser Installation ist kein E-Mail-Versand eingerichtet. Schick diesen Link selbst an {email}. Er funktioniert einmal, nur für diese Adresse, und läuft in 7 Tagen ab.",
    inviteLink: "Einladungslink",
    sent: "Einladung an {email} gesendet.",
  },
  themes: {
    title: "Designs",
    metaTitle: "Designs · netrics",
    subtitle:
      "So sehen Dashboards auf TVs und im Browser aus. Eigene Designs beginnen als Kopie eines eingebauten.",
    backToSettings: "Zurück zu den Einstellungen",
    custom: "Eigene Designs",
    noneYet: "Noch keine.",
    copyHint:
      "Kopier unten ein eingebautes Design, um ein eigenes zu erstellen.",
    belowAa: "{count} unter AA",
    aa: "AA",
    builtins: "Eingebaute Designs",
    copy: "Kopieren und bearbeiten",
    copying: "Wird kopiert…",
    copyName: "Kopie von {name}",
    copyNameNumbered: "Kopie von {name} {n}",
    builtinNames: {
      netrics_dark: "netrics Dunkel",
      light: "Hell",
      high_contrast: "Hoher Kontrast",
      midnight: "Mitternacht",
      paper: "Papier",
    },
    allThemes: "Alle Designs",
    editor: {
      name: "Name des Designs",
      basedOn: "Basiert auf {name}",
      colours: "Farben",
      colourPicker: "Farbwähler für {label}",
      enterColour: "Gib eine Farbe wie #7aa2f7 ein.",
      pairTooLow: "{pair} hat {ratio}:1, weniger als 3:1.",
      pair: "{foreground} auf {background}",
      textSize: "Textgröße",
      textSizeHint:
        "Vergrößert alle Texte; sie werden nie kleiner als die Mindestgrößen für TVs.",
      scales: {
        normal: "Normal ({factor}×)",
        large: "Groß ({factor}×)",
        larger: "Größer ({factor}×)",
      },
      contrast: "Kontrast",
      contrastHint:
        "TVs werden aus der Entfernung gelesen. Unter 4,5:1 gibt es eine Warnung; unter 3:1 lässt sich das Design nicht speichern.",
      levels: {
        pass: "AA",
        warn: "Unter AA",
        fail: "Zu niedrig",
      },
      save: "Design speichern",
      resetTo: "Auf {name} zurücksetzen",
      saved: "Gespeichert.",
      readOnly: "Deine Rolle kann Designs ansehen, aber nicht ändern.",
      raiseContrast:
        "Erhöh den Kontrast der Paare mit „Zu niedrig“, um zu speichern.",
      confirmDelete: "Das Design „{name}“ löschen?",
    },
    tokens: {
      background: {
        label: "Hintergrund",
        help: "Die Fläche hinter den Widgets",
      },
      surface: { label: "Fläche", help: "Hintergrund der Widgets" },
      border: { label: "Rahmen", help: "Rahmen der Widgets" },
      text: { label: "Text", help: "Werte und Überschriften" },
      label: { label: "Beschriftung", help: "Titel der Widgets" },
      muted: { label: "Gedämpft", help: "Nebenzeilen und Achsen" },
      accent: {
        label: "Akzent",
        help: "Hervorhebungen, der letzte Punkt, die Uhr",
      },
      up: { label: "Aufwärts", help: "Änderung in die gute Richtung" },
      down: { label: "Abwärts", help: "Änderung in die schlechte Richtung" },
      warning: { label: "Warnung", help: "Veraltete Daten und Fehler" },
      chartLine: {
        label: "Diagrammlinie",
        help: "Sparklines und Liniendiagramme",
      },
      chartFill: {
        label: "Diagrammfüllung",
        help: "Balken und die Fläche unter Linien",
      },
    },
  },
  statusPage: {
    title: "Status",
    subtitle: "Zustand von Web-App, API und Datenbank dieser Installation",
    webVersion: "Web-Version",
    apiVersion: "API-Version",
    apiLive: "API-Prozess (live)",
    apiReady: "API-Bereitschaft",
    database: "PostgreSQL",
    unknown: "unbekannt",
    live: "läuft",
    unreachable: "nicht erreichbar",
    ready: "bereit",
    notReady: "nicht bereit",
    up: "erreichbar",
    down: "nicht erreichbar",
    apiUnreachable: "API nicht erreichbar: {error}",
    renderedAt: "Geprüft um {time} – lade neu, um erneut zu prüfen.",
  },
  appMeta: {
    description: "netrics – Kennzahlen auf jedem Bildschirm",
  },
  deployNotice: {
    reloading: "netrics wurde aktualisiert – wird neu geladen…",
    onNavigation:
      "netrics wurde aktualisiert – die Seite lädt neu, sobald du weiternavigierst.",
  },
};
