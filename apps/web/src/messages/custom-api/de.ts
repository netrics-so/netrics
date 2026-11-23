import type { Catalog } from "@netrics/domain";

import type { customApiEn } from "./en";

/** Der Baukasten für eigene APIs (Meilenstein 13, #807). */
export const customApiDe: Catalog<typeof customApiEn> = {
  customApi: {
    title: {
      new: "Eigene API bauen",
      edit: "{name} bearbeiten",
      view: "{name}",
    },
    steps: {
      basics: "Grundlagen",
      login: "Anmeldung",
      request: "Anfrage",
      response: "Antwort",
      paging: "Seiten und Zeitraum",
      review: "Zeitplan und Prüfung",
    },
    stepper: {
      label: "Schritte",
      current: "aktueller Schritt",
      done: "fertig",
      issue: "braucht Aufmerksamkeit",
    },
    nav: {
      back: "Zurück",
      continue: "Weiter",
      discard: "Verwerfen",
      discarding: "Wird verworfen …",
      before: "Bevor du weitermachst:",
    },
    basics: {
      name: "Name",
      baseUrl: "Basis-URL",
      baseUrlHelp:
        "Beginnt mit https://. netrics sendet Anfragen nur an die Adressen, die du hier einträgst.",
      addEnvironment: "Umgebung hinzufügen",
      environmentName: "Name der Umgebung",
      removeEnvironment: "Umgebung entfernen",
      testEnvironment: "Testen mit",
      environmentWarning:
        "Wenn du mit einer anderen Umgebung testest oder diese entfernst, wird die gespeicherte Anmeldung gelöscht.",
      hostWarning:
        "Wenn du diese Adresse änderst, wird die gespeicherte Anmeldung gelöscht. Du gibst sie im Schritt Anmeldung erneut ein.",
    },
    login: {
      method: "Wie meldet sich die API an?",
      methods: {
        none: "Keine Anmeldung",
        api_key: "API-Schlüssel",
        bearer: "Bearer-Token",
        basic: "Benutzername und Passwort",
        oauth_client_credentials: "OAuth (Client Credentials)",
        oauth_authorization_code: "OAuth (mit deinem Konto anmelden)",
      },
      methodWarning:
        "Wenn du die Methode änderst, wird die gespeicherte Anmeldung gelöscht. Du gibst sie erneut ein.",
      noLogin: "Diese API braucht keine Anmeldung.",
      placement: "Schlüssel senden als",
      header: "Header",
      query: "Query-Parameter",
      paramName: "Name",
      apiKey: "API-Schlüssel",
      headerName: "Name des Headers",
      prefix: "Präfix",
      token: "Token",
      username: "Benutzername",
      password: "Passwort",
      tokenUrl: "Token-URL",
      authorizeUrl: "Autorisierungs-URL",
      revokeUrl: "Widerrufs-URL (optional)",
      scopes: "Scopes",
      scopesHelp: "Durch Leerzeichen getrennt.",
      clientAuth: "Client-Zugangsdaten senden",
      clientAuths: {
        body: "Im Anfragetext",
        basic: "Als HTTP-Basic-Anmeldung",
      },
      pkce: "PKCE verwenden (empfohlen)",
      authorizeParams: "Zusätzliche Autorisierungsparameter",
      clientId: "Client-ID",
      clientSecret: "Client-Secret",
      save: "Anmeldung speichern",
      saving: "Wird gespeichert …",
      secretSaved:
        "Gespeichert. netrics bewahrt es verschlüsselt auf und zeigt es nie wieder an.",
      replace: "Ersetzen",
      hostChanged:
        "Du hast geändert, wohin netrics deine Anmeldung sendet. Gib sie erneut ein.",
      oauthOwnApp:
        "netrics kann keine App für eine API registrieren, die es nicht kennt. Registriere eine bei deinem Anbieter und trage dort diese Weiterleitungs-URL ein:",
      oauthUnavailable: "Die Weiterleitungs-URL ist noch nicht verfügbar.",
      copy: "Kopieren",
      copied: "Kopiert",
      signIn: "Anmelden",
      signInFirst:
        "Speichere Client-ID und Client-Secret und melde dich dann an.",
      oauthChangeWarning:
        "Wenn du die URLs, die Client-ID oder das Client-Secret änderst, endet die Anmeldung. Du meldest dich dann erneut an.",
    },
    request: {
      postKeptGraphql:
        "Diese Anfrage sendet eine GraphQL-Abfrage per POST. Dieser Editor übernimmt Methode, Abfrage und Variablen unverändert; sie zu ändern kommt mit einer späteren Version.",
      postKeptJson:
        "Diese Anfrage sendet einen JSON-Body per POST. Dieser Editor übernimmt Methode und Body unverändert; sie zu ändern kommt mit einer späteren Version. Wenn du die Anfrage änderst, bestätige erneut, dass sie nur Daten liest.",
      path: "Pfad",
      query: "Query-Parameter",
      headers: "Header",
      variables: "Verbindungswerte",
      variablesHelp:
        "Werte, die jede Verbindung ausfüllt, zum Beispiel eine Konto-ID. Geheime darfst du nur in der Anmeldung verwenden.",
      addRow: "Hinzufügen",
      name: "Name",
      value: "Wert",
      label: "Bezeichnung",
      secret: "Geheim",
      testValue: "Wert für den Test",
      remove: "Entfernen",
      placeholderHelp:
        "Füge einen Wert mit '{'Klammern'}' ein: Verbindungswerte, Start und Ende des Zeitraums oder den Seitenwert.",
      insert: "Wert einfügen",
      insertInto: "Einfügen in",
      targets: {
        path: "Pfad",
        query: "Query-Parameter {name}",
        header: "Header {name}",
      },
      send: "Sende eine Testanfrage",
    },
    response: {
      pickRecords: "Klicke auf die Liste mit deinen Einträgen.",
      pickFields:
        "Hake die Felder an, die du behalten willst. Alles andere wird nicht gespeichert.",
      noRecords:
        "Die Anfrage hat keine Einträge geliefert. Ändere die Anfrage oder den Zeitraum und sende sie erneut.",
      noTest:
        "Sende eine Testanfrage, um die Antwort zu sehen und Felder anzuhaken.",
      useAsRecords: "Als Einträge verwenden",
      wholeResponse: "Die ganze Antwort",
      suggestedList: "Vorgeschlagen",
      recordsAt:
        "Einträge: {path} ({count, plural, one {# Eintrag} other {# Einträge}})",
      changeRecords: "Andere Liste wählen",
      suggested: "Vorschlag: {type}",
      types: {
        string: "Text",
        boolean: "Ja/Nein",
        integer: "Ganze Zahl",
        number: "Zahl",
        decimal: "Dezimalzahl (Geld)",
        date: "Datum",
        timestamp: "Datum und Uhrzeit",
        json: "JSON",
        image: "Bild-URL",
      },
      columns: {
        field: "Feld",
        name: "Name",
        type: "Typ",
        unit: "Einheit",
        currency: "Währungsfeld",
        nullable: "Darf leer sein",
        classification: "Einstufung",
        retention: "Aufbewahren (Tage)",
      },
      classifications: {
        public: "Öffentlich",
        internal: "Intern",
        personal: "Personenbezogen",
      },
      key: "Schlüssel",
      keyField: "Schlüsselfeld",
      timeField: "Zeitfeld",
      noTimeField: "Keins",
      keyWarning:
        "Der Schlüssel ist {key}. Einträge mit demselben Wert in {key} werden zu einem zusammengeführt, viele könnten also verloren gehen. Wähle ein Feld, das jeden Eintrag eindeutig kennzeichnet.",
      useTimeKey: "{time} als Schlüssel nehmen",
      preview: "Vorschau ({count, plural, one {# Zeile} other {# Zeilen}})",
      updatePreview: "Vorschau aktualisieren",
      previewStale:
        "Die Felder haben sich geändert. Aktualisiere die Vorschau, um sie zu sehen.",
      truncated:
        "Für die Vorschau gekürzt. Beim Synchronisieren wird alles gelesen.",
      skipped:
        "{count, plural, one {# Eintrag wurde} other {# Einträge wurden}} übersprungen, weil der Schlüssel nicht lesbar war.",
      nulled:
        "{field}: {count, plural, one {# Wert war} other {# Werte waren}} nicht lesbar und {count, plural, one {wurde} other {wurden}} leer.",
      cut: "{count, plural, one {# weiterer} other {# weitere}}",
      images: {
        label: "Bild-Hosts",
        help: "netrics kopiert Bilder nur von diesen Hosts. Trenne sie mit Kommas; *.example.com erlaubt jede Subdomain.",
        apiOnly:
          "Ohne Bild-Hosts werden Bilder nur vom API-Host {host} kopiert.",
        seen: "Bilder in der Testantwort liegen auf {hosts}. Von dort werden noch keine Bilder kopiert.",
        allow: "{hosts} erlauben",
        limit:
          "Eine eigene API kopiert Bilder von höchstens {max} Bild-Hosts: Entferne einen, bevor du weitere hinzufügst.",
      },
    },
    tree: {
      label: "Antwort",
      items: "{count, plural, one {# Element} other {# Elemente}}",
      keys: "{count, plural, one {# Schlüssel} other {# Schlüssel}}",
      expand: "Aufklappen",
      collapse: "Zuklappen",
    },
    paging: {
      style: "Seiten",
      styles: {
        none: "Keine Seiten",
        page_number: "Seitennummer",
        offset: "Offset und Limit",
        cursor: "Cursor",
        next_url: "Link zur nächsten Seite",
      },
      param: "Parameter",
      start: "Erste Seite",
      sizeParam: "Parameter für die Seitengröße (optional)",
      size: "Seitengröße",
      offsetParam: "Offset-Parameter",
      limitParam: "Limit-Parameter",
      limit: "Limit",
      cursorPath: "Cursor in der Antwort",
      cursorParam: "Cursor senden als",
      nextSource: "Wo steht der Link zur nächsten Seite?",
      nextBody: "In der Antwort",
      nextHeader: "Link-Header",
      nextPath: "Link zur nächsten Seite in der Antwort",
      pickInTree: "Klicke unten in der Antwort auf den Wert.",
      useValue: "Verwenden",
      notPicked: "Noch nicht gewählt",
      test: "Seiten testen",
      fetched:
        "{pages, plural, one {# Seite} other {# Seiten}} und {records, plural, one {# Eintrag} other {# Einträge}} abgerufen.",
      window: {
        title: "Zeitraum",
        none: "Keiner",
        date: "Tage",
        timestamp: "Datum und Uhrzeit",
        stepDays: "Schritt (Tage)",
        lookbackDays: "Zurückschauen (Tage)",
        format: "Format der Zeitraumwerte",
        formats: {
          date: "ISO-Datum (2026-11-21)",
          timestamp: "ISO-Zeitstempel (2026-11-21T00:00:00Z)",
          unix_seconds: "Unix-Sekunden",
          unix_millis: "Unix-Millisekunden",
        },
      },
    },
    review: {
      refresh: "Aktualisieren alle (Minuten)",
      refreshHelp:
        "Der Server kann das auf das kürzeste Intervall anheben, das er erlaubt.",
      backfill: "Verlauf laden (Tage)",
      mode: "Wie neue Daten gespeichert werden",
      modes: {
        upsert: "Per Schlüssel aktualisieren",
        append: "Als neue Zeilen hinzufügen",
        replace_window: "Zeitraum ersetzen",
        snapshot: "Alles ersetzen",
      },
      modeHelp: {
        upsert:
          "Ein Eintrag mit bekanntem Schlüssel ersetzt den gespeicherten.",
        append:
          "Jeder Eintrag wird einmal gespeichert; der Schlüssel verwirft Wiederholungen.",
        replace_window:
          "Die Einträge eines Zeitraums ersetzen, was für ihn gespeichert war.",
        snapshot:
          "Jede Synchronisierung ersetzt alle Einträge durch die aktuelle Liste.",
      },
      summary: "Zusammenfassung",
      streamSummary:
        "{name}: {count, plural, one {# Feld} other {# Felder}}, Schlüssel {key}",
      hosts: "netrics sendet Anfragen an {hosts}.",
      imageHosts: "netrics kopiert Bilder von {hosts}.",
      save: "Speichern und verbinden",
      saveVersion: "Neue Version speichern",
      saving: "Wird gespeichert …",
      retry: "Erneut versuchen",
      promoteFailed:
        "Die eigene API ist gespeichert, aber die Verbindung konnte nicht angelegt werden:",
      stale:
        "Jemand hat eine neuere Version gespeichert. Lade die Seite neu, um sie zu bearbeiten; deine Änderungen hier sind nicht gespeichert.",
      fixFirst: "Behebe zuerst:",
    },
    test: {
      title: "Test",
      ok: "Die Anfrage hat funktioniert.",
      running: "Wird gesendet …",
      wait: "Zu viele Testanfragen. Versuch es in {seconds, plural, one {# Sekunde} other {# Sekunden}} erneut.",
      window: "Zeitraum des Tests: {start} bis {end}",
      status: "HTTP {status}",
      missing: "Gib zuerst ein und speichere: {names}.",
    },
    log: {
      title: "Anfragen",
      columns: {
        page: "Seite",
        method: "Methode",
        url: "URL",
        status: "Status",
        time: "Dauer",
        size: "Größe",
      },
      ms: "{ms} ms",
      kb: "{kb} KB",
    },
    list: {
      title: "Eigene APIs",
      subtitle:
        "Deine eigenen JSON-APIs als Quellen. Baue eine einmal und verbinde sie so oft, wie du willst.",
      empty: "Noch keine eigenen APIs.",
      build: "Eigene API bauen",
      connect: "Verbinden",
      edit: "Bearbeiten",
      view: "Ansehen",
      columns: {
        name: "Name",
        version: "Version",
        connections: "Verbindungen",
        changed: "Zuletzt geändert",
      },
      version: "v{version}",
    },
    oauth: {
      connected: "Angemeldet. Du kannst jetzt eine Testanfrage senden.",
      reauthorized:
        "Erneut angemeldet. Du kannst jetzt eine Testanfrage senden.",
      denied:
        "Die Anmeldung wurde beim Anbieter abgebrochen. Melde dich erneut an.",
      invalid_state:
        "Die Anmeldung hat zu lange gedauert oder wurde woanders gestartet. Melde dich erneut an.",
      forbidden: "Mit deiner Rolle kannst du diese eigene API nicht anmelden.",
      scope_missing:
        "Der Anbieter hat nicht alle Scopes gewährt, die die API braucht. Melde dich erneut an und erlaube alle.",
      account_mismatch:
        "Du hast dich mit einem anderen Konto angemeldet als zuvor. Melde dich mit demselben Konto an.",
      failed:
        "Die Anmeldung hat nicht funktioniert. Prüfe Token-URL, Client-ID und Client-Secret und melde dich erneut an.",
    },
    connect: {
      title: "{name} verbinden",
      environment: "Umgebung",
      name: "Name der Verbindung",
      values: "Verbindungswerte",
      submit: "Verbinden",
      submitting: "Wird verbunden …",
      signInNext: "Nach dem Verbinden meldest du dich beim Anbieter an.",
    },
    viewer: {
      readOnly:
        "Du kannst diese eigene API ansehen. Um sie zu ändern, brauchst du die Rolle Bearbeiter.",
      auth: "Anmeldung: {method}",
      environments: "Umgebungen",
      stream: "Daten",
    },
    hints: {
      secretMissing:
        "Für eine Testanfrage gibst du die Anmeldung ein und speicherst sie. Zum Speichern von Änderungen brauchst du sie nicht.",
      secretValueMissing:
        "Für eine Testanfrage gibst du die geheimen Verbindungswerte ein und speicherst sie. Zum Speichern von Änderungen brauchst du sie nicht.",
      variableValue:
        "Für eine Testanfrage gibst du für jeden Verbindungswert einen Wert ein. Zum Speichern von Änderungen brauchst du sie nicht.",
    },
    errors: {
      leave:
        "Baukasten verlassen? Deine Testanmeldung wird nach 24 Stunden gelöscht.",
    },
    history: {
      restoreHeader: "Version wiederherstellen",
      title: "Versionen",
      byAt: "Version {version} · {author} · {time}",
      unknownAuthor: "Jemand, der nicht mehr da ist",
      current: "Aktuell",
      sameAs: "Gleich wie Version {version}",
      summary:
        "{streams, plural, one {# Datensatz} other {# Datensätze}}, {fields, plural, one {# Feld} other {# Felder}}",
      view: "Ansehen",
      hide: "Ausblenden",
      restore: "Diese Version wiederherstellen",
      restoreConfirm:
        "Version {version} wiederherstellen? Dabei entsteht eine neue Version. Verbindungen behalten ihre Version, bis du sie aktualisierst.",
      restored:
        "Version {version} ist als Version {current} wiederhergestellt.",
      newer: "Neuere Versionen",
      older: "Ältere Versionen",
      loading: "Versionen werden geladen …",
      retry: "Erneut versuchen",
    },
    export: {
      button: "Exportieren",
      help: "Die Datei enthält nur die Definition, keine Anmeldungen und keine Verbindungswerte.",
    },
    import: {
      jsonBodies:
        "Diese Definition sendet JSON-Bodys per POST. netrics kann nicht prüfen, ob eine solche Anfrage nur Daten liest, und übernimmt die Bestätigung der Person, die die Datei exportiert hat, nicht.",
      readOnlyConfirm: "Ich bestätige, dass diese Anfragen nur Daten lesen.",
      title: "Eigene API importieren",
      button: "Importieren",
      choose: "Definitionsdatei auswählen",
      name: "Name (optional)",
      project: "Projekt",
      noProject: "Kein Projekt",
      tooLarge: "Die Datei ist größer als 512 KB.",
      notJson: "Diese Datei ist kein JSON.",
      invalid: "Diese Datei ist keine gültige Definition einer eigenen API:",
      importing: "Wird importiert …",
    },
    connections: {
      title: "Verbindungen",
      empty: "Noch keine Verbindung nutzt diese eigene API.",
      version: "Version {version}",
      updateAvailable: "Aktualisierung verfügbar",
      review: "Aktualisierung ansehen",
    },
    update: {
      title: "{name} aktualisieren",
      banner:
        "Eine neuere Version von {name} ist verfügbar (Version {version}).",
      review: "Aktualisierung ansehen",
      fromTo: "Von Version {from} auf Version {to}",
      changesTitle: "Was sich ändert",
      noChanges: "Für die Daten dieser Verbindung ändert sich nichts.",
      general: "Anmeldung und Einstellungen",
      changes: {
        stream_added:
          "{stream} ist neu. Der Verlauf wird bei der nächsten Synchronisierung gelesen.",
        stream_removed:
          "{stream} wird nicht mehr aktualisiert. Die Daten bleiben.",
        field_added: "Das Feld {field} in {stream} ist neu.",
        field_removed:
          "Das Feld {field} in {stream} wird nicht mehr gelesen. Frühere Werte bleiben.",
        field_changed: "Das Feld {field} in {stream} ändert sich: {aspects}.",
        request_changed: "{stream} wird mit einer geänderten Anfrage gelesen.",
        pagination_changed: "{stream} blättert anders.",
        window_changed: "{stream} liest einen geänderten Zeitraum.",
        mode_changed: "{stream} speichert seine Zeilen anders.",
        environment_added: "Die Umgebung {environment} ist neu.",
        environment_removed: "Die Umgebung {environment} fällt weg.",
        environment_url_changed:
          "Die Umgebung {environment} hat eine neue Adresse.",
        auth_changed: "Die Anmeldeeinstellungen ändern sich.",
        variable_added: "Der Verbindungswert {variable} ist neu.",
        variable_removed:
          "Der Verbindungswert {variable} wird nicht mehr genutzt.",
        schedule_changed: "Das Aktualisierungsintervall ändert sich.",
        images_changed:
          "Die Bildeinstellungen ändern sich: von welchen Hosts Bilder kopiert werden oder wie viele.",
      },
      aspects: {
        type: "Typ",
        path: "Pfad",
        role: "Rolle",
        format: "Format",
        unit: "Einheit",
        classification: "Einstufung",
        nullable: "darf leer sein",
        name: "Name",
      },
      needs: {
        title: "Vor der Aktualisierung",
        environment_removed:
          "Die Umgebung {environment} gibt es nicht mehr. Wähle eine andere.",
        variable_required: "Gib einen Wert für {variable} ein.",
      },
      login: {
        kept: "Die gespeicherte Anmeldung bleibt.",
        hosts_changed:
          "Diese Version sendet die Anmeldung an andere Adressen. Deine gespeicherte Anmeldung wird dort nicht gesendet: Du musst die Anmeldung neu eingeben.",
        auth_changed:
          "Diese Version nutzt eine andere Anmeldemethode. Du musst die Anmeldung neu eingeben.",
        oauthHosts:
          "Diese Version nutzt andere Adressen. Die Anmeldung wird nicht übernommen: Gib den Client nach der Aktualisierung neu ein und melde dich neu an.",
        oauthMethod:
          "Diese Version nutzt eine andere Anmeldemethode. Gib die Anmeldung neu ein und melde dich nach der Aktualisierung an.",
        enterNow: "Du kannst die neue Anmeldung gleich eingeben (optional):",
      },
      environment: "Umgebung",
      apply: "Verbindung aktualisieren",
      applying: "Wird aktualisiert …",
      stale:
        "Die Verbindung wurde inzwischen geändert. Sieh dir die Aktualisierung noch einmal an.",
      done: "Die Verbindung nutzt jetzt Version {version}.",
      back: "Zurück zur Verbindung",
    },
    connectionRequests: {
      title: "Anfragen",
      help: "Was diese Verbindung an die API sendet, so wie es ihre Definitionsversion vorgibt. Werte in geschweiften Klammern werden für jede Anfrage eingesetzt.",
      graphql:
        "Eine GraphQL-Abfrage, per POST gesendet. netrics hat geprüft, dass sie eine einzelne Abfrage ist, die nur Daten liest.",
      variables: "Variablen",
      jsonReadOnly:
        "Ein JSON-Body, per POST gesendet. Die Person, die die Definition erstellt hat, hat bestätigt, dass diese Anfrage nur Daten liest; netrics kann das nicht prüfen.",
    },
    connectionLogin: {
      enterAgain: "Gib die Anmeldung im Bereich „Anmeldung“ neu ein.",
      title: "Anmeldung",
      missing:
        "Diese Verbindung hat keine Anmeldung für ihre aktuelle Version. Gib sie neu ein, damit die Synchronisierung weiterläuft.",
      replace: "Anmeldung ersetzen",
      save: "Anmeldung speichern",
      saving: "Wird gespeichert …",
      saved: "Die Anmeldung ist gespeichert.",
      client: "OAuth-Client",
      clientHelp:
        "Gib die Client-ID und das Client-Secret deiner OAuth-App ein. Eine neue Client-ID braucht eine neue Anmeldung.",
      saveClient: "Client speichern",
      signInNeeded:
        "Melde dich mit deinem Konto an, damit netrics die Daten lesen kann.",
      signIn: "Anmelden",
    },
    issues: {
      nameRequired: "Gib einen Namen ein.",
      baseUrlHttps: "Die Basis-URL beginnt mit https:// und nennt einen Host.",
      baseUrlInvalid:
        "Entferne den Schrägstrich am Ende, die Query oder das Fragment aus der Basis-URL.",
      environmentName: "Gib jeder Umgebung einen Namen.",
      environmentDuplicate: "Zwei Umgebungen haben denselben Namen.",
      loginSettings: "Vervollständige die Anmeldeeinstellungen.",
      secretMissing: "Gib die Anmeldung ein und speichere sie.",
      pathSlash: "Der Pfad beginnt mit /.",
      pathInvalid:
        "Der Pfad darf keine Query, kein Fragment und keine leeren oder Punkt-Segmente enthalten.",
      placeholderSyntax: "Ein Wert in Klammern ist nicht richtig geschrieben.",
      unknownPlaceholder:
        "Ein Wert in Klammern ist weder ein Verbindungswert noch der Zeitraum oder der Seitenwert.",
      pagePlaceholder:
        "Die Anfrage verwendet einen Seitenwert, den die gewählte Seitenart nicht liefert.",
      secretOutsideAuth:
        "Geheime Verbindungswerte darfst du nur in der Anmeldung verwenden, nicht in der Anfrage.",
      rowName: "Jeder Query-Parameter und jeder Header braucht einen Namen.",
      authHeader:
        "Füge keinen Authorization-Header hinzu. Lege die Anmeldung im Schritt Anmeldung fest.",
      headerInvalid: "Ein Header-Name ist nicht erlaubt.",
      variableLabel: "Jeder Verbindungswert braucht eine Bezeichnung.",
      variableDuplicate: "Zwei Verbindungswerte haben denselben Namen.",
      reservedVariable:
        "Ein geheimer Verbindungswert verwendet einen Namen, der für die Anmeldung reserviert ist. Benenne ihn um.",
      secretValueMissing:
        "Gib jeden geheimen Verbindungswert ein und speichere ihn.",
      variableValue:
        "Gib für jeden Verbindungswert einen Wert für den Test ein.",
      recordsMissing: "Wähle die Liste mit deinen Einträgen.",
      fieldsMissing: "Hake mindestens ein Feld an.",
      keyMissing: "Wähle ein Schlüsselfeld.",
      pagingSettings: "Vervollständige die Einstellungen für die Seiten.",
      windowSettings: "Vervollständige den Zeitraum.",
      windowNeeded:
        "Die Anfrage verwendet Start oder Ende des Zeitraums, also braucht sie einen Zeitraum.",
      refreshRange:
        "Aktualisiere zwischen 1 Minute und 7 Tagen (10.080 Minuten).",
      definitionInvalid: "Die Definition hat Fehler (siehe unten).",
      codes: {
        placeholder_syntax:
          "Ein Wert in Klammern ist nicht richtig geschrieben.",
        placeholder_unknown: "Ein Wert in Klammern ist unbekannt.",
        placeholder_secret_outside_auth:
          "Ein geheimer Verbindungswert wird außerhalb der Anmeldung verwendet.",
        placeholder_page_without_pagination:
          "Ein Seitenwert braucht eine passende Seitenart.",
        placeholder_window_without_window:
          "Start oder Ende des Zeitraums brauchen einen Zeitraum.",
        path_syntax: "Ein Pfad ist nicht richtig geschrieben.",
        environment_url: "Eine Basis-URL ist keine gültige https-Adresse.",
        duplicate_id: "Zwei Einträge haben denselben Namen.",
        header_forbidden: "Dieser Header kann nicht gesetzt werden.",
        header_name: "Ein Header-Name ist ungültig.",
        oauth_param_reserved:
          "Diesen Autorisierungsparameter setzt netrics selbst.",
        oauth_secret_variable:
          "OAuth-Anmeldungen können keine eigenen Header hinzufügen.",
        field_unknown: "Ein Feld verweist auf ein Feld, das es nicht gibt.",
        field_role_type: "Bild-URLs brauchen den Typ Text.",
        field_format_type: "Das Datumsformat passt nicht zum Typ des Felds.",
        key_field_invalid:
          "Das Schlüsselfeld darf nicht leer oder JSON sein und muss angehakt sein.",
        reporting_field_invalid:
          "Das Zeitfeld muss ein Datum oder Datum und Uhrzeit sein, das nie leer ist.",
        mode_window:
          "Diese Speicherart passt nicht zum Zeitraum (Zeitraum ersetzen braucht einen, Alles ersetzen keinen).",
        money_field:
          "Geld braucht eine ganze Zahl oder Dezimalzahl und ein Währungsfeld, das nie leer ist.",
        scale_type:
          "Nachkommastellen brauchen eine ganze Zahl oder Dezimalzahl.",
        personal_retention:
          "Personenbezogene Felder brauchen eine Aufbewahrungsdauer in Tagen.",
        pagination_param_clash:
          "Ein Seitenparameter wird schon von der Anfrage oder der Anmeldung verwendet.",
        document_too_large: "Die Definition ist zu groß.",
        image_stream_needs_reporting_field:
          "Daten mit Bildern brauchen ein Zeitfeld, um die neuesten Einträge zu finden.",
        variable_reserved:
          "Ein geheimer Verbindungswert darf nicht wie eine Anmeldeangabe heißen.",
        method_body:
          "Eine POST-Anfrage braucht einen Body, und nur eine POST-Anfrage sendet einen.",
        post_next_url:
          "Eine POST-Anfrage bleibt bei ihrem Endpunkt: Sie kann die Adresse der nächsten Seite nicht aus einer Antwort übernehmen.",
        placeholder_page_in_post_path:
          "Eine POST-Anfrage bleibt bei ihrem Endpunkt: Seitenwerte können ihren Pfad nicht ändern.",
        placeholder_page_in_body:
          "Seitenwerte kommen nur über die Body-Pfade der Seitenart in einen Body.",
        graphql_operation:
          "Die GraphQL-Abfrage muss genau eine Query sein: keine Mutation, keine Subscription, keine zweite Operation und keine Fragment-Definition.",
        graphql_query_placeholder:
          "Die GraphQL-Abfrage wird so gesendet, wie sie ist: Werte in geschweiften Klammern gehören in die Variablen.",
        graphql_param_reserved:
          "Eine GraphQL-Anfrage kann die URL-Parameter query, operationName, variables und extensions nicht verwenden.",
        body_path_invalid: "Ein Body-Pfad zeigt auf keinen Wert des Bodys.",
        pagination_placement:
          "Wähle entweder einen URL-Parameter oder einen Body-Pfad.",
        read_only_unconfirmed: "Bestätige, dass diese Anfrage nur Daten liest.",
        invalid: "Ein Wert fehlt oder ist ungültig.",
      },
    },
  },
};
