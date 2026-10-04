import type { Catalog } from "@netrics/domain";

import type { shellEn } from "./en";

/** The app shell in German; glossary in ../de.ts. */
export const shellDe: Catalog<typeof shellEn> = {
  shell: {
    home: "netrics-Startseite",
    sidebar: "Workspace",
    rail: "Bereiche des Workspaces",
    topBar: "Kopfleiste",
    openMenu: "Menü öffnen",
    closeMenu: "Menü schließen",
    workspace: {
      switcher: "Workspace wechseln (aktuell: {name})",
      list: "Deine Workspaces",
      current: "aktuell",
      new: "Neuer Workspace",
    },
    sections: {
      dashboards: "Dashboards",
      sources: "Quellen",
      screens: "Bildschirme",
    },
    items: {
      home: "Start",
      dashboards: "Alle Dashboards",
      themes: "Designs",
      sources: "Verbunden",
      addSource: "Quelle hinzufügen",
      screens: "Alle Bildschirme",
      team: "Team",
      settings: "Einstellungen",
    },
    railItems: {
      home: "Start",
      dashboards: "Dashboards",
      themes: "Designs",
      sources: "Quellen",
      addSource: "Quelle hinzufügen",
      screens: "Bildschirme",
      team: "Team",
      settings: "Einstellungen",
    },
    attentionDot: "braucht Aufmerksamkeit",
    health: {
      fresh: "Alle Quellen aktuell",
      none: "Noch keine Quellen",
      attention:
        "{count, plural, one {# Quelle braucht Aufmerksamkeit} other {# Quellen brauchen Aufmerksamkeit}}",
    },
    account: {
      menu: "Kontomenü für {name}",
      settings: "Kontoeinstellungen",
      status: "Status",
      signOut: "Abmelden",
      signingOut: "Wird abgemeldet…",
    },
  },
};
