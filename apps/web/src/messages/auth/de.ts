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
    newTitle: "Neuer Workspace",
    newSubtitle:
      "Ein Workspace hat eigene Dashboards, Quellen, Bildschirme und ein eigenes Team.",
  },
  authFields: {
    name: "Name",
    email: "E-Mail",
    password: "Passwort",
  },
  onboarding: {
    pageTitle: "Los geht’s",
    tagline: "Deine erste Zahl auf einem Bildschirm in etwa fünf Minuten.",
    stepsLabel: "Einrichtungsschritte",
    steps: {
      workspace: "Workspace erstellen",
      source: "Quelle verbinden",
      screen: "Auf einem Bildschirm zeigen",
    },
    done: "(erledigt)",
    railNote:
      "Du kannst jeden Schritt überspringen – mit Demodaten ist dein erstes Dashboard nicht leer.",
    source: {
      title: "Verbinde deine erste Quelle",
      subtitle:
        "Wähle eine für den Anfang. Weitere kannst du später unter Quellen hinzufügen.",
      choicesLabel: "Quellen",
      demoName: "Mit Demodaten ausprobieren",
      demoText: "Erzeugte Zahlen und ein Beispiel-Dashboard",
      demoReady: "Schon in diesem Workspace",
      unavailable: "Auf dieser Installation nicht eingerichtet",
      explainOAuth:
        "netrics bittet {name} um Lesezugriff. Im nächsten Schritt wählst du, was synchronisiert wird, und du kannst den Zugriff jederzeit widerrufen: Trenne die Quelle hier oder entferne netrics in deinem Konto beim Anbieter.",
      explainKey:
        "netrics liest nur Kennzahlen von {name}, mit dem Schlüssel, den du im nächsten Schritt eingibst. Der Schlüssel wird verschlüsselt gespeichert; wenn du die Quelle löschst, wird er entfernt.",
      explainNone:
        "netrics liest nur Kennzahlen von {name} und ändert dort nichts. Du kannst die Quelle jederzeit löschen.",
      explainDemo:
        "Demodaten erzeugt netrics selbst: kein Konto und kein Zugriff auf deine Daten. Du kannst sie jederzeit unter Quellen entfernen.",
      skip: "Überspringen, Demodaten nutzen",
      continue: "Weiter",
      continueWith: "Weiter mit {name}",
      adding: "Demodaten werden hinzugefügt…",
      demoFailed:
        "Die Demodaten konnten nicht hinzugefügt werden. Versuch es noch einmal oder verbinde stattdessen eine Quelle.",
    },
    screen: {
      title: "Auf einem Bildschirm zeigen",
      subtitle:
        "Kopple einen TV oder einen beliebigen Browser mit diesem Workspace. Er zeigt dein Dashboard im Vollbild und hält es aktuell.",
      open: "Öffne auf dem TV die netrics-App (Apple TV) oder einen Browser mit {url}.",
      code: "Der Bildschirm zeigt einen Kopplungscode.",
      enter: "Gib den Code unter „TV verbinden“ ein und wähle das Dashboard.",
      askAdmin:
        "Bitte einen Inhaber oder Admin dieses Workspaces, einen TV zu verbinden.",
      connectTv: "TV verbinden",
      openDashboard: "Mein Dashboard öffnen",
      connectSource: "Quelle verbinden",
    },
  },
  login: {
    title: "Anmelden",
    heading: "Willkommen zurück",
    subtitle:
      "Deine Bildschirme laufen. Melde dich an, um zu ändern, was sie zeigen.",
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
