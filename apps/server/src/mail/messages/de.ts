import type { Catalog } from "@netrics/domain";

import type { MailMessages } from "./en.js";

/**
 * Email subjects and bodies in German (ADR 0016): informal "du", sentence
 * case; glossary as in apps/web/src/messages/de.ts.
 */
export const de: Catalog<MailMessages> = {
  layout: {
    linkHint:
      "Falls der Button nicht funktioniert, öffne diesen Link in deinem Browser:",
    footer: "Gesendet von netrics.",
  },
  verification: {
    subject: "Bestätige deine E-Mail-Adresse",
    intro: "Bestätige deine E-Mail-Adresse für netrics:",
    action: "E-Mail-Adresse bestätigen",
    ignore:
      "Wenn du kein Konto erstellt hast, kannst du diese E-Mail ignorieren.",
  },
  passwordReset: {
    subject: "Setze dein Passwort zurück",
    intro: "Setze dein netrics-Passwort zurück:",
    action: "Passwort zurücksetzen",
    expiry:
      "Der Link ist {hours, plural, one {# Stunde} other {# Stunden}} gültig und funktioniert nur einmal.",
    ignore:
      "Wenn du das Zurücksetzen nicht angefordert hast, kannst du diese E-Mail ignorieren; dein Passwort bleibt unverändert.",
  },
  invitation: {
    subject: "{inviterName} hat dich zu {workspaceName} auf netrics eingeladen",
    intro:
      "{inviterName} hat dich eingeladen, dem Workspace „{workspaceName}“ auf netrics beizutreten.",
    action: "Einladung annehmen",
    expiry: "Der Link ist {days, plural, one {# Tag} other {# Tage}} gültig.",
    ignore:
      "Wenn du diese Einladung nicht erwartet hast, kannst du diese E-Mail ignorieren.",
    someone: "Ein Workspace-Admin",
  },
};
