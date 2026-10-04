import type { Catalog } from "@netrics/domain";

import type { dashboardsEn } from "./en";

/** The dashboards page in German; glossary in ../de.ts. */
export const dashboardsDe: Catalog<typeof dashboardsEn> = {
  dashboardsPage: {
    meta: "{count, plural, =0 {Noch keine Dashboards} one {# Dashboard} other {# Dashboards}}",
    metaLive:
      "{count, plural, one {# Dashboard} other {# Dashboards}} · {live} live auf Bildschirmen",
    projectFilter: "Projekt",
    allProjects: "Alle Projekte",
    noProject: "Kein Projekt",
    newDashboard: "Neues Dashboard",
    templates: "Mit einer Vorlage starten",
    template: {
      overview: { title: "Übersicht", text: "Aus deinen Quellen gebaut" },
      brand: { title: "Marke", text: "Eine App mit Icon und Farbe" },
      blank: { title: "Leer", text: "Eine leere Folie" },
    },
    startWith: "Mit {name} starten",
    create: "Neues Dashboard",
    closeCreate: "Schließen",
    list: "Deine Dashboards",
    slides: "{count, plural, one {# Folie} other {# Folien}}",
    updated: "aktualisiert {time}",
    onScreens:
      "{count, plural, one {Auf # Bildschirm} other {Auf # Bildschirmen}}",
    notShown: "Nicht gezeigt",
    theme: "Design: {name}",
    openInStudio: "Im Studio öffnen",
    openInStudioNamed: "{name} im Studio öffnen",
    thumbnail: "Vorschau von {name}",
    empty: {
      title: "Noch keine Dashboards",
      text: "Starte oben mit einer Vorlage. Die Übersicht füllt sich mit den Zahlen deiner Quellen.",
      readOnly: "In diesem Workspace hat noch niemand ein Dashboard angelegt.",
    },
    emptyFilter: "In diesem Projekt gibt es noch keine Dashboards.",
    projects: {
      summary: "Projekte verwalten",
      count:
        "{count, plural, =0 {noch keine} one {# Projekt} other {# Projekte}}",
    },
  },
};
