/**
 * The web app's English messages: the source catalog (ADR 0016). Every
 * other language is typed against this one. ICU MessageFormat subset:
 * `{arg}`, `{n, plural, …}`, `{x, select, …}`; see @netrics/domain i18n.
 * Group keys by area; add an area's strings when the area is translated.
 */
export const en = {
  common: {
    save: "Save",
    saving: "Saving…",
    roles: {
      owner: "owner",
      admin: "admin",
      editor: "editor",
      viewer: "viewer",
    },
  },
  nav: {
    status: "Status",
    signIn: "Sign in",
    account: "Account",
  },
  account: {
    title: "Account",
    profile: "Profile",
    name: "Name",
    email: "Email",
    memberships: "Workspace memberships",
    noMemberships: "No memberships yet.",
    changePassword: "Change password",
    currentPassword: "Current password",
    newPassword: "New password",
    changing: "Changing…",
    passwordChanged: "Password changed.",
    passwordChangeFailed: "Could not change password.",
    session: "Session",
    signOut: "Sign out",
    signingOut: "Signing out…",
    language: {
      title: "Language",
      label: "Language",
      automatic: "Automatic ({language})",
      hint: "The language of netrics for you. Automatic follows this installation's default, else your browser.",
      saved: "Language saved.",
    },
  },
  workspaceSettings: {
    screenLanguage: {
      label: "Screen language",
      automatic: "Installation default ({language})",
      hint: "Kiosks and Apple TVs of this workspace show labels in this language. Each member picks their own language under Account.",
    },
  },
  errors: {
    generic: "Something went wrong. Try again.",
  },
} as const;

export type WebMessages = typeof en;
