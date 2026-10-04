/**
 * The workspace app shell (ADR 0018 section 4, #302): sidebar, workspace
 * switcher, top bar and account menu.
 */
export const shellEn = {
  shell: {
    home: "netrics home",
    sidebar: "Workspace",
    rail: "Workspace areas",
    topBar: "Top bar",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    workspace: {
      switcher: "Switch workspace (current: {name})",
      list: "Your workspaces",
      current: "current",
      new: "New workspace",
    },
    sections: {
      dashboards: "Dashboards",
      sources: "Sources",
      screens: "Screens",
    },
    items: {
      home: "Home",
      dashboards: "All dashboards",
      goals: "Goals",
      themes: "Themes",
      sources: "Connected",
      addSource: "Add source",
      screens: "All screens",
      team: "Team",
      settings: "Settings",
    },
    /** Rail tooltips name the area, not the row. */
    railItems: {
      home: "Home",
      dashboards: "Dashboards",
      goals: "Goals",
      themes: "Themes",
      sources: "Sources",
      addSource: "Add source",
      screens: "Screens",
      team: "Team",
      settings: "Settings",
    },
    attentionDot: "needs attention",
    health: {
      fresh: "All sources fresh",
      none: "No sources yet",
      attention:
        "{count, plural, one {# source needs attention} other {# sources need attention}}",
    },
    account: {
      menu: "Account menu for {name}",
      settings: "Account settings",
      status: "Status",
      signOut: "Sign out",
      signingOut: "Signing out…",
    },
  },
} as const;
