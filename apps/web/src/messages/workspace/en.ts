/**
 * Workspace overview, projects, connections and devices (#252). Top-level
 * groups here must not collide with other areas' (the aggregate catalog
 * test checks).
 */
export const workspaceEn = {
  health: {
    states: {
      ok: "Healthy",
      auth_failed: "Auth failed",
      needs_reauthorization: "Needs reconnect",
      outage: "Outage",
      pending: "Pending",
    },
    authStates: {
      ok: "OK",
      auth_failed: "Auth failed",
      needs_reauthorization: "Needs reconnect",
      outage: "Outage",
    },
  },
  workspace: {
    connectTv: "Connect a TV",
    keyRemoved:
      "Connection deleted, together with netrics’ copy of its {name} key. The key itself stays valid until you revoke it.",
    keyRemovedUnnamed:
      "Connection deleted, together with netrics’ copy of its provider key. The key itself stays valid until you revoke it.",
    revokeIn: "Revoke it in {name}",
    revokeAtProvider: "Revoke it at the provider",
    yourRole: "Your role:",
    workspaces: "Workspaces",
    current: "{name} (current, {role})",
    settings: "Workspace settings",
    dashboards: "Dashboards",
    noDashboards: "No dashboards yet.",
    dashboardMeta:
      "{slides, plural, one {# slide} other {# slides}} · {widgets, plural, one {# widget} other {# widgets}} · updated {updated}",
    openInStudio: "Open {name} in Studio",
    studio: "Studio",
    tvs: "TVs",
    noTvs: "No TVs yet.",
    revoked: "Revoked",
    noDashboard: "No dashboard",
    lastSeen: "last seen {time}",
    heartbeat: "{version}, heartbeat {time}",
    lastError: "Last error: {error}",
    screenSize: "{width} × {height}",
    connections: "Connections",
    noConnections: "No connections yet.",
    table: {
      name: "Name",
      connector: "Connector",
      health: "Health",
      lastSuccess: "Last success",
      nextSync: "Next sync",
    },
    finishSetup: "Finish setup",
    addConnection: "Add connection",
    cannotCreateConnections:
      "Your role cannot create connections in this workspace.",
    projects: "Projects",
    noProjects: "No projects yet.",
    cannotCreateProjects: "Your role cannot create projects in this workspace.",
    newDashboard: {
      legend: "New dashboard",
      choices: {
        blank: { title: "Blank", text: "One empty slide to fill yourself." },
        overview: {
          title: "Overview",
          text: "Downloads, proceeds, reviews and web numbers of all connections.",
        },
        brand: {
          title: "Brand",
          text: "One app or site with its icon, colour and own numbers.",
        },
      },
      overviewEmpty:
        "Connect a source first: the Overview shows the numbers of your connections.",
      overviewFrom: "From {sources}. Only what is connected is shown.",
      brandEmpty:
        "No apps or sites yet: they appear once a connection has synced.",
      appOrSite: "App or site",
      chooseOne: "Choose one",
      accent: "Accent colour",
      fetchingIcon: "Fetching the app icon…",
      noIcon: "No icon available; you can upload a logo in the Studio.",
      readingColour: "Reading the icon’s colour…",
      tooLowContrast:
        "This colour is too hard to read on a TV ({ratio}:1, at least 3:1).",
      accentFromIcon: "Accent {accent} from the icon, {ratio}:1 on the theme.",
      themeAccent: "The theme’s accent colour is used.",
      name: "Name",
      placeholderOverview: "Overview",
      placeholderBrand: "The app’s name",
      placeholderBlank: "Sales",
      createFromTemplate: "Create from template",
    },
    newProject: {
      label: "New project",
      create: "Create project",
    },
  },
  devices: {
    name: "Name",
    dashboard: "Dashboard",
    noDashboard: "No dashboard",
    confirmRevoke: "Revoke {name}? It stops showing data immediately.",
    confirm: "Confirm",
    revoke: "Revoke",
    orientation: "Orientation",
    rotations: {
      r0: "Landscape",
      r90: "Portrait 90°",
      r180: "Upside down",
      r270: "Portrait 270°",
    },
    mode: "Mode",
    modes: {
      screen: "Screen view",
      scroll: "Scroll view",
    },
    appleTvMode: "Apple TV always uses Screen view.",
  },
  deviceApproval: {
    pageTitle: "Connect a TV · netrics",
    title: "Connect a TV",
    subtitle: "Enter the code shown on the TV and choose what it should show.",
    notAllowed:
      "Only workspace owners and admins can connect TVs. Ask one of them to enter the code, or to make you an admin.",
    connected: "{name} is connected.",
    showsSoon: "The TV shows the dashboard in a few seconds.",
    code: "Code on the TV",
    workspace: "Workspace",
    dashboard: "Dashboard",
    noDashboard: "None yet",
    name: "Name of the TV",
    nameExample: "For example “Office lobby”.",
    connecting: "Connecting…",
    connect: "Connect TV",
  },
  connections: {
    newPage: {
      pageTitle: "Add connection · netrics",
      title: "Add connection",
      roleCannot:
        "Your role ({role}) cannot create connections in this workspace.",
      back: "Back to workspace",
      finishSetup: "Finish setup",
    },
    detail: {
      back: "Back to workspace",
      setupFinished:
        "Setup finished. The first sync is queued and reads up to 16 months back; new data then arrives every few hours.",
      pausedCredentials:
        "Syncing is paused: this connection needs new credentials.",
      uploadNewKey: "Upload a new {name} key.",
      uploadNewKeyDetail:
        "netrics checks it first; saving it restarts syncing right away, and the data collected so far is kept.",
      askUploadKey:
        "Ask a workspace owner, admin or editor to upload a new {name} key.",
      restoreSearchConsole:
        "Restore the account’s permission for the property in Search Console, or choose another property below.",
      checkProviderPermissions:
        "Check the account’s permissions at the provider, or change the settings below.",
      enterToken: "Enter a new token below.",
      enterTokenDetail:
        "Saving it restarts syncing right away; the data collected so far is kept.",
      askUpdateCredentials:
        "Ask a workspace owner or admin to update the credentials.",
      health: "Health",
      authState: "Auth state",
      consecutiveFailures: "Consecutive failures",
      lastSuccess: "Last success",
      nextSync: "Next sync due",
      pollInterval: "Poll interval",
      providerAccount: "{provider} account",
      connectedAs: "Connected as {email}",
      connected: "Connected",
      credentials: "Credentials",
      credentialsStored: "stored",
      credentialsNone: "none",
      appStoreAbout: "About App Store Connect data",
      latestReportingDay: "Latest reporting day",
      noneYet: "None yet",
      appStoreTiming:
        "Sales arrive the next morning, Pacific Time (Apple publishes a day’s report by about 8 a.m. PT); App Store analytics follow about two days later. Reporting days are Pacific Time days, not your workspace’s time zone. Proceeds are kept in each currency Apple reports.",
      moreAboutConnector: "More about the connector",
      searchConsoleAbout: "About Search Console data",
      searchConsoleTiming:
        "Search Console data appears with a 2–3 day delay; the newest days are filled in once Google finalises them, so today and yesterday are usually empty. Click-through rate and average position are daily values: over several days they are not added up.",
      searchConsolePrivacy:
        "Search Console leaves out rare queries to protect searchers’ privacy (anonymized queries), and a breakdown keeps only its top rows per day, so breakdowns add up to less than the totals.",
      editConnection: "Edit connection",
      syncRuns: "Sync runs",
      nothingSyncs: "Nothing syncs until the setup is finished.",
      noRuns: "No sync runs yet — the initial backfill is queued.",
      runs: {
        status: "Status",
        mode: "Mode",
        window: "Window",
        observations: "Observations",
        attempt: "Attempt",
        error: "Error",
        started: "Started",
        finished: "Finished",
      },
      runStatus: {
        running: "running",
        succeeded: "succeeded",
        failed: "failed",
      },
      runMode: {
        backfill: "backfill",
        incremental: "incremental",
      },
      latestObservations: "Latest observations",
      noObservations: "No observations ingested yet.",
      observations: {
        metric: "Metric",
        resource: "Resource",
        breakdown: "Breakdown",
        day: "Day",
        value: "Value",
      },
    },
    oauth: {
      unavailable: {
        summary: "Not available on this instance",
        signedKeyUnsupported:
          "This netrics server cannot use {name} keys yet. An administrator has to update netrics.",
        oauthUnsupported:
          "This netrics server cannot sign in with {name}. An administrator has to update netrics.",
        notConfiguredSummary: "Needs {name} sign-in set up by an administrator",
        notConfiguredDetail:
          "Connecting with {name} is not set up on this instance yet. An administrator registers a {name} OAuth app for it and sets {env}_CLIENT_ID and {env}_CLIENT_SECRET; then this connector becomes available.",
      },
      outcome: {
        reauthorized:
          "{name} is reconnected. Syncing resumes right away; the data collected so far is kept.",
        denied:
          "You cancelled at {name}, so nothing was changed. Start again whenever you are ready.",
        invalid_state:
          "That {name} sign-in expired or was already used. Sign-ins are valid for 10 minutes; start again.",
        forbidden:
          "This {name} sign-in was started by a different netrics user, or your role no longer allows it. Nothing was connected.",
        scope_missing:
          "netrics needs every permission it asked for. Start again and leave all boxes ticked on the {name} consent screen.",
        account_mismatch:
          "You signed in with a different {name} account than the one this connection uses, so nothing was changed. Reconnect with the same account, or choose “Use a different {name} account”.",
        failed:
          "{name} could not complete the connection, and nothing was stored. Try again in a moment.",
      },
      reauthorize: {
        scopeTitle:
          "Syncing is paused: netrics needs one more {name} permission.",
        scopeDetail:
          "This connector now reads data the earlier authorization did not cover. Reconnect {name} and allow the access it asks for.",
        title: "Syncing is paused: the {name} authorization stopped working.",
        detail:
          "Access was removed in the {name} account, its password changed, or the authorization expired (while an instance’s {name} app is in testing, {name} ends authorizations after 7 days). Reconnect {name} to continue; the data collected so far is kept.",
      },
      openPermissions: "Open your {name} account permissions",
      askToReconnect: "Ask a workspace owner, admin or editor to reconnect it.",
      revocation: {
        revoked:
          "Disconnected. netrics no longer has access to your {name} account.",
        kept: "Disconnected. {name} access stays listed in your {name} account while other netrics connections use it; removing it there would stop those connections too.",
        failed:
          "Disconnected, but {name} did not confirm that access was removed. To be sure, remove netrics from the apps with access to your {name} account.",
      },
    },
    searchConsole: {
      chooseProperty: "Choose a Search Console property.",
      rowLimitInvalid: "Rows per day must be a whole number from 1 to {max}.",
      savedRefetch:
        "Settings saved. The last 16 months are read again with the new settings.",
      saved: "Settings saved.",
      name: "Name",
      property: "Property",
      loading: "Loading the properties of this account…",
      reconnect:
        "Google no longer accepts this connection’s authorization. Reconnect Google above, then choose the property.",
      noProperties:
        "This Google account has no verified Search Console property. Ask an owner of the property to add the account in Search Console (Settings → Users and permissions), or reconnect with a different Google account.",
      noLongerListed: "No longer listed for this Google account",
      propertyHelp:
        "Domain properties cover every protocol and subdomain; URL-prefix properties only the addresses under that prefix.",
      breakdown: "Breakdown (optional)",
      breakdownHelp:
        "Daily totals are always collected. Up to {max} of these add clicks and impressions per page, query, country or device.",
      rowsPerDay: "Rows per day",
      rowsHelp:
        "The top rows by clicks, at most {max}. Search Console leaves out rare queries to protect privacy, so a breakdown adds up to less than the totals.",
      finishNote:
        "Search Console data appears with a 2–3 day delay; the newest days are filled in once Google finalises them. The first sync reads the last 16 months, as far back as Search Console keeps data.",
      editNote:
        "Changing the property, breakdown or rows per day reads the last 16 months again with the new settings. Data collected with the earlier settings stays: a breakdown you remove keeps its past values but is no longer updated.",
      saveAndSync: "Save and start syncing",
      saveChanges: "Save changes",
      dimensions: {
        page: "Page",
        query: "Query",
        country: "Country",
        device: "Device",
      },
      domainProperty: "Domain property",
      urlPrefixProperty: "URL-prefix property",
      permissions: {
        siteOwner: "Owner",
        siteFullUser: "Full user",
        siteRestrictedUser: "Restricted user",
      },
    },
    signedKey: {
      openKeys: "Open App Store Connect API keys",
      theProvider: "the provider",
      howToCreate: "How to create the {name} key",
      fileTooLarge:
        "{file} is larger than {kib} KiB, so it is not an API key. Choose the AuthKey_<Key ID>.p8 file.",
      fileUnreadable: "{file} could not be read. Choose the file again.",
      chooseFile: "Choose the .p8 file…",
      chooseAnotherFile: "Choose another file…",
      fileRead: "{file} read ({bytes} bytes, not shown)",
      pasteInstead: "Paste the key instead",
      pasteHelp:
        "Paste the whole content of the .p8 file, including the BEGIN and END lines.",
      fileInstead: "Choose the file instead",
      appStoreConnect: {
        labels: {
          issuerId: "Issuer ID",
          keyId: "Key ID",
          privateKey: "Private key",
        },
        descriptions: {
          issuerId:
            "Shown above the list of team keys under Users and Access → Integrations → App Store Connect API.",
          keyId: "The 10-character Key ID in the row of your team key.",
          privateKey:
            "The AuthKey_<Key ID>.p8 file you downloaded when you created the key. Apple lets you download it only once.",
        },
        steps: {
          "1": "Sign in to App Store Connect as the Account Holder or an Admin and open Users and Access → Integrations → App Store Connect API. The first time, the Account Holder has to request API access there.",
          "2": "Under Team Keys, generate a key named “netrics” with the Sales role. Finance also works; Admin works too, but grants far more than netrics needs. Individual keys cannot read sales reports.",
          "3": "Download the .p8 file right away (Apple offers it only once). Copy the Key ID from the key’s row and the Issuer ID shown above the list.",
          "4": "Find your vendor number in Payments and Financial Reports, under your legal entity name.",
          "5": "Enter the values below. netrics checks the key with Apple before it stores anything.",
        },
        links: {
          keys: "Open App Store Connect API keys",
          payments: "Open Payments and Financial Reports",
        },
      },
      hints: {
        issuerId:
          "The issuer ID is a UUID with dashes, like 57246542-96fe-1a63-e053-0824d011072a. It is shown above the list of team keys.",
        keyId:
          "The key ID has 10 letters and digits, like 2X9R4HXF34. It is in the key’s row, and in the file name AuthKey_<Key ID>.p8.",
        tooLarge:
          "This is larger than {kib} KiB, so it is not an API key. Choose the AuthKey_<Key ID>.p8 file.",
        certificate:
          "This is a certificate, not a private key. Choose the AuthKey_<Key ID>.p8 file you downloaded with the API key.",
        rsaKey:
          "This is an RSA private key. The API key is an EC key in the AuthKey_<Key ID>.p8 file.",
        publicKey:
          "This is a public key. Choose the AuthKey_<Key ID>.p8 file, which holds the private key.",
        notPem:
          "This does not look like a .p8 private key: it should start with -----BEGIN PRIVATE KEY-----.",
      },
    },
    finishSetup: {
      title: "Choose what to read",
      connectedAs: "Connected as {email}. Nothing is synced until you save.",
      nothingSynced: "Nothing is synced until you save.",
      roleCannot:
        "Your role cannot change connections. Ask a workspace owner, admin or editor to finish the setup.",
    },
    token: {
      accessToken: "Access token",
      howTo: "How to create the token",
      openPage: "Open the token page",
      newLabel: "New {label}",
      keepCurrent: "Leave empty to keep the current token.",
    },
    wizard: {
      chooseFile: "Choose the .p8 file, or paste the key.",
      fieldRequired: "{field} is required.",
      checkFailed: "The connection check failed.",
      selectApp: "Select at least one of the discovered apps.",
      selectResource: "Select at least one of the discovered resources.",
      chooseConnector: "1. Choose a connector",
      meta: "v{version} · {count, plural, one {# metric} other {# metrics}}",
      metaBackfill:
        "v{version} · {count, plural, one {# metric} other {# metrics}} · backfill",
      connectWith: "2. Connect with {provider}",
      oauthIntro:
        "You sign in at {provider} and allow netrics read-only access to your {connector} data. netrics never sees your {provider} password. Afterwards you choose what this connection reads.",
      addKey: "2. Add your {name} key",
      configure: "2. Configure",
      appStoreIntro:
        "App Store Connect has no “Sign in with Apple” for its data, so netrics reads it with a team API key that you create once. It takes about two minutes; netrics stores the key encrypted and checks it with Apple before saving.",
      moreAboutConnector: "More about the connector",
      name: "Name",
      checkingWithApple: "Checking with Apple…",
      testing: "Testing…",
      checkKey: "Check key and find apps",
      test: "Test connection",
      chooseApps: "3. Choose apps and create",
      review: "3. Review and create",
      checkPassed: "Connection check passed.",
      checkPassedWith: "Connection check passed: {message}",
      foundApps:
        "{count, plural, one {Found # app} other {Found # apps}} — uncheck any you do not want to sync.",
      foundResources:
        "{count, plural, one {Found # resource} other {Found # resources}} — uncheck any you do not want to sync.",
      create: "Create connection",
      unavailableTitle: "{name} is not available here",
      selfHosting: "Running netrics yourself?",
      setupGuide: "Read the setup guide.",
    },
    config: {
      none: "This connector has no configuration.",
      optionalLabel: "{label} (optional)",
      yes: "Yes",
      no: "No",
    },
    oauthButton: {
      otherAccount: "Use a different {name} account",
      otherAccountHint:
        "— the connection then reads with that account; choose it at {name}.",
      opening: "Opening {name}…",
      reconnect: "Reconnect {name}",
      connect: "Connect with {name}",
    },
    actions: {
      syncQueued: "Sync queued — it will run on the next worker pass.",
      syncNow: "Sync now",
      disconnect: "Disconnect",
      deleteConnection: "Delete connection",
      confirmDisconnect: "Disconnect “{name}”?",
      confirmDelete: "Delete “{name}”?",
      removesData:
        "Its state, observations and sync history are removed. Dashboard tiles that use it show that the connection is gone.",
      removesAccess:
        "netrics also removes its access to your {name} account, unless other netrics connections still use that account; then the access stays until the last one is disconnected.",
      deletesKeyCopy:
        "netrics deletes its copy of the {name} key. The key itself stays valid at {name} until you revoke it there.",
      deletesKeyCopyId:
        "netrics deletes its copy of the {name} key {keyId}. The key itself stays valid at {name} until you revoke it there.",
      apiKeys: "API keys",
    },
    edit: {
      updated: "Connection updated.",
      name: "Name",
      connectorMissing:
        "Connector {connector} is not in the deployed bundle; config editing is unavailable.",
      saveChanges: "Save changes",
    },
    keyPanel: {
      provider: "provider",
      title: "{name} key",
      privateKey: "Private key",
      stored: "Stored, encrypted (never shown)",
      chooseFile: "Choose the .p8 file, or paste the key.",
      fieldRequired: "{field} is required.",
      replaced:
        "Key replaced. Syncing continues with the new key; the data collected so far is kept.",
      replacedKey:
        "Key replaced — netrics now uses key {keyId}. Syncing continues with the new key; the data collected so far is kept.",
      revokeOld:
        "Now revoke the old key in {name}: netrics cannot do that for you.",
      revokeOldKey:
        "Now revoke the old key {keyId} in {name}: netrics cannot do that for you.",
      openKeys: "Open {name} API keys",
      askToReplace:
        "Ask a workspace owner, admin or editor to replace the key.",
      uploadNew: "Upload a new {name} key",
      replace: "Replace key",
      checksFirst:
        "netrics checks the new key with {name} first. If the check fails, the stored key stays as it is.",
      checking: "Checking with {name}…",
      checkAndReplace: "Check and replace key",
      notChanged: "The stored key was not changed.",
    },
    appStoreAnalytics: {
      title: "App Store analytics",
      intro:
        "Impressions, product page views and downloads by source come from Apple’s analytics reports. Apple only generates them after an Admin has requested them once per app. The first reports arrive 1–2 days after that, and each day is complete about two days later. netrics then reads them with the Sales key it stores; sales keep syncing either way.",
      askToEnable:
        "Ask a workspace owner, admin or editor to enable App Store analytics.",
      uploadKeyFirst:
        "Upload a new App Store Connect key first: the status is read with it.",
      pausedTitle: "App Store analytics paused — enable again.",
      pausedDetail:
        "Apple stopped the report request of {apps} because its reports were not read for a long time. Enabling again creates a new request; sales are not affected.",
      requested:
        "App Store analytics requested. The first reports arrive in 1–2 days.",
      nothingNew: "Nothing new to request.",
      outcomes: {
        created: "Requested now",
        existing: "Already requested",
        failed: "Not requested",
      },
      revokeNow: "Now revoke the temporary Admin key in App Store Connect.",
      revokeNowKey:
        "Now revoke the temporary Admin key {keyId} in App Store Connect.",
      notStored: "netrics did not store it, and nothing needs it any more.",
      openKeys: "Open App Store Connect API keys",
      asking: "Asking App Store Connect…",
      app: "App",
      analytics: "Analytics",
      noApps: "This connection reads no apps yet.",
      enable: "Enable App Store analytics",
      enableIntro:
        "Requesting analytics reports needs a team key with the Admin role, once. Use a temporary one: netrics uses it in memory for this request only and never stores it. Revoke it right after.",
      chooseAdminFile: "Choose the .p8 file of the Admin key, or paste it.",
      fieldRequired: "{field} is required.",
      requesting: "Requesting with App Store Connect…",
      request: "Request analytics reports",
      nothingStored: "Nothing was stored.",
      checking: "Checking…",
      checkAgain: "Check again",
      status: {
        not_enabled: "Not enabled",
        stopped: "App Store analytics paused — enable again",
        requested: "Requested — data pending (the first reports take 1–2 days)",
        available: "Available",
        availableThrough: "Available through {day}",
        unknown: "Status unknown right now",
      },
      guide: {
        summary: "How to create the temporary Admin key",
        step1:
          "Sign in to App Store Connect as the Account Holder or an Admin and open Users and Access → Integrations → App Store Connect API.",
        step2:
          "Under Team Keys, generate a key named “netrics analytics (temporary)” with the Admin role. Download the .p8 file and copy its Key ID.",
        step3:
          "Upload it below. netrics uses it once, in memory, to request the analytics reports of this connection’s apps. It is not stored, queued or logged.",
        step4:
          "Revoke the key right afterwards. The Sales key netrics stores keeps reading the reports.",
      },
    },
    appStoreReviews: {
      title: "App Store ratings and reviews",
      intro:
        "Optional. Reviews per day, their star ratings and where they come from need a second team key with the Customer Support role, because the Sales key cannot read reviews. netrics keeps only counts and stars, never review text or nicknames. The API returns the reviews customers wrote, as Apple lists them; it has no aggregate star rating, so these numbers are not the rating shown on the App Store. Sales never depend on this key.",
      askToAdd:
        "Ask a workspace owner, admin or editor to add a Customer Support key.",
      pausedFallback: "App Store reviews paused — upload a new reviews key.",
      salesKeepSyncing: "Sales and analytics keep syncing.",
      stored:
        "Customer Support key stored. Reviews of the last year are read with the next sync.",
      storedKey:
        "Customer Support key {keyId} stored. Reviews of the last year are read with the next sync.",
      revokePrevious:
        "Now revoke the previous key {keyId} in App Store Connect.",
      removed:
        "Reviews key removed. Review metrics stop updating; the data already read stays.",
      revokeRemoved:
        "Revoke the key in App Store Connect if nothing else uses it.",
      revokeRemovedKey:
        "Revoke key {keyId} in App Store Connect if nothing else uses it.",
      reviewsKey: "Reviews key",
      replaceTitle: "Replace the Customer Support key",
      addOptional: "Add a Customer Support key (optional)",
      formIntro:
        "Use a team key of the same App Store Connect team with the Customer Support role. It can also edit App Store details and answer reviews, which netrics never does; netrics only reads reviews with it. Admin keys are refused.",
      chooseFile:
        "Choose the .p8 file of the Customer Support key, or paste it.",
      checkingKey: "Checking with App Store Connect…",
      checkAndStore: "Check and store the key",
      confirmRemove:
        "Remove the Customer Support key? Review metrics stop updating; sales are not affected.",
      confirmRemoveKey:
        "Remove the Customer Support key {keyId}? Review metrics stop updating; sales are not affected.",
      remove: "Remove reviews key",
      uploadNew: "Upload a new reviews key",
      replace: "Replace reviews key",
      status: {
        not_configured: "Not set up. Ratings and reviews are optional.",
        active: "Reading ratings and reviews{key}.",
        paused: "App Store reviews paused — upload a new reviews key{key}.",
        unknown: "Status unknown right now{key}.",
        keySuffix: " (key {keyId})",
      },
      guide: {
        summary: "How to create the Customer Support key",
        step1:
          "Sign in to App Store Connect as the Account Holder or an Admin and open Users and Access → Integrations → App Store Connect API.",
        step2:
          "Under Team Keys, generate a key named “netrics reviews” with the Customer Support role. Developer or Marketing also work but grant more; Sales and Finance cannot read reviews, and netrics refuses Admin keys.",
        step3:
          "Download the .p8 file right away (Apple offers it only once) and copy the Key ID from the key’s row.",
        step4:
          "Upload it below. netrics checks with Apple that it reads reviews and cannot read sales reports before it stores anything.",
      },
      fields: {
        providerName: "Customer Support",
        keyId:
          "The 10-character Key ID in the row of the Customer Support key.",
        privateKey:
          "The AuthKey_<Key ID>.p8 file of the Customer Support key. Apple lets you download it only once.",
      },
    },
  },
} as const;
