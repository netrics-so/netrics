import type { Catalog } from "@netrics/domain";

import type { dashboardsEn } from "./en";

/** The dashboards page in German; glossary in ../de.ts. */
export const dashboardsDe: Catalog<typeof dashboardsEn> = {
  storeTemplate: {
    googlePlay: "Google Play",
    appStoreConnect: "App Store Connect",
    title: "App-Portfolio",
    subtitle:
      "Downloads, Erlöse und Store-Bewertungen mit gemeinsamen Filtern und bearbeitbaren Kennzahlen.",
    back: "Zurück zu Dashboards",
    roleCannot:
      "Ein Workspace-Editor, Admin oder Inhaber kann diese Vorlagen einrichten.",
    defaultName: "App-Portfolio",
    loading: "Store-Verbindungen werden geladen…",
    loadFailed: "Die Verbindungen konnten nicht geladen werden.",
    retry: "Erneut versuchen",
    empty: "Verbinde zuerst App Store Connect oder Google Play.",
    connect: "Stores verbinden",
    name: "Dashboard-Name",
    connections: "1. Verbindungen auswählen",
    connectionsHelp:
      "Eine Verbindung kann viele Apps enthalten. Bereits importierte Daten bleiben verfügbar, auch wenn eine App für künftige Importe abgewählt wird.",
    finishSetup: "Einrichtung abschließen",
    appsCached: "{count, plural, one {# bekannte App} other {# bekannte Apps}}",
    refreshApps: "App-Namen aktualisieren",
    refreshing: "Apps werden gesucht…",
    cachedFallback:
      "Einige App-Listen konnten nicht aktualisiert werden. Bekannte Namen und aufbewahrte Daten bleiben verfügbar; prüfe die betroffene Verbindung, wenn eine App fehlt.",
    scope: "2. Übersicht auswählen",
    portfolio: "Alle Apps dieser Verbindungen",
    single: "Eine App oder ein verknüpftes Produkt",
    chooseApp: "App auswählen",
    scopeHelp:
      "Ein verknüpftes Produkt umfasst jede App, die du unten bestätigst. Bewertungen bleiben für jeden Store-Eintrag getrennt.",
    mapping: "3. Dasselbe Produkt über Stores hinweg verknüpfen",
    mappingHelp:
      "Apps behalten standardmäßig getrennte Identitäten. Bestätige eine Verknüpfung nur, wenn die Einträge zum selben Produkt gehören. Gleiche Namen sind Vorschläge und führen nie automatisch zu einer Verknüpfung.",
    addGroup: "Apps verknüpfen",
    groupName: "Produktname",
    removeGroup: "Verknüpfung entfernen",
    searchApps: "Apps nach Name oder ID suchen",
    selectedApps:
      "{count, plural, one {# App verknüpft} other {# Apps verknüpft}}",
    noApps:
      "Keine passenden Apps. Aktualisiere die App-Namen oder schließe die Verbindungseinrichtung ab.",
    previous: "Zurück",
    next: "Weiter",
    page: "Seite {page} von {pages}",
    suggestion: "„{name}“ über Stores hinweg verknüpfen",
    moreSuggestions: "Weitere Vorschläge",
    review: "Dashboard prüfen",
    edit: "Einrichtung bearbeiten",
    reviewTitle: "Bereit zum Erstellen",
    reviewHelp:
      "Diese Definitionen werden zu normalen Aufbereitungen, Kennzahlen und Widgets. Du kannst sie unter Daten & Kennzahlen und im Studio bearbeiten.",
    allHistory:
      "Das erste Dashboard nutzt alle aufbewahrten Daten. Mit dem Datumsfilter kannst du den Zeitraum eingrenzen.",
    downloadsDefinition:
      "Apple: als erste Downloads klassifizierte Einheiten. Google: tägliche Nutzerinstallationen. Der Store bleibt getrennt, weil die Definitionen unterschiedlich sind.",
    proceedsDefinition:
      "Apple: Einheiten × Entwicklererlös je Einheit. Google: alle vorzeichenbehafteten Händlerbeträge einschließlich Gebühren, Rückerstattungen und Anpassungen. Währungen bleiben getrennt.",
    ratingsDefinition:
      "Zuletzt erfasste Bewertung und Anzahl je Store-Eintrag und Land. Bewertungen werden nie über Apps oder Stores gemittelt. Öffentliche Google-Play-Bewertungen sind eine Quelle ohne Verfügbarkeitsgarantie.",
    missingDefinition:
      "Berichte können später eintreffen. Bekannte Werte bleiben als unvollständig sichtbar; ausstehende und fehlende Werte werden nicht als 0 behandelt. Nicht zugeordnete Kontozeilen bleiben von Apps getrennt.",
    create: "Bearbeitbares Dashboard erstellen",
    creating: "Dashboard wird erstellt…",
    unsaved:
      "Diese Dashboard-Einrichtung wurde noch nicht gespeichert. Seite verlassen?",
    invalid:
      "Wähle eine Verbindung und einen Dashboard-Namen. Jede verknüpfte App braucht einen Produktnamen und darf nur einer Verknüpfung angehören.",
    appRequired: "Wähle die App für diese Übersicht.",
    mappingRequired:
      "Wähle für jedes verknüpfte Produkt mindestens eine App und gib einen Namen ein.",
    appDashboard: "App-Dashboard erstellen",
    templateCard: "Apple und Google Play, bereit zum Anpassen",
  },
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
