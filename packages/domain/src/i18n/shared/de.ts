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
  others: "Andere",
  sources: "Quellen",
  none: "(keine)",
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
};
