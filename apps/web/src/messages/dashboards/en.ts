/**
 * The dashboards page (ADR 0018, design 3a; #304): cards with thumbnails,
 * the templates row and the project filter.
 */
export const dashboardsEn = {
  storeTemplate: {
    googlePlay: "Google Play",
    appStoreConnect: "App Store Connect",
    title: "App portfolio",
    subtitle:
      "Downloads, proceeds and store ratings, with shared filters and editable measures.",
    back: "Back to dashboards",
    roleCannot:
      "A workspace editor, admin or owner can install these templates.",
    defaultName: "App portfolio",
    loading: "Loading store connections…",
    loadFailed: "Connections could not be loaded.",
    retry: "Try again",
    empty: "Connect App Store Connect or Google Play to start.",
    connect: "Connect stores",
    name: "Dashboard name",
    connections: "1. Choose connections",
    connectionsHelp:
      "One connection can include many apps. Collected history stays available even after an app is deselected for future imports.",
    finishSetup: "Finish setup",
    appsCached: "{count, plural, one {# known app} other {# known apps}}",
    refreshApps: "Refresh app names",
    refreshing: "Finding apps…",
    cachedFallback:
      "Some app lists could not be refreshed. Known names and retained data remain available; check the affected connection if an app is missing.",
    scope: "2. Choose the overview",
    portfolio: "All apps in these connections",
    single: "One app or linked product",
    chooseApp: "Choose an app",
    scopeHelp:
      "A linked product includes every app you confirm below. Its ratings remain separate for each store listing.",
    mapping: "3. Link the same product across stores",
    mappingHelp:
      "Apps keep separate identities by default. Confirm a link only when these listings belong to the same product. Matching names are suggestions, never automatic links.",
    addGroup: "Link apps",
    groupName: "Product name",
    removeGroup: "Remove link",
    searchApps: "Search apps by name or ID",
    selectedApps: "{count, plural, one {# app linked} other {# apps linked}}",
    noApps:
      "No matching apps. Refresh the app names or finish connecting the account.",
    previous: "Previous",
    next: "Next",
    page: "Page {page} of {pages}",
    suggestion: "Link “{name}” across stores",
    moreSuggestions: "More suggestions",
    review: "Review dashboard",
    edit: "Edit setup",
    reviewTitle: "Ready to create",
    reviewHelp:
      "These definitions become normal preparations, measures and widgets. You can edit them in Data & measures and Studio.",
    allHistory:
      "The initial dashboard uses all retained history. Use its date filter to narrow the period.",
    downloadsDefinition:
      "Apple: units classified as first downloads. Google: daily user installs. The store stays separate because these definitions differ.",
    proceedsDefinition:
      "Apple: units × developer proceeds per unit. Google: all signed merchant amounts, including fees, refunds and adjustments. Currencies stay separate.",
    ratingsDefinition:
      "Latest captured score and count for each store listing and country. Scores are never averaged across apps or stores. Public Google Play ratings are best-effort and may be unavailable.",
    missingDefinition:
      "Reports can arrive late. Known values remain visible as partial; pending and missing values are not zero. Unallocated account rows remain separate from apps.",
    create: "Create editable dashboard",
    creating: "Creating dashboard…",
    unsaved: "This dashboard setup has not been saved. Leave this page?",
    invalid:
      "Choose a connection and a dashboard name. Each linked app needs one product name and can belong to only one link.",
    appRequired: "Choose the app to focus on.",
    mappingRequired:
      "Choose at least one app and enter a name for every linked product.",
    appDashboard: "Create app dashboard",
    templateCard: "Apple and Google Play, ready to customize",
  },
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
