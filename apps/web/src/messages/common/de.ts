import type { Catalog } from "@netrics/domain";

import type { commonEn } from "./en";

export const commonDe: Catalog<typeof commonEn> = {
  common: {
    save: "Speichern",
    saving: "Wird gespeichert…",
    cancel: "Abbrechen",
    close: "Schließen",
    back: "Zurück",
    continue: "Weiter",
    edit: "Bearbeiten",
    delete: "Löschen",
    deleting: "Wird gelöscht…",
    remove: "Entfernen",
    removing: "Wird entfernt…",
    create: "Erstellen",
    creating: "Wird erstellt…",
    add: "Hinzufügen",
    copy: "Kopieren",
    copied: "Kopiert",
    done: "Fertig",
    loading: "Wird geladen…",
    retry: "Erneut versuchen",
    optional: "optional",
    none: "Keine",
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
  errors: {
    generic: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
  },
};
