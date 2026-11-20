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
  },
};
