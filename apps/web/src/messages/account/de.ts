import type { Catalog } from "@netrics/domain";

import type { accountEn } from "./en";

export const accountDe: Catalog<typeof accountEn> = {
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
};
