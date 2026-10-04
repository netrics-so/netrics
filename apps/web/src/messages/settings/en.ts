/**
 * Workspace settings, themes, the status page, the deploy notice and error
 * pages (#254). Top-level groups here must not collide with other areas'
 * (the aggregate catalog test checks).
 */
export const settingsEn = {
  workspaceSettings: {
    screenLanguage: {
      label: "Screen language",
      automatic: "Installation default ({language})",
      hint: "Kiosks and Apple TVs of this workspace show labels in this language. Each member picks their own language under Account.",
    },
  },
} as const;
