import type { Catalog } from "@netrics/domain";

import type { authEn } from "./en";

/** Auth and onboarding in German; glossary in ../de.ts. */
export const authDe: Catalog<typeof authEn> = {
  home: {
    title: "Willkommen, {name}",
    pageTitle: "Willkommen",
    noWorkspace:
      "Du bist noch in keinem Workspace Mitglied – erstelle den ersten.",
    workspaceName: "Name des Workspaces",
    withDemo: "Demodaten und ein Beispiel-Dashboard hinzufügen",
    withDemoHint:
      "– erzeugte Zahlen zum Ausprobieren; du kannst sie jederzeit löschen.",
    create: "Workspace erstellen",
  },
  authFields: {
    name: "Name",
    email: "E-Mail",
    password: "Passwort",
  },
  login: {
    title: "Anmelden",
    subtitle: "Melde dich bei deinem netrics-Konto an",
    submit: "Anmelden",
    pending: "Wird angemeldet…",
    forgot: "Passwort vergessen?",
    noAccount: "Noch kein Konto? {link}",
    createOne: "Konto erstellen",
  },
  signup: {
    title: "Konto erstellen",
    subtitle: "Registriere dich bei netrics",
    submit: "Konto erstellen",
    pending: "Konto wird erstellt…",
    haveAccount: "Du hast schon ein Konto? {link}",
    signIn: "Anmelden",
    closedTitle: "Registrierung geschlossen",
    closedText:
      "Konten auf dieser Installation werden per Einladung erstellt. Bitte einen Admin, dich einzuladen.",
  },
  setup: {
    title: "netrics einrichten",
    subtitle:
      "Erstelle das erste Konto. Es wird Inhaber deines ersten Workspaces.",
    token: "Einrichtungs-Token",
    tokenHint:
      "Das Einrichtungs-Token steht beim Start der Installation im API-Log oder wurde von deinem Betreiber als NETRICS_SETUP_TOKEN gesetzt.",
    submit: "Inhaber-Konto erstellen",
    pending: "Wird eingerichtet…",
    invalidToken:
      "Das Einrichtungs-Token ist ungültig oder wurde schon verwendet.",
  },
  passwordReset: {
    forgotTitle: "Passwort zurücksetzen",
    forgotSubtitle:
      "Wir schicken dir per E-Mail einen Link, mit dem du ein neues Passwort wählst",
    send: "Link senden",
    sending: "Wird gesendet…",
    sent: "Falls es ein Konto mit dieser Adresse gibt, haben wir einen Link zum Zurücksetzen des Passworts geschickt. Er ist {hours, plural, one {# Stunde} other {# Stunden}} gültig.",
    tooManyRequests:
      "Zu viele Anfragen. Warte ein paar Minuten und versuch es dann noch einmal.",
    sendFailed:
      "Wir konnten die E-Mail nicht senden. Versuch es später noch einmal.",
    remembered: "Doch wieder eingefallen? {link}",
    signIn: "Anmelden",
    resetTitle: "Neues Passwort wählen",
    resetSubtitle: "Lege das Passwort für dein netrics-Konto fest",
    invalidLink: "Dieser Link zum Zurücksetzen ist ungültig oder abgelaufen.",
    missingLink: "Diese Seite braucht den Link aus der E-Mail.",
    requestNew: "Neuen Link anfordern",
    backToSignIn: "Zurück zur Anmeldung",
    newPassword: "Neues Passwort",
    confirmPassword: "Neues Passwort bestätigen",
    minLengthHint: "Mindestens {count} Zeichen.",
    submit: "Neues Passwort festlegen",
    saving: "Wird gespeichert…",
    done: "Passwort geändert. Andere Sitzungen wurden abgemeldet. {link} mit dem neuen Passwort.",
    mismatch: "Die Passwörter stimmen nicht überein.",
  },
  invite: {
    notFoundTitle: "Einladung nicht gefunden",
    notFoundText:
      "Dieser Link ist ungültig. Prüf, ob du ihn vollständig kopiert hast.",
    title: "{workspace} beitreten",
    accepted: "Diese Einladung wurde schon verwendet.",
    revoked: "Diese Einladung wurde zurückgezogen. Bitte um eine neue.",
    expired: "Diese Einladung ist abgelaufen. Bitte um eine neue.",
    invitedAs: "Du wurdest als {role} mit {email} eingeladen.",
    haveAccount: "Du hast schon ein Konto für {email}? {link}",
    signIn: "Anmelden",
    wrongAccount:
      "Du bist als {signedIn} angemeldet, aber diese Einladung gilt für {invited}.",
    signOut: "Abmelden",
    accept: "Einladung annehmen",
    joining: "Wird beigetreten…",
    createAndJoin: "Konto erstellen und beitreten",
    creating: "Konto wird erstellt…",
  },
  authErrors: {
    invalidCredentials: "E-Mail und Passwort passen zu keinem Konto.",
    wrongPassword: "Das aktuelle Passwort ist nicht richtig.",
    invalidEmail: "Gib eine gültige E-Mail-Adresse ein.",
    userExists:
      "Mit dieser E-Mail gibt es schon ein Konto. Melde dich stattdessen an.",
    passwordTooShort: "Verwende mindestens {count} Zeichen.",
    passwordTooLong: "Verwende höchstens {count} Zeichen.",
    signupDisabled:
      "Die Registrierung ist auf dieser Installation deaktiviert.",
    emailNotVerified: "Bestätige zuerst deine E-Mail-Adresse.",
    sessionExpired: "Deine Sitzung ist abgelaufen – melde dich erneut an.",
    invalidToken: "Dieser Link ist ungültig oder abgelaufen.",
    tooManyAttempts:
      "Zu viele Versuche. Warte ein paar Minuten und versuch es dann noch einmal.",
    signInFailed: "Die Anmeldung ist fehlgeschlagen. Versuch es noch einmal.",
    signUpFailed:
      "Die Registrierung ist fehlgeschlagen. Versuch es noch einmal.",
    setupFailed: "Die Einrichtung ist fehlgeschlagen. Versuch es noch einmal.",
    changePasswordFailed:
      "Das Passwort konnte nicht geändert werden. Versuch es noch einmal.",
    generic: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
  },
};
