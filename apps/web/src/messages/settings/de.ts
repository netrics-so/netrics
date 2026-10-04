import type { Catalog } from "@netrics/domain";

import type { settingsEn } from "./en";

/** Settings and administration in German; glossary in ../de.ts. */
export const settingsDe: Catalog<typeof settingsEn> = {
  workspaceSettings: {
    screenLanguage: {
      label: "Bildschirmsprache",
      automatic: "Vorgabe der Installation ({language})",
      hint: "Kiosks und Apple TVs dieses Workspaces zeigen Beschriftungen in dieser Sprache. Jedes Mitglied wählt seine eigene Sprache unter Konto.",
    },
  },
};
