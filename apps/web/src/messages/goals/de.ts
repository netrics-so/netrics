import type { Catalog } from "@netrics/domain";

import type { goalsEn } from "./en";

/** The Goals page in German; glossary in ../de.ts (goal → Ziel). */
export const goalsDe: Catalog<typeof goalsEn> = {
  goals: {
    metaTitle: "Ziele · netrics",
    title: "Ziele",
    meta: "{count, plural, =0 {Noch keine Ziele} one {# Ziel} other {# Ziele}}",
    metaReached:
      "{count, plural, one {# Ziel} other {# Ziele}} · {reached} erreicht",
    newGoal: "Neues Ziel",
    list: "Deine Ziele",
    empty: {
      title: "Noch keine Ziele",
      text: "Ein Ziel ist ein Zielwert für eine Metrik in einem Zeitraum, etwa 15.000 Downloads in diesem Monat. Anzeigen auf deinen Dashboards zeigen, wie weit es ist.",
      readOnly: "Bearbeiter, Admins und Inhaber können Ziele anlegen.",
    },
    noMetrics:
      "Noch keine deiner Quellen hat eine Metrik, der ein Ziel folgen kann. Verbinde zuerst eine Quelle.",
    period: "Zeitraum",
    progressLabel: "{name}: {percent} des Zielwerts",
    valueOfTarget: "{value} von {target}",
    toGo: "noch {amount}",
    reached: "Erreicht",
    reachedOn: "Erreicht am {date}",
    noData: "In diesem Zeitraum noch keine Daten",
    unavailable: "Der Fortschritt lässt sich gerade nicht lesen",
    approximate: "Ungefähr: zu EZB-Referenzkursen umgerechnet",
    edit: "Bearbeiten",
    editNamed: "{name} bearbeiten",
    delete: "Löschen",
    deleteNamed: "{name} löschen",
    confirmDelete: "„{name}“ löschen?",
    usedOn:
      "{count, plural, one {Wird auf # Dashboard verwendet: {names}.} other {Wird auf # Dashboards verwendet: {names}.}} Die Anzeigen dort zeigen dann „Ziel gelöscht“.",
    notUsed: "Kein Dashboard zeigt es.",
    deleteConfirmed: "Ziel löschen",
    form: {
      createTitle: "Neues Ziel",
      editTitle: "Ziel bearbeiten",
      name: "Name",
      namePlaceholder: "Downloads im Monat",
      target: "Zielwert",
      targetHelp: "Was die Metrik bis zum Ende jedes Zeitraums erreichen soll.",
      targetHelpLast:
        "Was der neueste Wert der Metrik in jedem Zeitraum erreichen soll.",
      targetInvalid: "Gib einen Zielwert über null ein.",
      create: "Ziel anlegen",
      save: "Ziel speichern",
      versionConflict:
        "Jemand anderes hat dieses Ziel inzwischen geändert. Lade die Seite neu, um die Änderungen zu sehen.",
    },
  },
};
