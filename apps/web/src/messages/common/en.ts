/**
 * Words and messages every area uses, plus the nav. Keep this small: an
 * area's own text belongs in the area's module.
 */
export const commonEn = {
  common: {
    save: "Save",
    saving: "Saving…",
    cancel: "Cancel",
    close: "Close",
    back: "Back",
    continue: "Continue",
    edit: "Edit",
    delete: "Delete",
    deleting: "Deleting…",
    remove: "Remove",
    removing: "Removing…",
    create: "Create",
    creating: "Creating…",
    add: "Add",
    copy: "Copy",
    copied: "Copied",
    done: "Done",
    loading: "Loading…",
    retry: "Try again",
    optional: "optional",
    none: "None",
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
  errors: {
    generic: "Something went wrong. Try again.",
  },
} as const;
