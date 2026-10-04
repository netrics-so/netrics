import type { Catalog } from "@netrics/domain";

import type { screensEn } from "./en";

/** The Screens page in German; glossary in ../de.ts. */
export const screensDe: Catalog<typeof screensEn> = {
  screens: {
    title: "Alle Bildschirme",
    connectTv: "TV verbinden",
    views: "Ansicht",
    cards: "Karten",
    table: "Tabelle",
    online: "Online",
    offline: "Offline",
    revoked: "Widerrufen",
    noDashboard: "Kein Dashboard",
    emptyTitle: "Noch keine Bildschirme",
    emptyBody:
      "Öffne netrics auf einem TV oder im Browser des Bildschirms: Er zeigt einen kurzen Code. Bestätige den Code hier und wähle das Dashboard, das der Bildschirm zeigt.",
    emptyViewer:
      "Inhaber und Admins verbinden TVs. Sobald einer verbunden ist, erscheint er hier.",
    revokedSection:
      "{count, plural, one {# widerrufener Bildschirm} other {# widerrufene Bildschirme}}",
    selectHint:
      "Wähle einen Bildschirm, um seine Einstellungen und seinen Zustand zu sehen.",
    details: "Details zum Bildschirm",
    close: "Details schließen",
    settings: "Einstellungen",
    health: "Zustand",
    status: "Status",
    lastSeen: "Zuletzt gesehen",
    app: "App",
    heartbeat: "{version} · Lebenszeichen {time}",
    noHeartbeat: "Noch kein Lebenszeichen",
    lastError: "Letzter Fehler",
    noError: "Keiner gemeldet",
    screen: "Bildschirm",
    screenNotReported: "Noch nicht gemeldet",
    screenSize: "{width} × {height}",
    paired: "Verbunden",
    dashboard: "Dashboard",
    revokedNote: "Widerrufen {time}. Dieser Bildschirm zeigt keine Daten mehr.",
    readOnly:
      "Nur Inhaber und Admins ändern die Einstellungen eines Bildschirms.",
    columns: {
      name: "Name",
      status: "Status",
      dashboard: "Dashboard",
      lastSeen: "Zuletzt gesehen",
      app: "App",
      screen: "Bildschirm",
    },
  },
};
