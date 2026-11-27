import type { Catalog } from "../catalog.js";

import type { SharedMessages } from "./en.js";

/** The shared catalog in German ("du", sentence case; ADR 0016). */
export const sharedDe: Catalog<SharedMessages> = {
  scope: {
    all: "Alle {plural}",
  },
  resources: {
    singular: "Ressource",
    plural: "Ressourcen",
  },
  latestReview: "Neueste Bewertung",
  latestItems: "Neueste Einträge",
  itemsNeedNewerApp:
    "Aktualisiere netrics TV, um die neuesten Einträge zu sehen.",
  serviceStatus: "Status",
  stateNeedNewerApp: "Aktualisiere netrics TV, um den Status zu sehen.",
  others: "Andere",
  sources: "Quellen",
  goal: "Ziel",
  none: "(keine)",
  attribution: {
    tap: "Nach Tap",
    view: "Nach Ansicht",
  },
  periods: {
    today: "Heute",
    last_7_days: "Letzte 7 Tage",
    last_30_days: "Letzte 30 Tage",
    this_month: "Dieser Monat",
    last_90_days: "Letzte 90 Tage",
    last_12_months: "Letzte 12 Monate",
    this_week: "Diese Woche",
    this_quarter: "Dieses Quartal",
    this_year: "Dieses Jahr",
  },
  comparisons: {
    today: "vs. gestern",
    last_7_days: "vs. vorherige 7 Tage",
    last_30_days: "vs. vorherige 30 Tage",
    this_month: "vs. Vormonat",
    last_90_days: "vs. vorherige 90 Tage",
    last_12_months: "vs. vorherige 12 Monate",
    this_week: "vs. Vorwoche bis heute",
    this_quarter: "vs. Vorquartal bis heute",
    this_year: "vs. Vorjahr bis heute",
  },
  aggregations: {
    sum: "Summe",
    avg: "Mittelwert",
    min: "Minimum",
    max: "Maximum",
    last: "Aktuell",
  },
  dailyAggregations: {
    last: "Letzter Tag",
    min: "Tiefster Tag",
    max: "Höchster Tag",
  },
  weekOf: "Woche vom {date}",
  countdown: {
    label: "Countdown",
    done: "Jetzt",
    units: { d: "T", h: "Std", m: "Min" },
  },
  conversion: {
    source: "EZB-Referenzkurse",
    notConverted: "{source} · {currencies} nicht umgerechnet",
  },
  compareMeasure: {
    side: "Vergleichsseite",
    date: "Datum",
    days: "{name} · Tage",
    previous: "{name} · vorheriger Zeitraum",
    change: "{name} · Veränderung",
    changePoints: "{name} · Veränderung (Pp.)",
  },
  providerMessages: {
    appleAds: {
      invalidClient:
        "Apple Ads hat den Schlüssel abgelehnt: Client-ID, Team-ID und Schlüssel-ID passen nicht zum öffentlichen Schlüssel, den du in Apple Ads gespeichert hast, oder der Schlüssel wurde entfernt. Prüf die drei Werte unter Account Settings → API oder richte einen neuen Schlüssel ein.",
      unauthorized:
        "Apple Ads hat das Zugriffstoken abgelehnt: Der Schlüssel wurde entfernt, oder der API-Benutzer hat keinen Zugriff mehr. Richte einen neuen Apple-Ads-Schlüssel ein.",
      forbidden:
        "Apple Ads hat den Zugriff verweigert: Der API-Benutzer braucht in diesem Werbekonto eine API-Rolle, etwa API Account Read Only (in Apples Antworten API Read Only). Eine Rolle ohne API entzieht den API-Zugriff. Bitte einen Account Admin, die Rolle zu ändern, oder richte einen neuen Schlüssel ein.",
    },
    appStoreConnect: {
      unauthorized:
        "App Store Connect hat den Schlüssel abgelehnt: Er wurde widerrufen, oder Issuer-ID, Schlüssel-ID und privater Schlüssel gehören nicht zusammen. Lad einen neuen App-Store-Connect-Schlüssel hoch.",
      forbidden:
        "App Store Connect hat den Zugriff verweigert: Die Rolle des Schlüssels wurde geändert, oder der Zugriff wurde entzogen. Dieser Schlüssel braucht die Rolle Sales oder Finance. Lad einen neuen App-Store-Connect-Schlüssel hoch.",
      keyMismatch:
        "App Store Connect hat den Schlüssel abgelehnt: Issuer-ID, Schlüssel-ID und privater Schlüssel gehören nicht zusammen, oder der Schlüssel wurde widerrufen. Prüf die drei Werte oder erstell einen neuen Team-Schlüssel und lad ihn hoch.",
      roleMissing:
        "Dieser Schlüssel kann keine Verkaufsberichte lesen. Er braucht die Rolle Sales oder Finance; Admin geht auch, gewährt aber mehr, als netrics braucht. Erstell einen Team-Schlüssel mit der Rolle Sales und lad ihn hoch.",
      agreementsMissing:
        "App Store Connect verlangt eine Vereinbarung, die fehlt oder abgelaufen ist. Der Account Holder muss die neuesten Vereinbarungen in App Store Connect (Business) akzeptieren. Versuch es danach erneut.",
    },
    railway: {
      tokenRejected:
        "Railway hat das Token nicht akzeptiert: Es ist falsch, wurde gelöscht oder ist ein Projekt-Token. Erstell in Railway ein Account- oder Workspace-Token (Account Settings → Tokens). Für ein Workspace-Token trag auch seine Workspace-ID ein.",
      workspaceDenied:
        "Railway hat das Token für die Workspace-ID dieser Verbindung nicht akzeptiert: Die ID ist falsch, das Token gehört zu einem anderen Workspace, oder es wurde gelöscht. Prüf die Workspace-ID oder erstell ein neues Token für diesen Workspace.",
    },
    posthog: {
      keyRejected:
        "PostHog hat den Personal API Key nicht akzeptiert: Er ist falsch, wurde gelöscht oder gehört zu einer anderen Region oder Instanz. Erstell in PostHog einen Personal API Key (Settings → Personal API keys) auf dem Host, den diese Verbindung nennt.",
      scopeMissing:
        "Dem Personal API Key fehlt ein Scope, den netrics braucht. Gib ihm in PostHog (Settings → Personal API keys) die Lese-Scopes Organization, Project, Query und Insight, oder erstell einen neuen Key mit ihnen.",
      hostInvalid:
        "Gib den Host deines PostHog ein: us.posthog.com, eu.posthog.com oder den Host-Namen deiner eigenen Instanz, zum Beispiel posthog.example.com: einen öffentlichen Namen, erreichbar über https, ohne Pfad oder Port.",
      insightsInvalid:
        "netrics konnte die gespeicherten Insights nicht lesen. Füge den Link jedes Insights aus PostHog ein (…/project/12345/insights/AbCd1234), getrennt durch Leerzeichen oder Kommas, höchstens 20.",
      projectsRequired:
        "Der Personal API Key ist auf einige Projekte beschränkt, daher listet PostHog sie nicht auf. Trag ihre Projekt-IDs unter Projekt-IDs ein (PostHog: Project settings → Project ID).",
      projectsInvalid:
        "netrics konnte nicht jede Projekt-ID mit diesem Key lesen. Trag die numerischen IDs von Projekten ein, die der Key lesen darf (PostHog: Project settings → Project ID), getrennt durch Leerzeichen oder Kommas, höchstens 50.",
    },
    hetznerCloud: {
      tokenRejected:
        "Hetzner Cloud hat das API-Token nicht akzeptiert: Es ist falsch oder wurde gelöscht. Erstell in der Hetzner Console (dein Projekt → Security → API tokens) ein Token mit Leserechten (Read) und gib es erneut ein.",
      tokenForbidden:
        "Hetzner Cloud hat das API-Token akzeptiert, lässt es aber die Server oder Preise des Projekts nicht lesen. Erstell in der Hetzner Console (dein Projekt → Security → API tokens) ein neues Token mit Leserechten (Read).",
    },
    httpCheck: {
      noChecks: "Leg mindestens einen Check an, höchstens 20.",
      urlInvalid:
        "Jeder Check braucht eine https-URL, deren Host ein vollständiger Domainname oder eine IP-Adresse ist, ohne Benutzername oder Passwort, mit höchstens 2.048 Zeichen.",
      urlSecret:
        "Eine Check-URL darf kein Geheimnis in ihrer Query tragen (einen Key-, Token-, Signatur-, Passwort- oder ähnlichen Parameter, wie in einer signierten URL): Die Konfiguration wird nicht verschlüsselt und alle im Workspace sehen sie. Checks, die Zugangsdaten brauchen, werden noch nicht unterstützt.",
      urlFragment:
        "Eine Check-URL darf kein Fragment haben (den Teil nach #): Es wird nie an die Seite gesendet und kann ein Token tragen, das alle im Workspace sehen würden. Entfern es aus der URL.",
      nameDuplicate:
        "Jeder Check braucht einen Namen, und zwar einen eigenen: Zwei Checks einer Verbindung können nicht gleich heißen.",
      statusInvalid:
        "Erwarteter Status: ein Code (200), ein Bereich (200-299), eine Klasse (2xx) oder bis zu zehn davon durch Kommas getrennt, alle zwischen 100 und 599.",
      textInvalid:
        "Erwarteter Text geht nur mit GET: Eine HEAD-Anfrage hat keinen Inhalt, in dem netrics suchen könnte.",
      headersInvalid:
        "Request-Header: ein „Name: Wert“ pro Zeile, höchstens zehn. Header mit Geheimnissen (Authorization, Cookie oder ein Name mit key, token, secret, auth, session, password oder signature) sowie Host, Content-Length, Connection und Transfer-Encoding sind nicht erlaubt: Die Konfiguration wird nicht verschlüsselt.",
    },
    connection: {
      credentialsHostChanged:
        "Die gespeicherten Zugangsdaten wurden für einen anderen Host eingegeben. Gib sie für diesen Host erneut ein, in einer neuen Verbindung.",
    },
    customApi: {
      unauthorized:
        "Die API hat die Zugangsdaten abgelehnt (HTTP 401). Gib für diese Verbindung einen neuen Schlüssel, ein neues Token oder Passwort ein oder verbinde sie neu.",
      forbidden:
        "Die API hat den Zugriff verweigert (HTTP 403). Prüf, ob diese Zugangsdaten die Endpunkte dieser eigenen API lesen dürfen.",
      hostChanged:
        "Die Zugangsdaten dieser Verbindung gelten für einen anderen API-Host. Gib sie für die Umgebung der Verbindung erneut ein.",
      notJson:
        "Die API hat nicht mit JSON geantwortet. Prüf die Basis-URL und den Anfragepfad.",
      recordsNotList:
        "Der Datensatzpfad zeigt in der Antwort nicht auf eine Liste oder ein Objekt. Wähl die Datensätze in der Definition erneut aus.",
      nextUrlOffHost:
        "Der Link zur nächsten Seite zeigt auf einen anderen Host. netrics folgt Links zur nächsten Seite nur auf dem API-Host.",
      pageLimit:
        "Der Lauf wurde nach 200 Seiten beendet, so viele liest ein Lauf höchstens. Die bisherigen Daten bleiben erhalten; der nächste Lauf macht weiter.",
      recordLimit:
        "Der Lauf wurde nach 100.000 Datensätzen beendet, so viele liest ein Lauf höchstens. Die bisherigen Daten bleiben erhalten; der nächste Lauf macht weiter.",
      durationLimit:
        "Der Lauf wurde nach 30 Minuten beendet, so lange dauert ein Lauf höchstens. Die bisherigen Daten bleiben erhalten; der nächste Lauf macht weiter.",
      tokenRefused:
        "Der Token-Endpunkt hat Client-ID oder Client-Secret abgelehnt. Prüf beide Werte und gib sie erneut ein.",
      scopeRefused:
        "Der Token-Endpunkt hat nicht alle Scopes gewährt, die diese API braucht. Prüf die Berechtigungen des Clients beim Anbieter und gib Client-ID und Client-Secret erneut ein.",
      graphqlErrors:
        "Die GraphQL-API hat mit Fehlern geantwortet. Prüf die Abfrage und ihre Variablen in der Definition.",
    },
  },
};
