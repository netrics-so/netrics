/**
 * The dashboards page (ADR 0018, design 3a; #304): cards with thumbnails,
 * the templates row and the projects section; lists follow the active
 * project (#573).
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
      "Latest score for each store listing and country, never averaged across apps or stores. Apple: score and count captured from the App Store for your storefront. Google Play: the rating from Play Console rating reports (all countries), as of the latest report day; the report has no rating count. The public Play Store listing only provides app names and artwork.",
    missingDefinition:
      "Reports can arrive late. Known values remain visible as partial; pending and missing values are not zero. Unallocated account rows remain separate from apps.",
    slidesDefinition:
      "An overview slide of all apps, then one slide per app with its icon: revenue for paid apps, downloads, ratings, the latest App Store review and the linked website's visitors. Screens move through the slides on their own.",
    tooManyApps:
      "{count} apps: a dashboard shows at most 12 slides, so the first apps by name get a slide of their own and the others appear on the overview only.",
    omittedApps:
      "The dashboard is ready. A dashboard shows at most 12 slides and 48 data widgets, so these apps appear on the overview only: {apps}.",
    openDashboard: "Open dashboard",
    create: "Create editable dashboard",
    creating: "Creating dashboard…",
    unsaved: "This dashboard setup has not been saved. Leave this page?",
    invalid:
      "Choose a connection and a dashboard name. Each linked app needs one product name and can belong to only one link.",
    appRequired: "Choose the app to focus on.",
    mappingRequired:
      "Choose at least one app and enter a name for every linked product.",
    appDashboard: "Create app dashboard",
    editTitle: "Change the apps of {name}",
    editSubtitle:
      "Add or remove store connections and choose which app the dashboard shows, without connecting anything again.",
    editRoleCannot:
      "A workspace editor, admin or owner can change the apps of a template dashboard.",
    editUnavailable:
      "The apps of this dashboard can’t be changed here. It was set up before templates had versions, and a store connection it used was deleted since.",
    editUpdateFirst:
      "The template has an update for this dashboard. Review it first, then change the apps.",
    editOpenUpdate: "Open the update",
    appSlidesUpdate:
      "The app slides follow these apps and settings after a dashboard update.",
    editConnectionsHelp:
      "Your own changes to preparations, measures and widgets stay. What follows from the apps is regenerated: new connections arrive as drafts, removed ones are detached and kept.",
    editMapping:
      "Product links stay in the mapping table of this dashboard, in Data & measures.",
    editMappingLink: "Edit product links in Data & measures",
    reviewChanges: "Review changes",
    planning: "Comparing…",
    editReviewTitle: "What changes",
    scopeUnchanged:
      "These are the apps the dashboard already uses. Change a connection or the app first.",
    templateCard: "Apple and Google Play, ready to customize",
    identity: "App identity",
    identityHelp:
      "The icon, paid or free, and the website of each app, for the app slides. Saved on their own, without a review.",
    identityEmpty: "No apps yet. They appear once a connection has synced.",
    useIcon: "Use app icon",
    iconLoading: "Getting icon…",
    iconsMissing:
      "{count, plural, one {# app icon could not be loaded.} other {# app icons could not be loaded.}}",
    iconsRetry: "Retry",
    iconsRetrying: "Loading icons…",
    pricing: "Paid or free",
    pricingAutoPaid: "Automatic (now paid: proceeds in the last 90 days)",
    pricingAutoFree: "Automatic (now free: no proceeds in the last 90 days)",
    pricingPaid: "Paid",
    pricingFree: "Free",
    pricingHelp:
      "Automatic counts an app as paid while it had proceeds in the last 90 days. A free app’s slide leaves revenue out.",
    website: "Website",
    websiteNone: "No website",
    websiteMissing: "Project no longer available",
    websiteConnect:
      "To show visitors per app, connect Vercel Web Analytics first.",
    identitySave: "Save app identity",
    identitySaving: "Saving…",
    identitySaved: "App identity saved.",
    identityPending:
      "The app identity below has unsaved changes. Applying opens the update next.",
    identitySaveAndApply: "Save them and apply",
    identityDiscardAndApply: "Discard them and apply",
    identityKeepEditing: "Keep editing",
    identityTooLarge:
      "App identity can’t be shown: these connections have more apps or website projects than this workspace’s row limit allows. You can still change the apps above, for example remove a connection.",
  },
  /** The Developer Portfolio template (#876). */
  developerTemplate: {
    title: "Developer portfolio",
    templateCard: "Uptime, deploys, spend and users per project",
    subtitle:
      "What is down, what shipped today, this month's spend and active users, with one slide per project. Numbers stay editable measures.",
    back: "Back to dashboards",
    roleCannot:
      "A workspace editor, admin or owner can install these templates.",
    defaultName: "Developer portfolio",
    empty:
      "Connect Railway, Vercel, Hetzner Cloud, HTTP checks, PostHog, Search Console, App Store Connect or Google Play to start.",
    connect: "Connect sources",
    name: "Dashboard name",
    connections: "1. Choose sources",
    connectionsHelp:
      "Any mix works: a source you leave out just leaves its numbers out.",
    projectsTitle: "2. Projects",
    projectsHelp:
      "Each project gets a slide. A source's resources belong to the project the connection is in; you can relink them later in the links table under Data.",
    noProjects:
      "This workspace has no projects yet: the dashboard starts with the overview only.",
    inProject: "Project: {name}",
    noProject: "No project",
    resources: "{count, plural, one {# resource} other {# resources}}",
    setupPending: "Finish setup",
    connectors: {
      railway: "Railway",
      vercel: "Vercel",
      "hetzner-cloud": "Hetzner Cloud",
      "http-check": "HTTP checks",
      posthog: "PostHog",
      "google-search-console": "Search Console",
      "app-store-connect": "App Store Connect",
      "google-play": "Google Play",
    },
    install: "Create dashboard",
    chosen:
      "{count, plural, one {# source} other {# sources}} chosen, at most {max}.",
    tooMany: "Choose at most {max} sources: one dashboard reads up to {max}.",
    installing: "Creating…",
    omitted: "The dashboard is full: {names} show in the overview only.",
    open: "Open the dashboard",
  },
  dashboardsPage: {
    meta: "{count, plural, =0 {No dashboards yet} one {# dashboard} other {# dashboards}}",
    metaLive:
      "{count, plural, one {# dashboard} other {# dashboards}} · {live} live on screens",
    activeProjectMeta: "In {project}",
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
      hiddenInArchived:
        "{count, plural, one {# dashboard is in an archived project.} other {# dashboards are in archived projects.}}",
      readOnly: "Nobody has made a dashboard in this workspace yet.",
    },
    emptyFilter: "No dashboards in this project yet.",
    projects: {
      summary: "Manage projects",
      overview:
        "Projects: {active, plural, =0 {none active} other {# active}}{archived, plural, =0 {} other { · # archived}}.",
      archived: "Archived",
      saving: "Saving…",
      savedTo: "Saved to {name}",
      savedNone: "Saved: no project",
      project: "Project",
      noProject: "No project",
    },
  },
  storeUpdate: {
    badge: "Update available",
    badgeNamed: "Update available for {name}: review it",
    studioAvailable: "The template has an update for this dashboard.",
    studioCopy:
      "This is the updated copy. Compare it with the original, then use it on your screens.",
    studioArchivedCopy:
      "This updated copy is archived because you switched back. Swap it in again from the update page.",
    studioArchived:
      "Archived while its updated copy is on your screens. Switch back to use and edit it again.",
    review: "Review the update",
    changeApps: "Change apps",
    openUpdate: "Open the update",
    dataBanner: "Template update for {name}",
    dataProgress:
      "{count, plural, one {# draft from the template update waits to be published.} other {# drafts from the template update wait to be published.}}",
    dataMark: "Update",
    archived: "Archived",
    archivedHint:
      "Originals kept while their updated copies are on your screens, so you can switch back. They are read-only.",
    switchBackLink: "Switch back",
    title: "Update {name}",
    back: "Back to dashboards",
    roleCannot:
      "A workspace editor, admin or owner can review and apply template updates.",
    versions: "Template version {from} → {to}",
    appsChanged:
      "Template version {version}: the app slides follow your apps and their settings.",
    unavailable:
      "Updates aren’t available for this dashboard. It was set up before templates had versions, and a store connection it used was deleted since, so netrics can’t tell your changes from the template’s. The dashboard keeps working as it is.",
    upToDate: "This dashboard is up to date with its template.",
    scopeIntro:
      "Nothing changes until you say so. The parts that follow from your apps are regenerated from your apps; we only ask where you edited them. Data changes become drafts you publish in data settings; a new app filter arrives as an updated dashboard copy you compare before it goes on your screens.",
    intro:
      "Nothing changes until you say so. Data changes become drafts you publish in data settings. Dashboard changes arrive as an updated copy you compare before it goes on your screens; your original is archived, so you can switch back.",
    steps: {
      label: "Progress",
      review: "Review and apply",
      publish: "Publish the data drafts",
      copy: "Create the updated dashboard",
      compare: "Compare in Studio",
      swap: "Use it on your screens",
      done: "done",
    },
    summary: {
      measures: {
        changed:
          "{count, plural, one {# measure changed} other {# measures changed}}",
        added:
          "{count, plural, one {# measure added} other {# measures added}}",
        removed:
          "{count, plural, one {# measure removed} other {# measures removed}}",
      },
      steps: {
        changed:
          "{count, plural, one {# step changed} other {# steps changed}}",
        added: "{count, plural, one {# step added} other {# steps added}}",
        removed:
          "{count, plural, one {# step removed} other {# steps removed}}",
      },
      widgets: {
        changed:
          "{count, plural, one {# widget changed} other {# widgets changed}}",
        added: "{count, plural, one {# widget added} other {# widgets added}}",
        removed:
          "{count, plural, one {# widget removed} other {# widgets removed}}",
      },
      changed: "{count} changed",
      added: "{count} added",
      removed: "{count} removed",
      conflicts:
        "{count, plural, one {# needs your choice} other {# need your choice}}",
      removals: "{count} proposed for removal",
      none: "No changes to measures, steps or widgets",
    },
    scopeNote:
      "{count, plural, one {# part follows your app selection} other {# parts follow your app selection}} (the combined app data and the app filter). They are regenerated from your apps, not reviewed.",
    groups: {
      choose: "Your choice",
      removal: "Proposed for removal",
      template: "From the template",
      customer: "Kept from you",
    },
    kinds: {
      preparation: "Preparation",
      model: "Measures",
      dashboard: "Dashboard",
    },
    newRecord: "New in this version",
    unpublishedDraft: "Includes your unpublished changes",
    useTemplate: "Use the template’s version",
    keepMine: "Keep mine",
    remove: "Remove",
    keep: "Keep",
    detach: "Detach (kept in Data & measures)",
    templateValue: "Template: {text}",
    yourValue: "Yours: {text}",
    absent: "removed",
    change: { added: "added", changed: "changed", removed: "removed" },
    why: {
      both: "You and the template both changed this.",
      templateRemoved: "The template removed this; you had changed it.",
      customerRemoved: "You removed this; the template changed it.",
      bothAdded: "You and the template both added this, differently.",
      removedDataset:
        "Taking the template’s version brings back {dataset}, which you removed from these measures.",
      removedDatasetUnknown:
        "Taking the template’s version brings back data you removed from these measures.",
      scopeRemoval:
        "This connection is no longer part of the dashboard. Its preparation is detached from the template and stays in Data & measures with your changes; it is never deleted.",
      proposeRemoval:
        "The new template no longer has this. You never changed it: remove it, or keep it as yours.",
    },
    item: {
      measure: "Measure {name} · {how}",
      dimension: "Dimension {name}",
      step: "{type} · {name}",
      stepUnnamed: "{type}",
      output: "Result {name}",
      relationship: "A relationship between datasets",
      widget: "Widget {title} · {type}",
      widgetUntitled: "{type} widget",
      filter: "Shared filter {name}",
      slide: "Slide {name}",
      slideUntitled: "A slide",
      setting: "Dashboard setting {name}",
      formula: "formula",
      rolling: "rolling window",
      period_offset: "earlier period",
      other: "calculated",
    },
    widgetTypes: {
      measure: "Measure",
      metric: "Metric",
      line: "Line chart",
      bar: "Bar chart",
      table: "Table",
      compare: "Comparison",
      gauge: "Gauge",
      image: "Image",
      text: "Text",
      clock: "Clock",
      status: "Status",
      countdown: "Countdown",
      review: "Review",
      widget: "Widget",
    },
    changes: {
      column: {
        added: "{count, plural, one {# new column} other {# new columns}}",
        changed:
          "{count, plural, one {# changed column} other {# changed columns}}",
        removed:
          "{count, plural, one {# column removed} other {# columns removed}}",
      },
      step: {
        added:
          "{count, plural, one {# new processing step} other {# new processing steps}}",
        changed:
          "{count, plural, one {# changed processing step} other {# changed processing steps}}",
        removed:
          "{count, plural, one {# processing step removed} other {# processing steps removed}}",
      },
      result: {
        added: "{count, plural, one {# new result} other {# new results}}",
        changed:
          "{count, plural, one {# changed result} other {# changed results}}",
        removed:
          "{count, plural, one {# result removed} other {# results removed}}",
      },
      measure: {
        added: "{count, plural, one {# new measure} other {# new measures}}",
        changed:
          "{count, plural, one {# changed measure} other {# changed measures}}",
        removed:
          "{count, plural, one {# measure removed} other {# measures removed}}",
      },
      dimension: {
        added:
          "{count, plural, one {# new dimension} other {# new dimensions}}",
        changed:
          "{count, plural, one {# changed dimension} other {# changed dimensions}}",
        removed:
          "{count, plural, one {# dimension removed} other {# dimensions removed}}",
      },
      widget: {
        added: "{count, plural, one {# new widget} other {# new widgets}}",
        changed:
          "{count, plural, one {# changed widget} other {# changed widgets}}",
        removed:
          "{count, plural, one {# widget removed} other {# widgets removed}}",
      },
      slide: {
        added: "{count, plural, one {# new slide} other {# new slides}}",
        changed:
          "{count, plural, one {# changed slide} other {# changed slides}}",
        removed:
          "{count, plural, one {# slide removed} other {# slides removed}}",
      },
      filter: {
        added:
          "{count, plural, one {# new shared filter} other {# new shared filters}}",
        changed:
          "{count, plural, one {# changed shared filter} other {# changed shared filters}}",
        removed:
          "{count, plural, one {# shared filter removed} other {# shared filters removed}}",
      },
      other: {
        added: "{count, plural, one {# other change} other {# other changes}}",
        changed:
          "{count, plural, one {# other change} other {# other changes}}",
        removed:
          "{count, plural, one {# other change} other {# other changes}}",
      },
      fromTemplate: "From the template: {changes}",
      kept: "{count, plural, one {Your own change stays as it is.} other {Your # own changes stay as they are.}}",
      details: "Show the changes in detail ({count})",
      times: "×{count}",
    },
    confirm: {
      cancel: "Cancel",
      swapTitle: "Use the updated dashboard?",
      swapBackTitle: "Switch back to your original?",
      closeTitle: "Stop this update?",
    },
    decided: "{done} of {total} decided",
    apply: "Apply as drafts",
    applying: "Applying…",
    applyHint:
      "Make a choice for every item under “Your choice” and “Proposed for removal” first.",
    nothingToDecide: "Nothing needs your choice.",
    reloaded:
      "The update changed since you opened it, so the review was reloaded. Check your choices, then apply again.",
    loading: "Loading the update…",
    retry: "Try again",
    done: {
      applied: "Applied as drafts. Publish them in data settings next.",
      copy: "Updated copy created. Compare it in Studio next.",
      swap: "Screens moved to the updated dashboard.",
      swapBack: "Screens moved back to your original.",
      close: "Update stopped. Its drafts stay as normal drafts.",
    },
    progress: {
      confirmSwapUnknown:
        "Move every screen that shows the original to the updated dashboard? The original is archived, and you can switch back.",
      confirmSwapBackUnknown:
        "Move every screen that shows the updated copy back to your original? The updated copy is archived, and you can use it again.",
      viewArchivedCopy: "View the archived updated copy",
      confirmSwap:
        "{count, plural, =0 {Use the updated dashboard? No screen shows the original yet.} one {Move # screen ({screens}) to the updated dashboard?} other {Move # screens ({screens}) to the updated dashboard?}} The original is archived, and you can switch back.",
      confirmSwapBack:
        "{count, plural, =0 {Switch back to your original?} one {Move # screen ({screens}) back to your original?} other {Move # screens ({screens}) back to your original?}} The updated copy is archived, and you can use it again.",
      publishIntro:
        "Open each draft in data settings, preview it and publish it there, in the order listed: each one reads the drafts above it. Before publishing, you see what depends on it.",
      noDrafts: "This update changes no data.",
      published: "Published",
      draft: "Draft, not published yet",
      stale:
        "Needs publishing again: it was published before the drafts above it and still reads their earlier versions",
      openDraft: "Open in data settings",
      checkAgain: "Check again",
      copyWaiting:
        "Publish every draft first: the updated dashboard shows published data only.",
      createCopy: "Create the updated dashboard",
      creating: "Creating…",
      copyHint:
        "A copy of {name} with the template’s changes and your choices. It is on no screen until you use it.",
      copyCreated: "Updated copy created.",
      noDashboards: "This update doesn’t change any dashboard.",
      openCopy: "Open the updated copy in Studio",
      openOriginal: "Open the original",
      afterCopy: "Available once the updated dashboard exists.",
      compareHint:
        "Compare the copy with your original. Edits you make to the copy are kept.",
      screens:
        "{count, plural, =0 {No screen shows this dashboard yet.} one {Moves # screen: {screens}} other {Moves # screens: {screens}}}",
      swap: "Use it on my screens",
      swapping: "Moving screens…",
      swapHint:
        "Every screen moves in one step. The original is archived, not deleted.",
      swapCannot: "A workspace admin or owner can move screens.",
      copyCannot:
        "A workspace editor, admin or owner can create the updated dashboard.",
      swapped:
        "The updated dashboard is on your screens. The original is archived.",
      switchBack: "Switch back",
      switchingBack: "Switching back…",
      switchBackHint:
        "Puts your original back on every screen and archives the updated copy.",
      switchedBack:
        "Your original is back on your screens. The updated copy is archived.",
      swapAgain: "Use the updated dashboard again",
      scopeProblems:
        "No screen moved: {screens} {count, plural, one {has a fixed scope} other {have a fixed scope}} the updated dashboard can’t show. Change the scope in Screens, then try again.",
      reviewChanged:
        "Your dashboard changed since you reviewed the update. Stop this update and review it again to decide on these items:",
      close: "Stop this update",
      closing: "Stopping…",
      closeConfirm:
        "Stop this update? Its data drafts stay as normal drafts, and nothing on your screens changes.",
      recreate: "Create the copy again",
      discardEdits: "Discard my edits to the copy and create it again",
      finished: "Update finished.",
      unmergeable:
        "The updated dashboard can’t be made with these widgets: {names}. Stop this update, then review it again and keep your version of them.",
      unmergeableData:
        "{name} can’t be updated with these choices: {names}. Choose differently for them, then apply again.",
    },
  },
} as const;
