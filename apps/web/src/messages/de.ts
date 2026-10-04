import type { Catalog } from "@netrics/domain";

import type { WebMessages } from "./en";

/**
 * German (ADR 0016): informal "du", sentence case.
 *
 * Glossary (extend with each area): Workspace, Dashboard, Widget, Studio,
 * Connector stay; connection → Verbindung; slide → Folie; screen →
 * Bildschirm; sign in → anmelden; settings → Einstellungen; owner, admin,
 * editor, viewer → Inhaber, Admin, Bearbeiter, Betrachter.
 */
export const de: Catalog<WebMessages> = {
  common: {
    save: "Speichern",
    saving: "Wird gespeichert…",
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
  account: {
    title: "Konto",
    profile: "Profil",
    name: "Name",
    email: "E-Mail",
    memberships: "Workspace-Mitgliedschaften",
    noMemberships: "Noch keine Mitgliedschaften.",
    changePassword: "Passwort ändern",
    currentPassword: "Aktuelles Passwort",
    newPassword: "Neues Passwort",
    changing: "Wird geändert…",
    passwordChanged: "Passwort geändert.",
    passwordChangeFailed: "Das Passwort konnte nicht geändert werden.",
    session: "Sitzung",
    signOut: "Abmelden",
    signingOut: "Wird abgemeldet…",
    language: {
      title: "Sprache",
      label: "Sprache",
      automatic: "Automatisch ({language})",
      hint: "Die Sprache, in der netrics für dich erscheint. Automatisch folgt der Vorgabe dieser Installation, sonst deinem Browser.",
      saved: "Sprache gespeichert.",
    },
  },
  workspaceSettings: {
    screenLanguage: {
      label: "Bildschirmsprache",
      automatic: "Vorgabe der Installation ({language})",
      hint: "Kiosks und Apple TVs dieses Workspaces zeigen Beschriftungen in dieser Sprache. Jedes Mitglied wählt seine eigene Sprache unter Konto.",
    },
  },
  errors: {
    generic: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
  },
};
