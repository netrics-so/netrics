/**
 * The custom API builder (milestone 13, #807): the six steps, the response
 * tree and field mapping, the test panel and request log, the list of
 * custom APIs and "connect an existing one".
 */
export const customApiEn = {
  customApi: {
    title: {
      new: "Build a custom API",
      edit: "Edit {name}",
      view: "{name}",
    },
    steps: {
      basics: "Basics",
      login: "Login",
      request: "Request",
      response: "Response",
      paging: "Paging and time window",
      review: "Schedule and review",
    },
    stepper: {
      label: "Steps",
      current: "current step",
      done: "complete",
      issue: "needs attention",
    },
    nav: {
      back: "Back",
      continue: "Continue",
      discard: "Discard",
      discarding: "Discarding…",
      before: "Before you continue:",
    },
    basics: {
      name: "Name",
      baseUrl: "Base URL",
      baseUrlHelp:
        "Starts with https://. netrics only sends requests to the addresses you enter here.",
      addEnvironment: "Add environment",
      environmentName: "Environment name",
      removeEnvironment: "Remove environment",
      testEnvironment: "Test with",
      environmentWarning:
        "Testing with another environment, or removing this one, deletes the saved login.",
      hostWarning:
        "Changing this address deletes the saved login. You enter it again in the Login step.",
    },
    login: {
      method: "How does the API sign in?",
      methods: {
        none: "No login",
        api_key: "API key",
        bearer: "Bearer token",
        basic: "Username and password",
        oauth_client_credentials: "OAuth (client credentials)",
        oauth_authorization_code: "OAuth (sign in with your account)",
      },
      methodWarning:
        "Changing the method deletes the saved login. You enter it again.",
      noLogin: "This API needs no login.",
      placement: "Send the key as",
      header: "Header",
      query: "Query parameter",
      paramName: "Name",
      apiKey: "API key",
      headerName: "Header name",
      prefix: "Prefix",
      token: "Token",
      username: "Username",
      password: "Password",
      tokenUrl: "Token URL",
      authorizeUrl: "Authorize URL",
      revokeUrl: "Revoke URL (optional)",
      scopes: "Scopes",
      scopesHelp: "Separated by spaces.",
      clientAuth: "Send the client credentials",
      clientAuths: {
        body: "In the request body",
        basic: "As HTTP basic auth",
      },
      pkce: "Use PKCE (recommended)",
      authorizeParams: "Extra authorize parameters",
      clientId: "Client ID",
      clientSecret: "Client secret",
      save: "Save login",
      saving: "Saving…",
      secretSaved:
        "Saved. netrics keeps it encrypted and never shows it again.",
      replace: "Replace",
      hostChanged:
        "You changed where netrics sends your login. Enter it again.",
      oauthOwnApp:
        "netrics can't register an app for an API it doesn't know. Register one at your provider and enter this redirect URL there:",
      oauthUnavailable: "The redirect URL is not available yet.",
      copy: "Copy",
      copied: "Copied",
      signIn: "Sign in",
      signInFirst: "Save the client ID and secret, then sign in.",
      oauthChangeWarning:
        "Changing the URLs, the client ID or the client secret ends the sign-in. You then sign in again.",
    },
    request: {
      path: "Path",
      query: "Query parameters",
      headers: "Headers",
      variables: "Connection values",
      variablesHelp:
        "Values each connection fills in, such as an account ID. Secret ones may only be used in the login.",
      addRow: "Add",
      name: "Name",
      value: "Value",
      label: "Label",
      secret: "Secret",
      testValue: "Value for the test",
      remove: "Remove",
      placeholderHelp:
        "Insert a value with '{'braces'}': connection values, window start and end, or the paging value.",
      insert: "Insert value",
      insertInto: "Insert into",
      targets: {
        path: "Path",
        query: "Query parameter {name}",
        header: "Header {name}",
      },
      send: "Send test request",
    },
    response: {
      pickRecords: "Click the list that holds your records.",
      pickFields: "Tick the fields to keep. Everything else is not stored.",
      noRecords:
        "The request returned no records. Change the request or the time window and send it again.",
      noTest: "Send a test request to see the response and tick fields.",
      useAsRecords: "Use as records",
      wholeResponse: "The whole response",
      suggestedList: "Suggested",
      recordsAt:
        "Records: {path} ({count, plural, one {# record} other {# records}})",
      changeRecords: "Pick another list",
      suggested: "Suggested: {type}",
      types: {
        string: "Text",
        boolean: "Yes/no",
        integer: "Whole number",
        number: "Number",
        decimal: "Decimal (money)",
        date: "Date",
        timestamp: "Date and time",
        json: "JSON",
        image: "Image URL",
      },
      columns: {
        field: "Field",
        name: "Name",
        type: "Type",
        unit: "Unit",
        currency: "Currency field",
        nullable: "May be empty",
        classification: "Classification",
        retention: "Keep (days)",
      },
      classifications: {
        public: "Public",
        internal: "Internal",
        personal: "Personal",
      },
      key: "Key",
      keyField: "Key field",
      timeField: "Time field",
      noTimeField: "None",
      keyWarning:
        "The key is {key}. Records with the same {key} merge into one, so most of them may be lost. Pick a field that identifies each record.",
      useTimeKey: "Use {time} as key",
      preview: "Preview ({count, plural, one {# row} other {# rows}})",
      updatePreview: "Update preview",
      previewStale: "The fields changed. Update the preview to see them.",
      truncated:
        "Shortened for the preview. Everything is read when the connection syncs.",
      skipped:
        "{count, plural, one {# record was} other {# records were}} skipped because the key could not be read.",
      nulled:
        "{field}: {count, plural, one {# value} other {# values}} could not be read and became empty.",
      cut: "{count, plural, one {# more} other {# more}}",
      images: {
        label: "Image hosts",
        help: "netrics copies images only from these hosts. Separate them with commas; *.example.com allows every subdomain.",
        apiOnly:
          "Without image hosts, images are copied only from the API host {host}.",
        seen: "Images in the test response are on {hosts}, which images aren't copied from yet.",
        allow: "Allow {hosts}",
        limit:
          "A custom API copies images from at most {max} image hosts: remove one before adding more.",
      },
    },
    tree: {
      label: "Response",
      items: "{count, plural, one {# item} other {# items}}",
      keys: "{count, plural, one {# key} other {# keys}}",
      expand: "Expand",
      collapse: "Collapse",
    },
    paging: {
      style: "Paging",
      styles: {
        none: "No paging",
        page_number: "Page number",
        offset: "Offset and limit",
        cursor: "Cursor",
        next_url: "Next link",
      },
      param: "Parameter",
      start: "First page",
      sizeParam: "Page size parameter (optional)",
      size: "Page size",
      offsetParam: "Offset parameter",
      limitParam: "Limit parameter",
      limit: "Limit",
      cursorPath: "Cursor in the response",
      cursorParam: "Send the cursor as",
      nextSource: "Where is the next link?",
      nextBody: "In the response",
      nextHeader: "Link header",
      nextPath: "Next link in the response",
      pickInTree: "Click the value in the response below.",
      useValue: "Use",
      notPicked: "Not picked yet",
      test: "Test paging",
      fetched:
        "Fetched {pages, plural, one {# page} other {# pages}} and {records, plural, one {# record} other {# records}}.",
      window: {
        title: "Time window",
        none: "None",
        date: "Dates",
        timestamp: "Date and time",
        stepDays: "Step (days)",
        lookbackDays: "Look back (days)",
        format: "Format of the window values",
        formats: {
          date: "ISO date (2026-11-21)",
          timestamp: "ISO timestamp (2026-11-21T00:00:00Z)",
          unix_seconds: "Unix seconds",
          unix_millis: "Unix milliseconds",
        },
      },
    },
    review: {
      refresh: "Refresh every (minutes)",
      refreshHelp:
        "The server may raise this to the shortest interval it allows.",
      backfill: "Load history (days)",
      mode: "How new data is stored",
      modes: {
        upsert: "Update by key",
        append: "Add as new rows",
        replace_window: "Replace the time window",
        snapshot: "Replace everything",
      },
      modeHelp: {
        upsert: "A record with a known key replaces the stored one.",
        append: "Every record is stored once; the key drops repeats.",
        replace_window:
          "The records of a time window replace what was stored for it.",
        snapshot: "Each sync replaces all records with the current list.",
      },
      summary: "Summary",
      streamSummary:
        "{name}: {count, plural, one {# field} other {# fields}}, key {key}",
      hosts: "netrics will send requests to {hosts}.",
      imageHosts: "netrics will copy images from {hosts}.",
      save: "Save and connect",
      saveVersion: "Save new version",
      saving: "Saving…",
      retry: "Retry",
      promoteFailed:
        "The custom API was saved, but the connection could not be created:",
      stale:
        "Someone saved a newer version. Reload the page to edit it; your changes here are not saved.",
      fixFirst: "Fix these first:",
    },
    test: {
      title: "Test",
      ok: "The request worked.",
      running: "Sending…",
      wait: "Too many test requests. Try again in {seconds, plural, one {# second} other {# seconds}}.",
      window: "Time window of the test: {start} to {end}",
      status: "HTTP {status}",
      missing: "Enter and save first: {names}.",
    },
    log: {
      title: "Requests",
      columns: {
        page: "Page",
        method: "Method",
        url: "URL",
        status: "Status",
        time: "Time",
        size: "Size",
      },
      ms: "{ms} ms",
      kb: "{kb} KB",
    },
    list: {
      title: "Custom APIs",
      subtitle:
        "Your own JSON APIs as sources. Build one once, then connect it as often as you need.",
      empty: "No custom APIs yet.",
      build: "Build a custom API",
      connect: "Connect",
      edit: "Edit",
      view: "View",
      columns: {
        name: "Name",
        version: "Version",
        connections: "Connections",
        changed: "Last changed",
      },
      version: "v{version}",
    },
    oauth: {
      connected: "Signed in. You can send a test request now.",
      reauthorized: "Signed in again. You can send a test request now.",
      denied: "The sign-in was cancelled at the provider. Sign in again.",
      invalid_state:
        "The sign-in took too long or was started elsewhere. Sign in again.",
      forbidden: "Your role can't sign in this custom API.",
      scope_missing:
        "The provider didn't grant every scope the API needs. Sign in again and allow all of them.",
      account_mismatch:
        "You signed in with another account than before. Sign in with the same account.",
      failed:
        "The sign-in didn't work. Check the token URL, the client ID and the client secret, then sign in again.",
    },
    connect: {
      title: "Connect {name}",
      environment: "Environment",
      name: "Connection name",
      values: "Connection values",
      submit: "Connect",
      submitting: "Connecting…",
      signInNext: "After connecting you sign in at the provider.",
    },
    viewer: {
      readOnly:
        "You can view this custom API. Changing it needs the editor role.",
      auth: "Login: {method}",
      environments: "Environments",
      stream: "Data",
    },
    hints: {
      secretMissing:
        "To send a test request, enter and save the login. Saving changes doesn't need it.",
      secretValueMissing:
        "To send a test request, enter and save the secret connection values. Saving changes doesn't need them.",
      variableValue:
        "To send a test request, enter a value for every connection value. Saving changes doesn't need them.",
    },
    errors: {
      leave: "Leave the builder? Your test login is deleted after 24 hours.",
    },
    history: {
      restoreHeader: "Restore a version",
      title: "Versions",
      byAt: "Version {version} · {author} · {time}",
      unknownAuthor: "Someone who left",
      current: "Current",
      sameAs: "Same as version {version}",
      summary:
        "{streams, plural, one {# data set} other {# data sets}}, {fields, plural, one {# field} other {# fields}}",
      view: "View",
      hide: "Hide",
      restore: "Restore this version",
      restoreConfirm:
        "Restore version {version}? This adds a new version. Connections keep their version until you update them.",
      restored: "Version {version} is restored as version {current}.",
      newer: "Newer versions",
      older: "Older versions",
      loading: "Loading versions…",
      retry: "Try again",
    },
    export: {
      button: "Export",
      help: "The file has the definition only, no logins and no connection values.",
    },
    import: {
      title: "Import a custom API",
      button: "Import",
      choose: "Choose a definition file",
      name: "Name (optional)",
      project: "Project",
      noProject: "No project",
      tooLarge: "The file is larger than 512 KB.",
      notJson: "This file is not JSON.",
      invalid: "This file is not a valid custom API definition:",
      importing: "Importing…",
    },
    connections: {
      title: "Connections",
      empty: "No connections use this custom API yet.",
      version: "Version {version}",
      updateAvailable: "Update available",
      review: "Review update",
    },
    update: {
      title: "Update {name}",
      banner: "A newer version of {name} is available (version {version}).",
      review: "Review update",
      fromTo: "From version {from} to version {to}",
      changesTitle: "What changes",
      noChanges: "Nothing changes for this connection's data.",
      general: "Login and settings",
      changes: {
        stream_added: "{stream} is new. Its history is read at the next sync.",
        stream_removed: "{stream} will stop updating. Its data stays.",
        field_added: "Field {field} in {stream} is new.",
        field_removed:
          "Field {field} in {stream} will no longer be read. Its past values stay.",
        field_changed: "Field {field} in {stream} changes: {aspects}.",
        request_changed: "{stream} is read from a changed request.",
        pagination_changed: "{stream} pages differently.",
        window_changed: "{stream} reads a changed time window.",
        mode_changed: "{stream} keeps its rows differently.",
        environment_added: "Environment {environment} is new.",
        environment_removed: "Environment {environment} is removed.",
        environment_url_changed: "Environment {environment} has a new address.",
        auth_changed: "The login settings change.",
        variable_added: "Connection value {variable} is new.",
        variable_removed: "Connection value {variable} is no longer used.",
        schedule_changed: "The refresh interval changes.",
        images_changed:
          "The image settings change: which hosts images are copied from, or how many.",
      },
      aspects: {
        type: "type",
        path: "path",
        role: "role",
        format: "format",
        unit: "unit",
        classification: "classification",
        nullable: "may be empty",
        name: "name",
      },
      needs: {
        title: "Before you update",
        environment_removed:
          "The environment {environment} is gone. Choose another one.",
        variable_required: "Enter a value for {variable}.",
      },
      login: {
        kept: "The saved login stays.",
        hosts_changed:
          "This version sends the login to other addresses. Your saved login isn't sent there: you'll need to enter the login again.",
        auth_changed:
          "This version uses another login method. You'll need to enter the login again.",
        oauthHosts:
          "This version uses other addresses. The sign-in isn't carried over: enter the client again and sign in again after the update.",
        oauthMethod:
          "This version uses another login method. Enter the login again and sign in after the update.",
        enterNow: "You can enter the new login now (optional):",
      },
      environment: "Environment",
      apply: "Update connection",
      applying: "Updating…",
      stale: "The connection changed meanwhile. Review the update again.",
      done: "The connection uses version {version} now.",
      back: "Back to the connection",
    },
    connectionLogin: {
      enterAgain: "Enter the login again in the Login panel.",
      title: "Login",
      missing:
        "This connection has no login for its current version. Enter it again to continue syncing.",
      replace: "Replace the login",
      save: "Save login",
      saving: "Saving…",
      saved: "The login is saved.",
      client: "OAuth client",
      clientHelp:
        "Enter the client ID and secret of your OAuth app. A new client ID needs a new sign-in.",
      saveClient: "Save client",
      signInNeeded: "Sign in with your account so netrics can read the data.",
      signIn: "Sign in",
    },
    issues: {
      nameRequired: "Enter a name.",
      baseUrlHttps: "The base URL starts with https:// and names a host.",
      baseUrlInvalid:
        "Remove the trailing slash, query or fragment from the base URL.",
      environmentName: "Name every environment.",
      environmentDuplicate: "Two environments have the same name.",
      loginSettings: "Complete the login settings.",
      secretMissing: "Enter and save the login.",
      pathSlash: "The path starts with /.",
      pathInvalid:
        "The path can't contain a query, a fragment, empty or dot segments.",
      placeholderSyntax: "A value in braces is not written correctly.",
      unknownPlaceholder:
        "A value in braces is not a connection value, the window or the paging value.",
      pagePlaceholder:
        "The request uses a paging value the chosen paging style doesn't provide.",
      secretOutsideAuth:
        "Secret connection values can only be used in the login, not in the request.",
      rowName: "Every query parameter and header needs a name.",
      authHeader:
        "Don't add an Authorization header. Set the login in the Login step.",
      headerInvalid: "A header name is not allowed.",
      variableLabel: "Every connection value needs a label.",
      variableDuplicate: "Two connection values have the same name.",
      reservedVariable:
        "A secret connection value uses a name reserved for the login. Rename it.",
      secretValueMissing: "Enter and save every secret connection value.",
      variableValue: "Enter a value for the test for every connection value.",
      recordsMissing: "Pick the list that holds your records.",
      fieldsMissing: "Tick at least one field.",
      keyMissing: "Pick a key field.",
      pagingSettings: "Complete the paging settings.",
      windowSettings: "Complete the time window.",
      windowNeeded:
        "The request uses the window start or end, so it needs a time window.",
      refreshRange: "Refresh between 1 minute and 7 days (10,080 minutes).",
      definitionInvalid: "The definition has errors (see below).",
      codes: {
        placeholder_syntax: "A value in braces is not written correctly.",
        placeholder_unknown: "A value in braces is unknown.",
        placeholder_secret_outside_auth:
          "A secret connection value is used outside the login.",
        placeholder_page_without_pagination:
          "A paging value needs a matching paging style.",
        placeholder_window_without_window:
          "The window start or end needs a time window.",
        path_syntax: "A path is not written correctly.",
        environment_url: "A base URL is not a valid https address.",
        duplicate_id: "Two entries have the same name.",
        header_forbidden: "This header can't be set.",
        header_name: "A header name is not valid.",
        oauth_param_reserved: "netrics sets this authorize parameter itself.",
        oauth_secret_variable: "OAuth logins can't add their own headers.",
        field_unknown: "A field refers to a field that doesn't exist.",
        field_role_type: "Image URLs need the type Text.",
        field_format_type: "The date format doesn't fit the field's type.",
        key_field_invalid:
          "The key field can't be empty or JSON and must be ticked.",
        reporting_field_invalid:
          "The time field must be a date or date and time that is never empty.",
        mode_window:
          "This storage mode doesn't fit the time window (replace the window needs one, replace everything needs none).",
        money_field:
          "Money needs a whole number or decimal and a currency field that is never empty.",
        scale_type: "Decimal places need a whole number or decimal.",
        personal_retention: "Personal fields need a number of days to keep.",
        pagination_param_clash:
          "A paging parameter is already used by the request or the login.",
        document_too_large: "The definition is too large.",
        image_stream_needs_reporting_field:
          "Data with images needs a time field to find the newest items.",
        variable_reserved:
          "A secret connection value can't use the name of a login credential.",
        method_body:
          "A POST request needs a body, and only a POST request sends one.",
        post_next_url:
          "A POST request stays on its endpoint: it can't take the next page's address from a response.",
        placeholder_page_in_body:
          "Paging values reach a body only through the paging's body paths.",
        graphql_operation:
          "The GraphQL query must be exactly one query: no mutation, subscription, second operation or fragment definition.",
        graphql_query_placeholder:
          "The GraphQL query is sent as written: put values in braces into the variables.",
        graphql_param_reserved:
          "A GraphQL request can't use the URL parameters query, operationName, variables or extensions.",
        body_path_invalid: "A body path doesn't point to a value of the body.",
        pagination_placement: "Choose either a URL parameter or a body path.",
        read_only_unconfirmed: "Confirm that this request only reads data.",
        invalid: "A value is missing or not valid.",
      },
    },
  },
} as const;
