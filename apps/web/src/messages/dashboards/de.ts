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
      "Neueste Bewertung je Store-Eintrag und Land, nie über Apps oder Stores gemittelt. Apple: Bewertung und Anzahl aus dem App Store für dein Land. Google Play: die Bewertung aus den Bewertungsberichten der Play Console (alle Länder), Stand des letzten Berichtstags; der Bericht enthält keine Anzahl. Der öffentliche Play-Store-Eintrag liefert nur App-Namen und Symbole.",
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
    editTitle: "Apps von {name} ändern",
    editSubtitle:
      "Füge Store-Verbindungen hinzu oder entferne sie und wähle, welche App das Dashboard zeigt, ohne etwas neu zu verbinden.",
    editRoleCannot:
      "Die Apps eines Vorlagen-Dashboards können Bearbeiter, Admins oder Inhaber des Workspaces ändern.",
    editUnavailable:
      "Die Apps dieses Dashboards lassen sich hier nicht ändern. Es wurde eingerichtet, bevor Vorlagen Versionen hatten, und eine Store-Verbindung, die es genutzt hat, wurde inzwischen gelöscht.",
    editUpdateFirst:
      "Die Vorlage hat ein Update für dieses Dashboard. Prüfe es zuerst und ändere danach die Apps.",
    editOpenUpdate: "Update öffnen",
    editConnectionsHelp:
      "Deine eigenen Änderungen an Aufbereitungen, Kennzahlen und Widgets bleiben. Was sich aus den Apps ergibt, wird neu erzeugt: Neue Verbindungen kommen als Entwürfe, entfernte werden abgelöst und bleiben erhalten.",
    editMapping:
      "Produkt-Verknüpfungen bleiben in der Zuordnungstabelle dieses Dashboards unter Daten & Kennzahlen.",
    editMappingLink: "Produkt-Verknüpfungen in Daten & Kennzahlen bearbeiten",
    reviewChanges: "Änderungen prüfen",
    planning: "Wird verglichen …",
    editReviewTitle: "Was sich ändert",
    scopeUnchanged:
      "Das sind die Apps, die das Dashboard schon nutzt. Ändere zuerst eine Verbindung oder die App.",
    templateCard: "Apple und Google Play, bereit zum Anpassen",
    identity: "App-Identität",
    identityHelp:
      "Icon, kostenpflichtig oder kostenlos und Website jeder App, für die App-Folien. Wird direkt gespeichert, ohne Prüfung.",
    identityEmpty:
      "Noch keine Apps. Sie erscheinen, sobald eine Verbindung synchronisiert hat.",
    useIcon: "App-Icon verwenden",
    iconLoading: "Icon wird geholt …",
    pricing: "Kostenpflichtig oder kostenlos",
    pricingAutoPaid:
      "Automatisch (jetzt kostenpflichtig: Erlöse in den letzten 90 Tagen)",
    pricingAutoFree:
      "Automatisch (jetzt kostenlos: keine Erlöse in den letzten 90 Tagen)",
    pricingPaid: "Kostenpflichtig",
    pricingFree: "Kostenlos",
    pricingHelp:
      "Automatisch zählt eine App als kostenpflichtig, solange sie in den letzten 90 Tagen Erlöse hatte. Die Folie einer kostenlosen App lässt den Umsatz weg.",
    website: "Website",
    websiteNone: "Keine Website",
    websiteMissing: "Projekt nicht mehr verfügbar",
    websiteConnect:
      "Um Besucher pro App zu zeigen, verbinde zuerst Vercel Web Analytics.",
    identitySave: "App-Identität speichern",
    identitySaving: "Wird gespeichert …",
    identitySaved: "App-Identität gespeichert.",
  },
  dashboardsPage: {
    meta: "{count, plural, =0 {Noch keine Dashboards} one {# Dashboard} other {# Dashboards}}",
    metaLive:
      "{count, plural, one {# Dashboard} other {# Dashboards}} · {live} live auf Bildschirmen",
    activeProjectMeta: "In {project}",
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
      hiddenInArchived:
        "{count, plural, one {# Dashboard liegt in einem archivierten Projekt.} other {# Dashboards liegen in archivierten Projekten.}}",
      readOnly: "In diesem Workspace hat noch niemand ein Dashboard angelegt.",
    },
    emptyFilter: "In diesem Projekt gibt es noch keine Dashboards.",
    projects: {
      summary: "Projekte verwalten",
      overview:
        "Projekte: {active, plural, =0 {keine aktiven} other {# aktiv}}{archived, plural, =0 {} other { · # archiviert}}.",
      archived: "Archiviert",
      saving: "Wird gespeichert …",
      savedTo: "In {name} gespeichert",
      savedNone: "Gespeichert: kein Projekt",
      project: "Projekt",
      noProject: "Kein Projekt",
    },
  },
  storeUpdate: {
    badge: "Update verfügbar",
    badgeNamed: "Update verfügbar für {name}: prüfen",
    studioAvailable: "Die Vorlage hat ein Update für dieses Dashboard.",
    studioCopy:
      "Das ist die aktualisierte Kopie. Vergleiche sie mit dem Original und nutze sie dann auf deinen Bildschirmen.",
    studioArchivedCopy:
      "Diese aktualisierte Kopie ist archiviert, weil du zurückgewechselt hast. Nutze sie über die Update-Seite wieder.",
    studioArchived:
      "Archiviert, solange die aktualisierte Kopie auf deinen Bildschirmen läuft. Wechsle zurück, um es wieder zu nutzen und zu bearbeiten.",
    review: "Update prüfen",
    changeApps: "Apps ändern",
    openUpdate: "Update öffnen",
    dataBanner: "Vorlagen-Update für {name}",
    dataProgress:
      "{count, plural, one {# Entwurf aus dem Vorlagen-Update wartet auf die Veröffentlichung.} other {# Entwürfe aus dem Vorlagen-Update warten auf die Veröffentlichung.}}",
    dataMark: "Update",
    archived: "Archiviert",
    archivedHint:
      "Originale, die aufbewahrt werden, solange ihre aktualisierten Kopien auf deinen Bildschirmen laufen, damit du zurückwechseln kannst. Sie sind schreibgeschützt.",
    switchBackLink: "Zurückwechseln",
    title: "{name} aktualisieren",
    back: "Zurück zu den Dashboards",
    roleCannot:
      "Ein Bearbeiter, Admin oder Inhaber des Workspaces kann Vorlagen-Updates prüfen und anwenden.",
    versions: "Vorlagenversion {from} → {to}",
    unavailable:
      "Für dieses Dashboard sind keine Updates verfügbar. Es wurde eingerichtet, bevor Vorlagen Versionen hatten, und eine seiner Store-Verbindungen wurde seitdem gelöscht. Deshalb kann netrics deine Änderungen nicht von denen der Vorlage unterscheiden. Das Dashboard funktioniert weiter wie bisher.",
    upToDate: "Dieses Dashboard ist auf dem Stand seiner Vorlage.",
    scopeIntro:
      "Nichts ändert sich, bevor du es sagst. Was sich aus deinen Apps ergibt, wird aus deinen Apps neu erzeugt; wir fragen nur dort, wo du etwas geändert hast. Datenänderungen werden Entwürfe, die du in den Dateneinstellungen veröffentlichst; ein neuer App-Filter kommt als aktualisierte Dashboard-Kopie, die du vergleichst, bevor sie auf deine Bildschirme kommt.",
    intro:
      "Nichts ändert sich, bevor du es willst. Datenänderungen werden zu Entwürfen, die du in den Dateneinstellungen veröffentlichst. Dashboard-Änderungen kommen als aktualisierte Kopie, die du vergleichst, bevor sie auf deine Bildschirme kommt; dein Original wird archiviert, damit du zurückwechseln kannst.",
    steps: {
      label: "Fortschritt",
      review: "Prüfen und anwenden",
      publish: "Datenentwürfe veröffentlichen",
      copy: "Aktualisiertes Dashboard erstellen",
      compare: "Im Studio vergleichen",
      swap: "Auf deinen Bildschirmen nutzen",
      done: "erledigt",
    },
    summary: {
      measures: {
        changed:
          "{count, plural, one {# Kennzahl geändert} other {# Kennzahlen geändert}}",
        added:
          "{count, plural, one {# Kennzahl hinzugefügt} other {# Kennzahlen hinzugefügt}}",
        removed:
          "{count, plural, one {# Kennzahl entfernt} other {# Kennzahlen entfernt}}",
      },
      steps: {
        changed:
          "{count, plural, one {# Schritt geändert} other {# Schritte geändert}}",
        added:
          "{count, plural, one {# Schritt hinzugefügt} other {# Schritte hinzugefügt}}",
        removed:
          "{count, plural, one {# Schritt entfernt} other {# Schritte entfernt}}",
      },
      widgets: {
        changed:
          "{count, plural, one {# Widget geändert} other {# Widgets geändert}}",
        added:
          "{count, plural, one {# Widget hinzugefügt} other {# Widgets hinzugefügt}}",
        removed:
          "{count, plural, one {# Widget entfernt} other {# Widgets entfernt}}",
      },
      changed: "{count} geändert",
      added: "{count} hinzugefügt",
      removed: "{count} entfernt",
      conflicts: "{count} zu entscheiden",
      removals: "{count} zum Entfernen vorgeschlagen",
      none: "Keine Änderungen an Kennzahlen, Schritten oder Widgets",
    },
    scopeNote:
      "{count, plural, one {# Teil folgt} other {# Teile folgen}} deiner App-Auswahl (die zusammengeführten App-Daten und der App-Filter). Sie werden aus deinen Apps neu erzeugt, nicht geprüft.",
    groups: {
      choose: "Deine Entscheidung",
      removal: "Zum Entfernen vorgeschlagen",
      template: "Aus der Vorlage",
      customer: "Von dir behalten",
    },
    kinds: {
      preparation: "Aufbereitung",
      model: "Kennzahlen",
      dashboard: "Dashboard",
    },
    newRecord: "Neu in dieser Version",
    unpublishedDraft: "Enthält deine unveröffentlichten Änderungen",
    useTemplate: "Version der Vorlage übernehmen",
    keepMine: "Meine behalten",
    remove: "Entfernen",
    keep: "Behalten",
    detach: "Ablösen (bleibt unter Daten & Kennzahlen)",
    templateValue: "Vorlage: {text}",
    yourValue: "Deine: {text}",
    absent: "entfernt",
    change: {
      added: "hinzugefügt",
      changed: "geändert",
      removed: "entfernt",
    },
    why: {
      both: "Du und die Vorlage habt das beide geändert.",
      templateRemoved: "Die Vorlage hat das entfernt; du hattest es geändert.",
      customerRemoved: "Du hast das entfernt; die Vorlage hat es geändert.",
      bothAdded:
        "Du und die Vorlage habt das beide hinzugefügt, aber unterschiedlich.",
      removedDataset:
        "Wenn du die Version der Vorlage übernimmst, kommt {dataset} zurück, das du aus diesen Kennzahlen entfernt hast.",
      removedDatasetUnknown:
        "Wenn du die Version der Vorlage übernimmst, kommen Daten zurück, die du aus diesen Kennzahlen entfernt hast.",
      scopeRemoval:
        "Diese Verbindung gehört nicht mehr zum Dashboard. Ihre Aufbereitung wird von der Vorlage abgelöst und bleibt mit deinen Änderungen unter Daten & Kennzahlen; sie wird nie gelöscht.",
      proposeRemoval:
        "Die neue Vorlage hat das nicht mehr. Du hast es nie geändert: Entferne es oder behalte es als deins.",
    },
    item: {
      measure: "Kennzahl {name} · {how}",
      dimension: "Dimension {name}",
      step: "{type} · {name}",
      stepUnnamed: "{type}",
      output: "Ergebnis {name}",
      relationship: "Eine Beziehung zwischen Datensätzen",
      widget: "Widget {title} · {type}",
      widgetUntitled: "Widget {type}",
      filter: "Gemeinsamer Filter {name}",
      slide: "Folie {name}",
      slideUntitled: "Eine Folie",
      setting: "Dashboard-Einstellung {name}",
      formula: "Formel",
      rolling: "gleitendes Fenster",
      period_offset: "früherer Zeitraum",
      other: "berechnet",
    },
    widgetTypes: {
      measure: "Kennzahl",
      metric: "Metrik",
      line: "Liniendiagramm",
      bar: "Balkendiagramm",
      table: "Tabelle",
      compare: "Vergleich",
      gauge: "Tacho",
      image: "Bild",
      text: "Text",
      clock: "Uhr",
      status: "Status",
      countdown: "Countdown",
      review: "Bewertung",
      widget: "Widget",
    },
    changes: {
      column: {
        added: "{count, plural, one {# neue Spalte} other {# neue Spalten}}",
        changed:
          "{count, plural, one {# geänderte Spalte} other {# geänderte Spalten}}",
        removed:
          "{count, plural, one {# Spalte entfernt} other {# Spalten entfernt}}",
      },
      step: {
        added:
          "{count, plural, one {# neuer Verarbeitungsschritt} other {# neue Verarbeitungsschritte}}",
        changed:
          "{count, plural, one {# geänderter Verarbeitungsschritt} other {# geänderte Verarbeitungsschritte}}",
        removed:
          "{count, plural, one {# Verarbeitungsschritt entfernt} other {# Verarbeitungsschritte entfernt}}",
      },
      result: {
        added:
          "{count, plural, one {# neues Ergebnis} other {# neue Ergebnisse}}",
        changed:
          "{count, plural, one {# geändertes Ergebnis} other {# geänderte Ergebnisse}}",
        removed:
          "{count, plural, one {# Ergebnis entfernt} other {# Ergebnisse entfernt}}",
      },
      measure: {
        added:
          "{count, plural, one {# neue Kennzahl} other {# neue Kennzahlen}}",
        changed:
          "{count, plural, one {# geänderte Kennzahl} other {# geänderte Kennzahlen}}",
        removed:
          "{count, plural, one {# Kennzahl entfernt} other {# Kennzahlen entfernt}}",
      },
      dimension: {
        added:
          "{count, plural, one {# neue Dimension} other {# neue Dimensionen}}",
        changed:
          "{count, plural, one {# geänderte Dimension} other {# geänderte Dimensionen}}",
        removed:
          "{count, plural, one {# Dimension entfernt} other {# Dimensionen entfernt}}",
      },
      widget: {
        added: "{count, plural, one {# neues Widget} other {# neue Widgets}}",
        changed:
          "{count, plural, one {# geändertes Widget} other {# geänderte Widgets}}",
        removed:
          "{count, plural, one {# Widget entfernt} other {# Widgets entfernt}}",
      },
      slide: {
        added: "{count, plural, one {# neue Folie} other {# neue Folien}}",
        changed:
          "{count, plural, one {# geänderte Folie} other {# geänderte Folien}}",
        removed:
          "{count, plural, one {# Folie entfernt} other {# Folien entfernt}}",
      },
      filter: {
        added:
          "{count, plural, one {# neuer gemeinsamer Filter} other {# neue gemeinsame Filter}}",
        changed:
          "{count, plural, one {# geänderter gemeinsamer Filter} other {# geänderte gemeinsame Filter}}",
        removed:
          "{count, plural, one {# gemeinsamer Filter entfernt} other {# gemeinsame Filter entfernt}}",
      },
      other: {
        added:
          "{count, plural, one {# weitere Änderung} other {# weitere Änderungen}}",
        changed:
          "{count, plural, one {# weitere Änderung} other {# weitere Änderungen}}",
        removed:
          "{count, plural, one {# weitere Änderung} other {# weitere Änderungen}}",
      },
      fromTemplate: "Aus der Vorlage: {changes}",
      kept: "{count, plural, one {Deine eigene Änderung bleibt erhalten.} other {Deine # eigenen Änderungen bleiben erhalten.}}",
      details: "Änderungen im Detail anzeigen ({count})",
      times: "×{count}",
    },
    confirm: {
      cancel: "Abbrechen",
      swapTitle: "Aktualisiertes Dashboard nutzen?",
      swapBackTitle: "Zu deinem Original zurückwechseln?",
      closeTitle: "Dieses Update abbrechen?",
    },
    decided: "{done} von {total} entschieden",
    apply: "Als Entwürfe anwenden",
    applying: "Wird angewendet …",
    applyHint:
      "Triff zuerst für jeden Eintrag unter „Deine Entscheidung“ und „Zum Entfernen vorgeschlagen“ eine Wahl.",
    nothingToDecide: "Du musst nichts entscheiden.",
    reloaded:
      "Das Update hat sich geändert, seit du es geöffnet hast, deshalb wurde die Prüfung neu geladen. Prüf deine Entscheidungen und wende es dann erneut an.",
    loading: "Update wird geladen …",
    retry: "Erneut versuchen",
    done: {
      applied:
        "Als Entwürfe angewendet. Veröffentliche sie als Nächstes in den Dateneinstellungen.",
      copy: "Aktualisierte Kopie erstellt. Vergleiche sie als Nächstes im Studio.",
      swap: "Bildschirme auf das aktualisierte Dashboard verschoben.",
      swapBack: "Bildschirme zurück auf dein Original verschoben.",
      close:
        "Update abgebrochen. Seine Entwürfe bleiben als normale Entwürfe erhalten.",
    },
    progress: {
      confirmSwapUnknown:
        "Alle Bildschirme, die das Original zeigen, auf das aktualisierte Dashboard verschieben? Das Original wird archiviert, und du kannst zurückwechseln.",
      confirmSwapBackUnknown:
        "Alle Bildschirme, die die aktualisierte Kopie zeigen, zurück auf dein Original verschieben? Die aktualisierte Kopie wird archiviert, und du kannst sie wieder nutzen.",
      viewArchivedCopy: "Archivierte aktualisierte Kopie ansehen",
      confirmSwap:
        "{count, plural, =0 {Das aktualisierte Dashboard nutzen? Noch kein Bildschirm zeigt das Original.} one {# Bildschirm ({screens}) auf das aktualisierte Dashboard verschieben?} other {# Bildschirme ({screens}) auf das aktualisierte Dashboard verschieben?}} Das Original wird archiviert, und du kannst zurückwechseln.",
      confirmSwapBack:
        "{count, plural, =0 {Zu deinem Original zurückwechseln?} one {# Bildschirm ({screens}) zurück auf dein Original verschieben?} other {# Bildschirme ({screens}) zurück auf dein Original verschieben?}} Die aktualisierte Kopie wird archiviert, und du kannst sie wieder nutzen.",
      publishIntro:
        "Öffne jeden Entwurf in den Dateneinstellungen, sieh dir die Vorschau an und veröffentliche ihn dort, in der angezeigten Reihenfolge: Jeder liest die Entwürfe darüber. Vor dem Veröffentlichen siehst du, was davon abhängt.",
      noDrafts: "Dieses Update ändert keine Daten.",
      published: "Veröffentlicht",
      draft: "Entwurf, noch nicht veröffentlicht",
      stale:
        "Erneut veröffentlichen: Er wurde vor den Entwürfen darüber veröffentlicht und liest noch deren frühere Versionen",
      openDraft: "In den Dateneinstellungen öffnen",
      checkAgain: "Erneut prüfen",
      copyWaiting:
        "Veröffentliche zuerst alle Entwürfe: Das aktualisierte Dashboard zeigt nur veröffentlichte Daten.",
      createCopy: "Aktualisiertes Dashboard erstellen",
      creating: "Wird erstellt …",
      copyHint:
        "Eine Kopie von {name} mit den Änderungen der Vorlage und deinen Entscheidungen. Sie ist auf keinem Bildschirm, bis du sie nutzt.",
      copyCreated: "Aktualisierte Kopie erstellt.",
      noDashboards: "Dieses Update ändert kein Dashboard.",
      openCopy: "Aktualisierte Kopie im Studio öffnen",
      openOriginal: "Original öffnen",
      afterCopy: "Verfügbar, sobald das aktualisierte Dashboard existiert.",
      compareHint:
        "Vergleiche die Kopie mit deinem Original. Änderungen, die du an der Kopie machst, bleiben erhalten.",
      screens:
        "{count, plural, =0 {Noch kein Bildschirm zeigt dieses Dashboard.} one {Verschiebt # Bildschirm: {screens}} other {Verschiebt # Bildschirme: {screens}}}",
      swap: "Auf meinen Bildschirmen nutzen",
      swapping: "Bildschirme werden verschoben …",
      swapHint:
        "Alle Bildschirme wechseln in einem Schritt. Das Original wird archiviert, nicht gelöscht.",
      swapCannot:
        "Ein Admin oder Inhaber des Workspaces kann Bildschirme verschieben.",
      copyCannot:
        "Ein Bearbeiter, Admin oder Inhaber des Workspaces kann das aktualisierte Dashboard erstellen.",
      swapped:
        "Das aktualisierte Dashboard läuft auf deinen Bildschirmen. Das Original ist archiviert.",
      switchBack: "Zurückwechseln",
      switchingBack: "Wird zurückgewechselt …",
      switchBackHint:
        "Bringt dein Original auf alle Bildschirme zurück und archiviert die aktualisierte Kopie.",
      switchedBack:
        "Dein Original ist wieder auf deinen Bildschirmen. Die aktualisierte Kopie ist archiviert.",
      swapAgain: "Aktualisiertes Dashboard wieder nutzen",
      scopeProblems:
        "Kein Bildschirm wurde verschoben: {screens} {count, plural, one {hat einen festen Bereich} other {haben einen festen Bereich}}, den das aktualisierte Dashboard nicht zeigen kann. Ändere den Bereich unter Bildschirme und versuch es dann erneut.",
      reviewChanged:
        "Dein Dashboard hat sich geändert, seit du das Update geprüft hast. Brich dieses Update ab und prüf es erneut, um über diese Einträge zu entscheiden:",
      close: "Dieses Update abbrechen",
      closing: "Wird abgebrochen …",
      closeConfirm:
        "Dieses Update abbrechen? Seine Datenentwürfe bleiben als normale Entwürfe erhalten, und auf deinen Bildschirmen ändert sich nichts.",
      recreate: "Kopie erneut erstellen",
      discardEdits:
        "Meine Änderungen an der Kopie verwerfen und sie neu erstellen",
      finished: "Update abgeschlossen.",
      unmergeable:
        "Das aktualisierte Dashboard lässt sich mit diesen Widgets nicht erstellen: {names}. Brich dieses Update ab, prüf es erneut und behalte für sie deine Version.",
      unmergeableData:
        "{name} lässt sich mit diesen Entscheidungen nicht aktualisieren: {names}. Entscheide für sie anders und wende es dann erneut an.",
    },
  },
};
