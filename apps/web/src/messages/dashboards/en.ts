/**
 * The dashboards page (ADR 0018, design 3a; #304): cards with thumbnails,
 * the templates row and the project filter.
 */
export const dashboardsEn = {
  dashboardsPage: {
    meta: "{count, plural, =0 {No dashboards yet} one {# dashboard} other {# dashboards}}",
    metaLive:
      "{count, plural, one {# dashboard} other {# dashboards}} · {live} live on screens",
    projectFilter: "Project",
    allProjects: "All projects",
    noProject: "No project",
    newDashboard: "New dashboard",
    templates: "Start from a template",
    template: {
      overview: { title: "Overview", text: "Built from your sources" },
      brand: { title: "Brand", text: "One app, its icon and colour" },
      blank: { title: "Blank", text: "An empty slide" },
    },
    startWith: "Start with {name}",
    create: "New dashboard",
    closeCreate: "Close",
    list: "Your dashboards",
    slides: "{count, plural, one {# slide} other {# slides}}",
    updated: "updated {time}",
    onScreens: "{count, plural, one {On # screen} other {On # screens}}",
    notShown: "Not shown",
    theme: "Theme: {name}",
    openInStudio: "Open in Studio",
    openInStudioNamed: "Open {name} in Studio",
    thumbnail: "Preview of {name}",
    empty: {
      title: "No dashboards yet",
      text: "Start from a template above. The Overview fills itself with the numbers of your sources.",
      readOnly: "Nobody has made a dashboard in this workspace yet.",
    },
    emptyFilter: "No dashboards in this project yet.",
    projects: {
      summary: "Manage projects",
      count:
        "{count, plural, =0 {none yet} one {# project} other {# projects}}",
    },
  },
} as const;
