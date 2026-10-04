import type { Catalog } from "@netrics/domain";

import type { workspaceEn } from "./en";

/**
 * Workspace overview, projects, connections and devices in German; glossary
 * in ../de.ts. Area terms: connection → Verbindung, sync → Synchronisierung
 * (synchronisieren), key → Schlüssel, credentials → Zugangsdaten, property
 * (Search Console) → Property, breakdown → Aufschlüsselung, reporting day →
 * Berichtstag, TV → TV, pairing code → Code. Apple's role and menu names
 * stay in English as in the connector texts (Customer Support, Sales,
 * Finance, Account Holder, Users and Access).
 */
export const workspaceDe: Catalog<typeof workspaceEn> = {
  health: {
    states: {
      ok: "In Ordnung",
      auth_failed: "Anmeldung fehlgeschlagen",
      needs_reauthorization: "Neu verbinden",
      outage: "Ausfall",
      pending: "Ausstehend",
    },
    authStates: {
      ok: "OK",
      auth_failed: "Anmeldung fehlgeschlagen",
      needs_reauthorization: "Neu verbinden",
      outage: "Ausfall",
    },
  },
  workspace: {
    connectTv: "TV verbinden",
    keyRemoved:
      "Verbindung gelöscht, zusammen mit der Kopie des Schlüssels für {name} bei netrics. Der Schlüssel selbst bleibt gültig, bis du ihn widerrufst.",
    keyRemovedUnnamed:
      "Verbindung gelöscht, zusammen mit der Kopie des Anbieter-Schlüssels bei netrics. Der Schlüssel selbst bleibt gültig, bis du ihn widerrufst.",
    revokeIn: "In {name} widerrufen",
    revokeAtProvider: "Beim Anbieter widerrufen",
    yourRole: "Deine Rolle:",
    workspaces: "Workspaces",
    current: "{name} (aktuell, {role})",
    settings: "Workspace-Einstellungen",
    dashboards: "Dashboards",
    openInStudio: "{name} im Studio öffnen",
    studio: "Studio",
    tvs: "TVs",
    noTvs: "Noch keine TVs.",
    revoked: "Widerrufen",
    noDashboard: "Kein Dashboard",
    lastSeen: "zuletzt gesehen {time}",
    heartbeat: "{version}, Lebenszeichen {time}",
    lastError: "Letzter Fehler: {error}",
    screenSize: "{width} × {height}",
    connections: "Verbindungen",
    noConnections: "Noch keine Verbindungen.",
    table: {
      name: "Name",
      connector: "Connector",
      health: "Zustand",
      lastSuccess: "Zuletzt erfolgreich",
      nextSync: "Nächste Synchronisierung",
    },
    finishSetup: "Einrichtung abschließen",
    addConnection: "Verbindung hinzufügen",
    cannotCreateConnections:
      "Deine Rolle kann in diesem Workspace keine Verbindungen anlegen.",
    projects: "Projekte",
    noProjects: "Noch keine Projekte.",
    cannotCreateProjects:
      "Deine Rolle kann in diesem Workspace keine Projekte anlegen.",
    pages: {
      dashboards: "Dashboards",
      screens: "Bildschirme",
      sources: "Quellen",
      team: "Team",
    },
    dashboardCount:
      "{count, plural, =0 {Noch keine Dashboards} one {# Dashboard} other {# Dashboards}}",
    screenCount:
      "{total, plural, =0 {Noch keine Bildschirme} one {# Bildschirm · {online} online} other {# Bildschirme · {online} online}}",
    sourceCount:
      "{count, plural, =0 {Noch keine Quellen} one {# Quelle} other {# Quellen}}",
    projectsHint:
      "Projekte fassen die Apps und Websites zusammen, über die deine Verbindungen berichten.",
    home: {
      metaTitle: "Start · netrics",
      dashboards: "Dashboards",
      screens: "Bildschirme",
      sources: "Quellen",
      allDashboards: "Alle Dashboards",
      allScreens: "Alle Bildschirme",
      allSources: "Alle Quellen",
      online: "{online} von {total} online",
      noScreens: "Noch keine Bildschirme",
      allFresh: "Alle Quellen aktuell",
      attention:
        "{count, plural, one {# braucht Aufmerksamkeit} other {# brauchen Aufmerksamkeit}}",
      quickActions: "Schnellzugriff",
      newDashboard: "Neues Dashboard",
      addSource: "Quelle hinzufügen",
    },
    newDashboard: {
      legend: "Neues Dashboard",
      format: "Bildschirmformat",
      formatHelp:
        "Das Format, in dem du gestaltest. Alle anderen Formate werden automatisch daraus angeordnet, und du kannst es später im Studio ändern.",
      templateFormat:
        "Vorlagen sind für TV (16:9) gestaltet und werden für jedes andere Format automatisch angeordnet.",
      choices: {
        blank: {
          title: "Leer",
          text: "Eine leere Folie, die du selbst füllst.",
        },
        overview: {
          title: "Übersicht",
          text: "Downloads, Erlöse, Bewertungen und Web-Zahlen aller Verbindungen.",
        },
        brand: {
          title: "Marke",
          text: "Eine App oder Website mit ihrem Icon, ihrer Farbe und ihren eigenen Zahlen.",
        },
      },
      overviewEmpty:
        "Verbinde zuerst eine Quelle: Die Übersicht zeigt die Zahlen deiner Verbindungen.",
      overviewFrom: "Aus {sources}. Es wird nur gezeigt, was verbunden ist.",
      brandEmpty:
        "Noch keine Apps oder Websites: Sie erscheinen, sobald eine Verbindung synchronisiert wurde.",
      appOrSite: "App oder Website",
      chooseOne: "Auswählen",
      accent: "Akzentfarbe",
      fetchingIcon: "App-Icon wird geladen…",
      noIcon: "Kein Icon verfügbar; du kannst im Studio ein Logo hochladen.",
      readingColour: "Farbe des Icons wird ermittelt…",
      tooLowContrast:
        "Diese Farbe ist auf einem TV zu schwer zu lesen ({ratio}:1, mindestens 3:1).",
      accentFromIcon: "Akzent {accent} aus dem Icon, {ratio}:1 auf dem Design.",
      themeAccent: "Die Akzentfarbe des Designs wird verwendet.",
      name: "Name",
      placeholderOverview: "Übersicht",
      placeholderBrand: "Der Name der App",
      placeholderBlank: "Vertrieb",
      createFromTemplate: "Aus Vorlage erstellen",
    },
    newProject: {
      label: "Neues Projekt",
      create: "Projekt erstellen",
    },
  },
  devices: {
    name: "Name",
    dashboard: "Dashboard",
    noDashboard: "Kein Dashboard",
    confirmRevoke: "{name} widerrufen? Der TV zeigt sofort keine Daten mehr.",
    confirm: "Bestätigen",
    revoke: "Widerrufen",
    orientation: "Ausrichtung",
    rotations: {
      r0: "Querformat",
      r90: "Hochformat 90°",
      r180: "Auf dem Kopf",
      r270: "Hochformat 270°",
    },
    mode: "Modus",
    modes: {
      screen: "Bildschirm-Ansicht",
      scroll: "Scroll-Ansicht",
    },
    appleTvMode: "Apple TV nutzt immer die Bildschirm-Ansicht.",
  },
  deviceApproval: {
    pageTitle: "TV verbinden · netrics",
    title: "TV verbinden",
    subtitle:
      "Gib den Code ein, den der TV zeigt, und wähl aus, was er anzeigen soll.",
    notAllowed:
      "Nur Inhaber und Admins eines Workspaces können TVs verbinden. Bitte eine dieser Personen, den Code einzugeben oder dich zum Admin zu machen.",
    connected: "{name} ist verbunden.",
    showsSoon: "Der TV zeigt das Dashboard in wenigen Sekunden.",
    code: "Code auf dem TV",
    workspace: "Workspace",
    dashboard: "Dashboard",
    noDashboard: "Noch keins",
    name: "Name des TVs",
    nameExample: "Zum Beispiel „Empfang Büro“.",
    connecting: "Wird verbunden…",
    connect: "TV verbinden",
  },
  connections: {
    newPage: {
      pageTitle: "Verbindung hinzufügen · netrics",
      title: "Verbindung hinzufügen",
      roleCannot:
        "Deine Rolle ({role}) kann in diesem Workspace keine Verbindungen anlegen.",
      back: "Zurück zu den Quellen",
      finishSetup: "Einrichtung abschließen",
    },
    detail: {
      back: "Zurück zu den Quellen",
      setupFinished:
        "Einrichtung abgeschlossen. Die erste Synchronisierung ist eingeplant und liest bis zu 16 Monate zurück; danach kommen alle paar Stunden neue Daten.",
      pausedCredentials:
        "Die Synchronisierung ist pausiert: Diese Verbindung braucht neue Zugangsdaten.",
      uploadNewKey: "Lade einen neuen Schlüssel für {name} hoch.",
      uploadNewKeyDetail:
        "netrics prüft ihn zuerst; das Speichern startet die Synchronisierung sofort neu, und die bisher gesammelten Daten bleiben erhalten.",
      askUploadKey:
        "Bitte einen Inhaber, Admin oder Bearbeiter des Workspaces, einen neuen Schlüssel für {name} hochzuladen.",
      restoreSearchConsole:
        "Stell die Berechtigung des Kontos für die Property in der Search Console wieder her oder wähl unten eine andere Property.",
      checkProviderPermissions:
        "Prüf die Berechtigungen des Kontos beim Anbieter oder ändere unten die Einstellungen.",
      enterToken: "Gib unten einen neuen Token ein.",
      enterTokenDetail:
        "Das Speichern startet die Synchronisierung sofort neu; die bisher gesammelten Daten bleiben erhalten.",
      askUpdateCredentials:
        "Bitte einen Inhaber oder Admin des Workspaces, die Zugangsdaten zu aktualisieren.",
      health: "Zustand",
      authState: "Anmeldestatus",
      consecutiveFailures: "Fehler in Folge",
      lastSuccess: "Zuletzt erfolgreich",
      nextSync: "Nächste Synchronisierung",
      pollInterval: "Abrufintervall",
      providerAccount: "{provider}-Konto",
      connectedAs: "Verbunden als {email}",
      connected: "Verbunden",
      credentials: "Zugangsdaten",
      credentialsStored: "gespeichert",
      credentialsNone: "keine",
      appStoreAbout: "Über die Daten aus App Store Connect",
      latestReportingDay: "Neuester Berichtstag",
      noneYet: "Noch keiner",
      appStoreTiming:
        "Verkäufe kommen am nächsten Morgen pazifischer Zeit (Apple veröffentlicht den Bericht eines Tages bis etwa 8 Uhr PT); App-Store-Analysen folgen etwa zwei Tage später. Berichtstage sind Tage in pazifischer Zeit, nicht in der Zeitzone deines Workspaces. Erlöse werden in jeder Währung aufbewahrt, die Apple meldet.",
      moreAboutConnector: "Mehr über den Connector",
      searchConsoleAbout: "Über die Daten aus der Search Console",
      searchConsoleTiming:
        "Daten der Search Console erscheinen mit 2–3 Tagen Verzögerung; die neuesten Tage werden ergänzt, sobald Google sie abschließt, daher sind heute und gestern meist leer. Klickrate und durchschnittliche Position sind Tageswerte: Über mehrere Tage werden sie nicht addiert.",
      searchConsolePrivacy:
        "Die Search Console lässt seltene Suchanfragen weg, um die Privatsphäre der Suchenden zu schützen (anonymisierte Suchanfragen), und eine Aufschlüsselung behält nur ihre obersten Zeilen pro Tag; daher ergeben Aufschlüsselungen in Summe weniger als die Gesamtwerte.",
      editConnection: "Verbindung bearbeiten",
      syncRuns: "Synchronisierungen",
      nothingSyncs:
        "Es wird nichts synchronisiert, bis die Einrichtung abgeschlossen ist.",
      noRuns:
        "Noch keine Synchronisierungen – der erste Abruf der Vergangenheit ist eingeplant.",
      runs: {
        status: "Status",
        mode: "Modus",
        window: "Zeitraum",
        observations: "Messwerte",
        attempt: "Versuch",
        error: "Fehler",
        started: "Gestartet",
        finished: "Beendet",
      },
      runStatus: {
        running: "läuft",
        succeeded: "erfolgreich",
        failed: "fehlgeschlagen",
      },
      runMode: {
        backfill: "Nachladen",
        incremental: "inkrementell",
      },
      latestObservations: "Neueste Messwerte",
      noObservations: "Noch keine Messwerte eingelesen.",
      observations: {
        metric: "Metrik",
        resource: "Ressource",
        breakdown: "Aufschlüsselung",
        day: "Tag",
        value: "Wert",
      },
    },
    oauth: {
      unavailable: {
        summary: "Auf dieser Instanz nicht verfügbar",
        signedKeyUnsupported:
          "Dieser netrics-Server kann Schlüssel für {name} noch nicht verwenden. Ein Administrator muss netrics aktualisieren.",
        oauthUnsupported:
          "Dieser netrics-Server kann sich nicht bei {name} anmelden. Ein Administrator muss netrics aktualisieren.",
        notConfiguredSummary:
          "Die Anmeldung mit {name} muss erst ein Administrator einrichten",
        notConfiguredDetail:
          "Die Verbindung mit {name} ist auf dieser Instanz noch nicht eingerichtet. Ein Administrator registriert dafür eine {name}-OAuth-App und setzt {env}_CLIENT_ID und {env}_CLIENT_SECRET; danach ist dieser Connector verfügbar.",
      },
      outcome: {
        reauthorized:
          "{name} ist wieder verbunden. Die Synchronisierung läuft sofort weiter; die bisher gesammelten Daten bleiben erhalten.",
        denied:
          "Du hast bei {name} abgebrochen, daher wurde nichts geändert. Starte neu, wann immer du so weit bist.",
        invalid_state:
          "Diese Anmeldung bei {name} ist abgelaufen oder wurde schon verwendet. Anmeldungen gelten 10 Minuten; starte neu.",
        forbidden:
          "Diese Anmeldung bei {name} hat ein anderer netrics-Benutzer gestartet, oder deine Rolle erlaubt sie nicht mehr. Es wurde nichts verbunden.",
        scope_missing:
          "netrics braucht jede Berechtigung, um die es gebeten hat. Starte neu und lass auf der Zustimmungsseite von {name} alle Häkchen gesetzt.",
        account_mismatch:
          "Du hast dich mit einem anderen {name}-Konto angemeldet als dem, das diese Verbindung verwendet, daher wurde nichts geändert. Verbinde dich mit demselben Konto neu oder wähl „Anderes {name}-Konto verwenden“.",
        failed:
          "{name} konnte die Verbindung nicht abschließen, und es wurde nichts gespeichert. Versuch es gleich noch einmal.",
      },
      reauthorize: {
        scopeTitle:
          "Die Synchronisierung ist pausiert: netrics braucht eine weitere Berechtigung bei {name}.",
        scopeDetail:
          "Dieser Connector liest jetzt Daten, die die frühere Autorisierung nicht abgedeckt hat. Verbinde {name} neu und erlaube den angefragten Zugriff.",
        title:
          "Die Synchronisierung ist pausiert: Die Autorisierung bei {name} funktioniert nicht mehr.",
        detail:
          "Der Zugriff wurde im {name}-Konto entfernt, das Passwort wurde geändert, oder die Autorisierung ist abgelaufen (solange die {name}-App einer Instanz im Testmodus ist, beendet {name} Autorisierungen nach 7 Tagen). Verbinde {name} neu, um weiterzumachen; die bisher gesammelten Daten bleiben erhalten.",
      },
      openPermissions: "Berechtigungen deines {name}-Kontos öffnen",
      askToReconnect:
        "Bitte einen Inhaber, Admin oder Bearbeiter des Workspaces, sie neu zu verbinden.",
      revocation: {
        revoked:
          "Getrennt. netrics hat keinen Zugriff mehr auf dein {name}-Konto.",
        kept: "Getrennt. Der Zugriff bleibt in deinem {name}-Konto aufgeführt, solange andere netrics-Verbindungen ihn verwenden; ihn dort zu entfernen, würde auch diese Verbindungen stoppen.",
        failed:
          "Getrennt, aber {name} hat nicht bestätigt, dass der Zugriff entfernt wurde. Um sicherzugehen, entferne netrics aus den Apps mit Zugriff auf dein {name}-Konto.",
      },
    },
    searchConsole: {
      chooseProperty: "Wähl eine Property der Search Console.",
      rowLimitInvalid:
        "Zeilen pro Tag müssen eine ganze Zahl von 1 bis {max} sein.",
      savedRefetch:
        "Einstellungen gespeichert. Die letzten 16 Monate werden mit den neuen Einstellungen noch einmal gelesen.",
      saved: "Einstellungen gespeichert.",
      name: "Name",
      property: "Property",
      loading: "Properties dieses Kontos werden geladen…",
      reconnect:
        "Google akzeptiert die Autorisierung dieser Verbindung nicht mehr. Verbinde Google oben neu und wähl dann die Property.",
      noProperties:
        "Dieses Google-Konto hat keine bestätigte Property in der Search Console. Bitte einen Inhaber der Property, das Konto in der Search Console hinzuzufügen (Einstellungen → Nutzer und Berechtigungen), oder verbinde dich mit einem anderen Google-Konto neu.",
      noLongerListed: "Für dieses Google-Konto nicht mehr aufgeführt",
      propertyHelp:
        "Domain-Properties umfassen alle Protokolle und Subdomains; URL-Präfix-Properties nur die Adressen unter diesem Präfix.",
      breakdown: "Aufschlüsselung (optional)",
      breakdownHelp:
        "Tagessummen werden immer erfasst. Bis zu {max} davon ergänzen Klicks und Impressionen pro Seite, Suchanfrage, Land oder Gerät.",
      rowsPerDay: "Zeilen pro Tag",
      rowsHelp:
        "Die obersten Zeilen nach Klicks, höchstens {max}. Die Search Console lässt seltene Suchanfragen zum Schutz der Privatsphäre weg, daher ergibt eine Aufschlüsselung in Summe weniger als die Gesamtwerte.",
      finishNote:
        "Daten der Search Console erscheinen mit 2–3 Tagen Verzögerung; die neuesten Tage werden ergänzt, sobald Google sie abschließt. Die erste Synchronisierung liest die letzten 16 Monate, so weit die Search Console Daten aufbewahrt.",
      editNote:
        "Wenn du Property, Aufschlüsselung oder Zeilen pro Tag änderst, werden die letzten 16 Monate mit den neuen Einstellungen noch einmal gelesen. Mit den früheren Einstellungen gesammelte Daten bleiben: Eine entfernte Aufschlüsselung behält ihre bisherigen Werte, wird aber nicht mehr aktualisiert.",
      saveAndSync: "Speichern und Synchronisierung starten",
      saveChanges: "Änderungen speichern",
      dimensions: {
        page: "Seite",
        query: "Suchanfrage",
        country: "Land",
        device: "Gerät",
      },
      domainProperty: "Domain-Property",
      urlPrefixProperty: "URL-Präfix-Property",
      permissions: {
        siteOwner: "Inhaber",
        siteFullUser: "Uneingeschränkter Nutzer",
        siteRestrictedUser: "Eingeschränkter Nutzer",
      },
    },
    finishSetup: {
      title: "Wähl aus, was gelesen wird",
      connectedAs:
        "Verbunden als {email}. Es wird nichts synchronisiert, bis du speicherst.",
      nothingSynced: "Es wird nichts synchronisiert, bis du speicherst.",
      roleCannot:
        "Deine Rolle kann Verbindungen nicht ändern. Bitte einen Inhaber, Admin oder Bearbeiter des Workspaces, die Einrichtung abzuschließen.",
    },
    token: {
      accessToken: "Zugriffstoken",
      howTo: "So erstellst du den Token",
      openPage: "Token-Seite öffnen",
      newLabel: "Neuer {label}",
      keepCurrent: "Leer lassen, um den aktuellen Token zu behalten.",
    },
    wizard: {
      chooseFile: "Wähl die .p8-Datei aus oder füge den Schlüssel ein.",
      fieldRequired: "{field} ist erforderlich.",
      checkFailed: "Die Prüfung der Verbindung ist fehlgeschlagen.",
      selectApp: "Wähl mindestens eine der gefundenen Apps aus.",
      selectResource: "Wähl mindestens eine der gefundenen Ressourcen aus.",
      chooseConnector: "1. Connector auswählen",
      connectWith: "2. Mit {provider} verbinden",
      oauthIntro:
        "Du meldest dich bei {provider} an und erlaubst netrics den reinen Lesezugriff auf deine {connector}-Daten. netrics sieht dein {provider}-Passwort nie. Danach wählst du aus, was diese Verbindung liest.",
      addKey: "2. Deinen Schlüssel für {name} hinzufügen",
      configure: "2. Einrichten",
      appStoreIntro:
        "App Store Connect hat für seine Daten kein „Mit Apple anmelden“, daher liest netrics sie mit einem Team-API-Schlüssel, den du einmal erstellst. Das dauert etwa zwei Minuten; netrics speichert den Schlüssel verschlüsselt und prüft ihn vor dem Speichern bei Apple.",
      moreAboutConnector: "Mehr über den Connector",
      name: "Name",
      checkingWithApple: "Wird bei Apple geprüft…",
      testing: "Wird getestet…",
      checkKey: "Schlüssel prüfen und Apps finden",
      test: "Verbindung testen",
      chooseApps: "3. Apps auswählen und anlegen",
      review: "3. Prüfen und anlegen",
      checkPassed: "Prüfung der Verbindung bestanden.",
      checkPassedWith: "Prüfung der Verbindung bestanden: {message}",
      foundApps:
        "{count, plural, one {# App gefunden} other {# Apps gefunden}} – entferne das Häkchen bei allem, was nicht synchronisiert werden soll.",
      foundResources:
        "{count, plural, one {# Ressource gefunden} other {# Ressourcen gefunden}} – entferne das Häkchen bei allem, was nicht synchronisiert werden soll.",
      create: "Verbindung anlegen",
      unavailableTitle: "{name} ist hier nicht verfügbar",
      selfHosting: "Betreibst du netrics selbst?",
      setupGuide: "Lies die Anleitung zur Einrichtung.",
    },
    config: {
      none: "Dieser Connector hat keine Einstellungen.",
      optionalLabel: "{label} (optional)",
      yes: "Ja",
      no: "Nein",
    },
    oauthButton: {
      otherAccount: "Anderes {name}-Konto verwenden",
      otherAccountHint:
        "– die Verbindung liest dann mit diesem Konto; du wählst es bei {name} aus.",
      opening: "{name} wird geöffnet…",
      reconnect: "{name} neu verbinden",
      connect: "Mit {name} verbinden",
    },
    actions: {
      syncQueued:
        "Synchronisierung eingeplant – sie läuft beim nächsten Durchgang des Workers.",
      syncNow: "Jetzt synchronisieren",
      disconnect: "Trennen",
      deleteConnection: "Verbindung löschen",
      confirmDisconnect: "„{name}“ trennen?",
      confirmDelete: "„{name}“ löschen?",
      removesData:
        "Ihr Zustand, ihre Messwerte und ihr Synchronisierungsverlauf werden entfernt. Dashboard-Kacheln, die sie verwenden, zeigen an, dass die Verbindung weg ist.",
      removesAccess:
        "netrics entfernt außerdem seinen Zugriff auf dein {name}-Konto, außer andere netrics-Verbindungen verwenden dieses Konto noch; dann bleibt der Zugriff, bis die letzte getrennt wird.",
      deletesKeyCopy:
        "netrics löscht seine Kopie des Schlüssels für {name}. Der Schlüssel selbst bleibt bei {name} gültig, bis du ihn dort widerrufst.",
      deletesKeyCopyId:
        "netrics löscht seine Kopie des Schlüssels {keyId} für {name}. Der Schlüssel selbst bleibt bei {name} gültig, bis du ihn dort widerrufst.",
      apiKeys: "API-Schlüssel",
    },
    edit: {
      updated: "Verbindung aktualisiert.",
      name: "Name",
      connectorMissing:
        "Der Connector {connector} ist nicht im installierten Paket enthalten; die Einstellungen können nicht bearbeitet werden.",
      saveChanges: "Änderungen speichern",
    },
    keyPanel: {
      provider: "Anbieter",
      title: "Schlüssel für {name}",
      privateKey: "Privater Schlüssel",
      stored: "Verschlüsselt gespeichert (wird nie angezeigt)",
      chooseFile: "Wähl die .p8-Datei aus oder füge den Schlüssel ein.",
      fieldRequired: "{field} ist erforderlich.",
      replaced:
        "Schlüssel ersetzt. Die Synchronisierung läuft mit dem neuen Schlüssel weiter; die bisher gesammelten Daten bleiben erhalten.",
      replacedKey:
        "Schlüssel ersetzt – netrics verwendet jetzt den Schlüssel {keyId}. Die Synchronisierung läuft mit dem neuen Schlüssel weiter; die bisher gesammelten Daten bleiben erhalten.",
      revokeOld:
        "Widerruf jetzt den alten Schlüssel in {name}: Das kann netrics nicht für dich tun.",
      revokeOldKey:
        "Widerruf jetzt den alten Schlüssel {keyId} in {name}: Das kann netrics nicht für dich tun.",
      openKeys: "API-Schlüssel in {name} öffnen",
      askToReplace:
        "Bitte einen Inhaber, Admin oder Bearbeiter des Workspaces, den Schlüssel zu ersetzen.",
      uploadNew: "Neuen Schlüssel für {name} hochladen",
      replace: "Schlüssel ersetzen",
      checksFirst:
        "netrics prüft den neuen Schlüssel zuerst bei {name}. Schlägt die Prüfung fehl, bleibt der gespeicherte Schlüssel, wie er ist.",
      checking: "Wird bei {name} geprüft…",
      checkAndReplace: "Schlüssel prüfen und ersetzen",
      notChanged: "Der gespeicherte Schlüssel wurde nicht geändert.",
    },
    signedKey: {
      openKeys: "API-Schlüssel in App Store Connect öffnen",
      theProvider: "des Anbieters",
      howToCreate: "So erstellst du den Schlüssel für {name}",
      fileTooLarge:
        "{file} ist größer als {kib} KiB und daher kein API-Schlüssel. Wähl die Datei AuthKey_<Key ID>.p8.",
      fileUnreadable:
        "{file} konnte nicht gelesen werden. Wähl die Datei noch einmal.",
      chooseFile: ".p8-Datei auswählen…",
      chooseAnotherFile: "Andere Datei auswählen…",
      fileRead: "{file} gelesen ({bytes} Bytes, nicht angezeigt)",
      pasteInstead: "Schlüssel stattdessen einfügen",
      pasteHelp:
        "Füge den gesamten Inhalt der .p8-Datei ein, einschließlich der Zeilen BEGIN und END.",
      fileInstead: "Stattdessen die Datei auswählen",
      appStoreConnect: {
        labels: {
          issuerId: "Issuer ID",
          keyId: "Key ID",
          privateKey: "Privater Schlüssel",
        },
        descriptions: {
          issuerId:
            "Steht über der Liste der Team Keys unter Users and Access → Integrations → App Store Connect API.",
          keyId: "Die 10-stellige Key ID in der Zeile deines Teamschlüssels.",
          privateKey:
            "Die Datei AuthKey_<Key ID>.p8, die du beim Erstellen des Schlüssels heruntergeladen hast. Apple lässt sie dich nur einmal herunterladen.",
        },
        steps: {
          "1": "Melde dich als Account Holder oder Admin bei App Store Connect an und öffne Users and Access → Integrations → App Store Connect API. Beim ersten Mal muss der Account Holder dort den API-Zugriff anfordern.",
          "2": "Erstelle unter „Team Keys“ einen Schlüssel namens „netrics“ mit der Rolle Sales. Finance funktioniert auch; Admin ebenfalls, gewährt aber weit mehr, als netrics braucht. Individuelle Schlüssel können keine Verkaufsberichte lesen.",
          "3": "Lade die .p8-Datei sofort herunter (Apple bietet sie nur einmal an). Kopiere die Key ID aus der Zeile des Schlüssels und die Issuer ID über der Liste.",
          "4": "Deine Vendor Number findest du unter „Payments and Financial Reports“, unter dem Namen deiner juristischen Person.",
          "5": "Gib die Werte unten ein. netrics prüft den Schlüssel bei Apple, bevor etwas gespeichert wird.",
        },
        links: {
          keys: "API-Schlüssel in App Store Connect öffnen",
          payments: "Payments and Financial Reports öffnen",
        },
      },
      hints: {
        issuerId:
          "Die Issuer ID ist eine UUID mit Bindestrichen, etwa 57246542-96fe-1a63-e053-0824d011072a. Sie steht über der Liste der Team Keys.",
        keyId:
          "Die Key ID hat 10 Buchstaben und Ziffern, etwa 2X9R4HXF34. Sie steht in der Zeile des Schlüssels und im Dateinamen AuthKey_<Key ID>.p8.",
        tooLarge:
          "Das ist größer als {kib} KiB und daher kein API-Schlüssel. Wähl die Datei AuthKey_<Key ID>.p8.",
        certificate:
          "Das ist ein Zertifikat, kein privater Schlüssel. Wähl die Datei AuthKey_<Key ID>.p8, die du mit dem API-Schlüssel heruntergeladen hast.",
        rsaKey:
          "Das ist ein privater RSA-Schlüssel. Der API-Schlüssel ist ein EC-Schlüssel in der Datei AuthKey_<Key ID>.p8.",
        publicKey:
          "Das ist ein öffentlicher Schlüssel. Wähl die Datei AuthKey_<Key ID>.p8, die den privaten Schlüssel enthält.",
        notPem:
          "Das sieht nicht nach einem privaten .p8-Schlüssel aus: Er sollte mit -----BEGIN PRIVATE KEY----- beginnen.",
      },
    },
    appStoreAnalytics: {
      title: "App-Store-Analysen",
      intro:
        "Impressionen, Aufrufe der Produktseite und Downloads nach Quelle stammen aus den Analyseberichten von Apple. Apple erstellt sie erst, nachdem ein Admin sie einmal pro App angefordert hat. Die ersten Berichte kommen 1–2 Tage danach, und jeder Tag ist etwa zwei Tage später vollständig. netrics liest sie dann mit dem gespeicherten Sales-Schlüssel; Verkäufe werden in jedem Fall weiter synchronisiert.",
      askToEnable:
        "Bitte einen Inhaber, Admin oder Bearbeiter des Workspaces, die App-Store-Analysen zu aktivieren.",
      uploadKeyFirst:
        "Lade zuerst einen neuen Schlüssel für App Store Connect hoch: Der Status wird damit gelesen.",
      pausedTitle: "App-Store-Analysen pausiert – aktiviere sie erneut.",
      pausedDetail:
        "Apple hat die Berichtsanforderung für {apps} gestoppt, weil die Berichte lange nicht gelesen wurden. Eine erneute Aktivierung legt eine neue Anforderung an; Verkäufe sind nicht betroffen.",
      requested:
        "App-Store-Analysen angefordert. Die ersten Berichte kommen in 1–2 Tagen.",
      nothingNew: "Nichts Neues anzufordern.",
      outcomes: {
        created: "Jetzt angefordert",
        existing: "Bereits angefordert",
        failed: "Nicht angefordert",
      },
      revokeNow:
        "Widerruf jetzt den temporären Admin-Schlüssel in App Store Connect.",
      revokeNowKey:
        "Widerruf jetzt den temporären Admin-Schlüssel {keyId} in App Store Connect.",
      notStored:
        "netrics hat ihn nicht gespeichert, und nichts braucht ihn mehr.",
      openKeys: "API-Schlüssel in App Store Connect öffnen",
      asking: "App Store Connect wird abgefragt…",
      app: "App",
      analytics: "Analysen",
      noApps: "Diese Verbindung liest noch keine Apps.",
      enable: "App-Store-Analysen aktivieren",
      enableIntro:
        "Analyseberichte anzufordern braucht einmalig einen Teamschlüssel mit der Rolle Admin. Verwende einen temporären: netrics nutzt ihn nur für diese Anforderung im Arbeitsspeicher und speichert ihn nie. Widerruf ihn gleich danach.",
      chooseAdminFile:
        "Wähl die .p8-Datei des Admin-Schlüssels aus oder füge sie ein.",
      fieldRequired: "{field} ist erforderlich.",
      requesting: "Wird bei App Store Connect angefordert…",
      request: "Analyseberichte anfordern",
      nothingStored: "Es wurde nichts gespeichert.",
      checking: "Wird geprüft…",
      checkAgain: "Erneut prüfen",
      status: {
        not_enabled: "Nicht aktiviert",
        stopped: "App-Store-Analysen pausiert – erneut aktivieren",
        requested:
          "Angefordert – Daten ausstehend (die ersten Berichte dauern 1–2 Tage)",
        available: "Verfügbar",
        availableThrough: "Verfügbar bis {day}",
        unknown: "Status gerade unbekannt",
      },
      guide: {
        summary: "So erstellst du den temporären Admin-Schlüssel",
        step1:
          "Melde dich als Account Holder oder Admin bei App Store Connect an und öffne Users and Access → Integrations → App Store Connect API.",
        step2:
          "Erstelle unter „Team Keys“ einen Schlüssel namens „netrics analytics (temporär)“ mit der Rolle Admin. Lade die .p8-Datei herunter und kopiere die Key ID.",
        step3:
          "Lade ihn unten hoch. netrics verwendet ihn einmal im Arbeitsspeicher, um die Analyseberichte der Apps dieser Verbindung anzufordern. Er wird weder gespeichert noch eingereiht noch protokolliert.",
        step4:
          "Widerruf den Schlüssel gleich danach. Der Sales-Schlüssel, den netrics speichert, liest die Berichte weiter.",
      },
    },
    appStoreReviews: {
      title: "Bewertungen und Rezensionen im App Store",
      intro:
        "Optional. Rezensionen pro Tag, ihre Sternebewertungen und ihre Herkunft brauchen einen zweiten Teamschlüssel mit der Rolle Customer Support, weil der Sales-Schlüssel keine Rezensionen lesen kann. netrics behält nur Anzahlen und Sterne, nie Rezensionstexte oder Spitznamen. Die API liefert die Rezensionen, die Kunden geschrieben haben, so wie Apple sie auflistet; sie hat keine Gesamtbewertung, daher entsprechen diese Zahlen nicht der Bewertung im App Store. Verkäufe hängen nie von diesem Schlüssel ab.",
      askToAdd:
        "Bitte einen Inhaber, Admin oder Bearbeiter des Workspaces, einen Customer-Support-Schlüssel hinzuzufügen.",
      pausedFallback:
        "Rezensionen aus dem App Store pausiert – lade einen neuen Rezensionsschlüssel hoch.",
      salesKeepSyncing: "Verkäufe und Analysen werden weiter synchronisiert.",
      stored:
        "Customer-Support-Schlüssel gespeichert. Die Rezensionen des letzten Jahres werden bei der nächsten Synchronisierung gelesen.",
      storedKey:
        "Customer-Support-Schlüssel {keyId} gespeichert. Die Rezensionen des letzten Jahres werden bei der nächsten Synchronisierung gelesen.",
      revokePrevious:
        "Widerruf jetzt den vorherigen Schlüssel {keyId} in App Store Connect.",
      removed:
        "Rezensionsschlüssel entfernt. Die Rezensionsmetriken werden nicht mehr aktualisiert; die bereits gelesenen Daten bleiben.",
      revokeRemoved:
        "Widerruf den Schlüssel in App Store Connect, wenn nichts anderes ihn verwendet.",
      revokeRemovedKey:
        "Widerruf den Schlüssel {keyId} in App Store Connect, wenn nichts anderes ihn verwendet.",
      reviewsKey: "Rezensionsschlüssel",
      replaceTitle: "Customer-Support-Schlüssel ersetzen",
      addOptional: "Customer-Support-Schlüssel hinzufügen (optional)",
      formIntro:
        "Verwende einen Teamschlüssel desselben App-Store-Connect-Teams mit der Rolle Customer Support. Er kann auch App-Store-Angaben bearbeiten und Rezensionen beantworten, was netrics nie tut; netrics liest damit nur Rezensionen. Admin-Schlüssel werden abgelehnt.",
      chooseFile:
        "Wähl die .p8-Datei des Customer-Support-Schlüssels aus oder füge sie ein.",
      checkingKey: "Wird bei App Store Connect geprüft…",
      checkAndStore: "Schlüssel prüfen und speichern",
      confirmRemove:
        "Customer-Support-Schlüssel entfernen? Die Rezensionsmetriken werden nicht mehr aktualisiert; Verkäufe sind nicht betroffen.",
      confirmRemoveKey:
        "Customer-Support-Schlüssel {keyId} entfernen? Die Rezensionsmetriken werden nicht mehr aktualisiert; Verkäufe sind nicht betroffen.",
      remove: "Rezensionsschlüssel entfernen",
      uploadNew: "Neuen Rezensionsschlüssel hochladen",
      replace: "Rezensionsschlüssel ersetzen",
      status: {
        not_configured:
          "Nicht eingerichtet. Bewertungen und Rezensionen sind optional.",
        active: "Bewertungen und Rezensionen werden gelesen{key}.",
        paused:
          "Rezensionen aus dem App Store pausiert – lade einen neuen Rezensionsschlüssel hoch{key}.",
        unknown: "Status gerade unbekannt{key}.",
        keySuffix: " (Schlüssel {keyId})",
      },
      guide: {
        summary: "So erstellst du den Customer-Support-Schlüssel",
        step1:
          "Melde dich als Account Holder oder Admin bei App Store Connect an und öffne Users and Access → Integrations → App Store Connect API.",
        step2:
          "Erstelle unter „Team Keys“ einen Schlüssel namens „netrics reviews“ mit der Rolle Customer Support. Developer oder Marketing funktionieren auch, gewähren aber mehr; Sales und Finance können keine Rezensionen lesen, und Admin-Schlüssel lehnt netrics ab.",
        step3:
          "Lade die .p8-Datei sofort herunter (Apple bietet sie nur einmal an) und kopiere die Key ID aus der Zeile des Schlüssels.",
        step4:
          "Lade ihn unten hoch. netrics prüft bei Apple, dass er Rezensionen lesen und keine Verkaufsberichte lesen kann, bevor etwas gespeichert wird.",
      },
      fields: {
        providerName: "Customer Support",
        keyId:
          "Die 10-stellige Key ID in der Zeile des Customer-Support-Schlüssels.",
        privateKey:
          "Die Datei AuthKey_<Key ID>.p8 des Customer-Support-Schlüssels. Apple lässt sie dich nur einmal herunterladen.",
      },
    },
  },
};
