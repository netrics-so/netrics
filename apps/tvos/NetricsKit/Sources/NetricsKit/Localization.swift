import Foundation

// The screen language (ADR 0016 sections 3 and 6). Before pairing the TV
// follows its system language; once paired, the payload's `locale` (the
// workspace's screen language) decides, so the TV matches the kiosk.
//
// NetricsKit's own words (period, comparison and aggregation names, tile
// notices, relative times, server-check messages) live in a typed table
// below rather than a String Catalog: `swift test` on macOS builds the
// package without Xcode's catalog compiler, and a table makes "every key
// has a German value" a compile-time fact checked by a test. The wording
// follows the shared catalog in packages/domain/src/i18n/shared and the
// web's tile notices. The app's own text is in NetricsTV/Localizable.xcstrings.

public enum ScreenLanguage: String, Sendable, CaseIterable, Codable {
    case en, de

    /** The language a tag asks for by its primary subtag ("de-AT" → de); English otherwise. */
    public init(tag: String?) {
        let primary = tag?.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map { $0.lowercased() }
        self = primary.flatMap(ScreenLanguage.init(rawValue:)) ?? .en
    }

    /** The Apple TV's own language, for screens before pairing. */
    public static func system(_ preferred: [String] = Locale.preferredLanguages) -> ScreenLanguage {
        for tag in preferred {
            let primary = tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map { $0.lowercased() }
            if let language = primary.flatMap(ScreenLanguage.init(rawValue:)) {
                return language
            }
        }
        return .en
    }

    /** For SwiftUI's environment and date formatting. */
    public var locale: Locale { Locale(identifier: rawValue) }

    /** Numbers as on the web: en-US grouping in English (1,284), German in German (1.284). */
    public var numberLocale: Locale { Locale(identifier: self == .en ? "en_US" : "de_DE") }

    /** Dates and the clock: day before month in both ("Tue 29 Sep", "Di. 29. Sept."). */
    public var dateLocale: Locale { Locale(identifier: self == .en ? "en_GB" : "de_DE") }
}

/** Every text NetricsKit produces, by key. */
public enum KitText: String, Sendable, CaseIterable {
    case periodToday, periodLast7Days, periodLast30Days, periodThisMonth, periodLast90Days, periodLast12Months
    case comparisonToday, comparisonLast7Days, comparisonLast30Days, comparisonThisMonth, comparisonLast90Days
    case comparisonLast12Months, comparisonUnknown
    case periodThisWeek, periodThisQuarter, periodThisYear
    case comparisonThisWeek, comparisonThisQuarter, comparisonThisYear
    case aggregationSum, aggregationAvg, aggregationMin, aggregationMax, aggregationLast
    case noDataForPeriod, noDataYet, noDataToCompare, noComparison, couldNotLoad
    case noticeAuthFailed, noticeOutage, noticeFirstSync, noticeLastSync
    case justNow, never, timeAgo, timeIn, minuteOne, minuteOther, hourOne, hourOther, dayOne, dayOther
    case offline, offlineLastUpdate
    case conversionSource, conversionNotConverted
    case weekOf, others
    case tableTop, tableNew
    case statusEmpty, statusMore, statusConnected, statusDelayed, statusFailing
    case statusAgeMinutes, statusAgeHours, statusAgeDays, statusNever
    case compareRatio, comparePoints, compareDerived
    case countdownLabel, countdownDone, countdownDays, countdownHours, countdownMinutes
    case updated, updatedFrom, reconnect, reconnectSource, reconnectHint, loadingHistory
    case nextRefresh, slidePosition, nextSlide
    case serverInvalidAddress, serverPlainHTTPToPublicHost, serverPlainHTTPNeedsSetting, serverUnreachable
    case serverTimedOut, serverUntrustedCertificateSettingHelps, serverUntrustedCertificate
    case serverCertificateChanged, serverRedirected, serverRedirectedSomewhere, serverNotNetrics
    case serverNewerThanApp, serverOlderThanApp, serverError, certificateChangedBlocked
}

public enum KitStrings {
    /** `%@` and `%d` are filled in order by `text(_:_:_:)`. */
    static let en: [KitText: String] = [
        .periodToday: "Today",
        .periodLast7Days: "Last 7 days",
        .periodLast30Days: "Last 30 days",
        .periodThisMonth: "This month",
        .periodLast90Days: "Last 90 days",
        .periodLast12Months: "Last 12 months",
        .comparisonToday: "vs yesterday",
        .comparisonLast7Days: "vs previous 7 days",
        .comparisonLast30Days: "vs previous 30 days",
        .comparisonThisMonth: "vs last month",
        .comparisonLast90Days: "vs previous 90 days",
        .comparisonLast12Months: "vs previous 12 months",
        .periodThisWeek: "This week",
        .periodThisQuarter: "This quarter",
        .periodThisYear: "This year",
        .comparisonThisWeek: "vs last week to date",
        .comparisonThisQuarter: "vs last quarter to date",
        .comparisonThisYear: "vs last year to date",
        .comparisonUnknown: "vs previous period",
        .aggregationSum: "Total",
        .aggregationAvg: "Average",
        .aggregationMin: "Minimum",
        .aggregationMax: "Maximum",
        .aggregationLast: "Latest",
        .noDataForPeriod: "No data for this period yet",
        .noDataYet: "No data yet",
        .noDataToCompare: "No data to compare %@",
        .noComparison: "No comparison",
        .couldNotLoad: "Could not load",
        .noticeAuthFailed: "Connection needs new credentials",
        .noticeOutage: "Source unreachable",
        .noticeFirstSync: "Waiting for the first sync",
        .noticeLastSync: "Last sync %@",
        .justNow: "just now",
        .never: "never",
        .timeAgo: "%@ ago",
        .timeIn: "in %@",
        .minuteOne: "%d minute",
        .minuteOther: "%d minutes",
        .hourOne: "%d hour",
        .hourOther: "%d hours",
        .dayOne: "%d day",
        .dayOther: "%d days",
        .offline: "Offline",
        .offlineLastUpdate: "Offline — last update %@",
        .conversionSource: "ECB reference rates",
        .conversionNotConverted: "%@ · %@ not converted",
        .weekOf: "Week of %@",
        .others: "Others",
        .tableTop: "Top %d",
        .tableNew: "new",
        .statusEmpty: "No sources connected",
        .statusMore: "+%d more",
        .statusConnected: "%d connected",
        .statusDelayed: "%d delayed",
        .statusFailing: "%d failing",
        .statusAgeMinutes: "%d m",
        .statusAgeHours: "%d h",
        .statusAgeDays: "%d d",
        .statusNever: "never",
        .compareRatio: "ratio",
        .comparePoints: "%@ pt",
        .compareDerived: "derived",
        .countdownLabel: "Countdown",
        .countdownDone: "Now",
        .countdownDays: "d",
        .countdownHours: "h",
        .countdownMinutes: "m",
        .updated: "updated %@",
        .updatedFrom: "updated %@ · %@",
        .reconnect: "Reconnect %@",
        .reconnectSource: "Reconnect the source",
        .reconnectHint: "Access was rejected. An admin can fix this under Connections.",
        .loadingHistory: "Loading history…",
        .nextRefresh: "next refresh in %d s",
        .slidePosition: "%d / %d",
        .nextSlide: "next: %@",
        .serverInvalidAddress: "Enter the address of your netrics server, for example netrics.example.com.",
        .serverPlainHTTPToPublicHost:
            "%@ is not on your local network, so it needs HTTPS. Plain HTTP is only possible for local servers.",
        .serverPlainHTTPNeedsSetting:
            "%@ uses plain HTTP. Use HTTPS, or turn on “Allow insecure connections” (not recommended).",
        .serverUnreachable: "Cannot reach this server. Check the address and the network. (%@)",
        .serverTimedOut: "The server did not answer in time. Check the address and the network.",
        .serverUntrustedCertificateSettingHelps:
            "The server's certificate is not trusted. If it is your own server with a self-signed certificate, turn on “Allow insecure connections” (not recommended).",
        .serverUntrustedCertificate: "The server's certificate is not trusted.",
        .serverCertificateChanged: "The server's certificate has changed since it was trusted.",
        .serverRedirected: "The server redirected to %@. Enter that address instead.",
        .serverRedirectedSomewhere: "The server redirected to another address. Enter that address instead.",
        .serverNotNetrics: "This address does not answer like a netrics server.",
        .serverNewerThanApp: "This server is newer than this app (device API %d). Update the app.",
        .serverOlderThanApp: "This server is too old for this app (device API %d). Update the server.",
        .serverError: "The server answered with an error (HTTP %d). Try again later.",
        .certificateChangedBlocked:
            "The server's certificate has changed. This can mean someone is intercepting the connection. Unpair this TV and set up the server again if you replaced the certificate.",
    ]

    /** German, informal "du", sentence case (ADR 0016). */
    static let de: [KitText: String] = [
        .periodToday: "Heute",
        .periodLast7Days: "Letzte 7 Tage",
        .periodLast30Days: "Letzte 30 Tage",
        .periodThisMonth: "Dieser Monat",
        .periodLast90Days: "Letzte 90 Tage",
        .periodLast12Months: "Letzte 12 Monate",
        .comparisonToday: "vs. gestern",
        .comparisonLast7Days: "vs. vorherige 7 Tage",
        .comparisonLast30Days: "vs. vorherige 30 Tage",
        .comparisonThisMonth: "vs. Vormonat",
        .comparisonLast90Days: "vs. vorherige 90 Tage",
        .comparisonLast12Months: "vs. vorherige 12 Monate",
        .periodThisWeek: "Diese Woche",
        .periodThisQuarter: "Dieses Quartal",
        .periodThisYear: "Dieses Jahr",
        .comparisonThisWeek: "vs. Vorwoche bis heute",
        .comparisonThisQuarter: "vs. Vorquartal bis heute",
        .comparisonThisYear: "vs. Vorjahr bis heute",
        .comparisonUnknown: "vs. vorheriger Zeitraum",
        .aggregationSum: "Summe",
        .aggregationAvg: "Mittelwert",
        .aggregationMin: "Minimum",
        .aggregationMax: "Maximum",
        .aggregationLast: "Aktuell",
        .noDataForPeriod: "Noch keine Daten für diesen Zeitraum",
        .noDataYet: "Noch keine Daten",
        .noDataToCompare: "Keine Daten zum Vergleich (%@)",
        .noComparison: "Kein Vergleich",
        .couldNotLoad: "Konnte nicht geladen werden",
        .noticeAuthFailed: "Verbindung braucht neue Zugangsdaten",
        .noticeOutage: "Quelle nicht erreichbar",
        .noticeFirstSync: "Warte auf die erste Synchronisierung",
        .noticeLastSync: "Zuletzt synchronisiert %@",
        .justNow: "gerade eben",
        .never: "nie",
        .timeAgo: "vor %@",
        .timeIn: "in %@",
        .minuteOne: "%d Minute",
        .minuteOther: "%d Minuten",
        .hourOne: "%d Stunde",
        .hourOther: "%d Stunden",
        .dayOne: "%d Tag",
        .dayOther: "%d Tagen",
        .offline: "Offline",
        .offlineLastUpdate: "Offline – letzte Aktualisierung %@",
        .conversionSource: "EZB-Referenzkurse",
        .conversionNotConverted: "%@ · %@ nicht umgerechnet",
        .weekOf: "Woche vom %@",
        .others: "Andere",
        .tableTop: "Top %d",
        .tableNew: "neu",
        .statusEmpty: "Keine Quellen verbunden",
        .statusMore: "+%d weitere",
        .statusConnected: "%d verbunden",
        .statusDelayed: "%d verzögert",
        .statusFailing: "%d gestört",
        .statusAgeMinutes: "%d min",
        .statusAgeHours: "%d h",
        .statusAgeDays: "%d T",
        .statusNever: "nie",
        .compareRatio: "Verhältnis",
        .comparePoints: "%@ Pp.",
        .compareDerived: "abgeleitet",
        .countdownLabel: "Countdown",
        .countdownDone: "Jetzt",
        .countdownDays: "T",
        .countdownHours: "Std",
        .countdownMinutes: "Min",
        .updated: "aktualisiert %@",
        .updatedFrom: "aktualisiert %@ · %@",
        .reconnect: "%@ neu verbinden",
        .reconnectSource: "Quelle neu verbinden",
        .reconnectHint: "Der Zugriff wurde abgelehnt. Ein Admin kann das unter Verbindungen beheben.",
        .loadingHistory: "Verlauf wird geladen …",
        .nextRefresh: "nächste Aktualisierung in %d s",
        .slidePosition: "%d / %d",
        .nextSlide: "als Nächstes: %@",
        .serverInvalidAddress: "Gib die Adresse deines netrics-Servers ein, zum Beispiel netrics.example.com.",
        .serverPlainHTTPToPublicHost:
            "%@ ist nicht in deinem lokalen Netzwerk und braucht daher HTTPS. Einfaches HTTP geht nur bei lokalen Servern.",
        .serverPlainHTTPNeedsSetting:
            "%@ nutzt einfaches HTTP. Verwende HTTPS oder schalte „Unsichere Verbindungen erlauben“ ein (nicht empfohlen).",
        .serverUnreachable: "Dieser Server ist nicht erreichbar. Prüfe die Adresse und das Netzwerk. (%@)",
        .serverTimedOut: "Der Server hat nicht rechtzeitig geantwortet. Prüfe die Adresse und das Netzwerk.",
        .serverUntrustedCertificateSettingHelps:
            "Dem Zertifikat des Servers wird nicht vertraut. Wenn es dein eigener Server mit selbstsigniertem Zertifikat ist, schalte „Unsichere Verbindungen erlauben“ ein (nicht empfohlen).",
        .serverUntrustedCertificate: "Dem Zertifikat des Servers wird nicht vertraut.",
        .serverCertificateChanged: "Das Zertifikat des Servers hat sich geändert, seit ihm vertraut wurde.",
        .serverRedirected: "Der Server leitet zu %@ weiter. Gib stattdessen diese Adresse ein.",
        .serverRedirectedSomewhere: "Der Server leitet zu einer anderen Adresse weiter. Gib stattdessen diese Adresse ein.",
        .serverNotNetrics: "Diese Adresse antwortet nicht wie ein netrics-Server.",
        .serverNewerThanApp: "Dieser Server ist neuer als diese App (Geräte-API %d). Aktualisiere die App.",
        .serverOlderThanApp: "Dieser Server ist zu alt für diese App (Geräte-API %d). Aktualisiere den Server.",
        .serverError: "Der Server hat mit einem Fehler geantwortet (HTTP %d). Versuch es später noch einmal.",
        .certificateChangedBlocked:
            "Das Zertifikat des Servers hat sich geändert. Das kann bedeuten, dass jemand die Verbindung abhört. Entkopple diesen TV und richte den Server neu ein, falls du das Zertifikat ersetzt hast.",
    ]

    static func table(_ language: ScreenLanguage) -> [KitText: String] {
        switch language {
        case .en: return en
        case .de: return de
        }
    }

    /** The text in a language (English when a translation is missing), arguments filled in order. */
    public static func text(_ key: KitText, _ language: ScreenLanguage = .en, _ arguments: CVarArg...) -> String {
        let format = table(language)[key] ?? en[key] ?? key.rawValue
        guard !arguments.isEmpty else { return format }
        return String(format: format, locale: language.numberLocale, arguments: arguments)
    }

    /**
     * A NetricsKit text that was produced in English (a blocked phase's
     * message) in another language; other text stays as it is.
     */
    public static func translate(_ english: String, to language: ScreenLanguage) -> String {
        guard language != .en, let key = en.first(where: { $0.value == english })?.key else { return english }
        return text(key, language)
    }
}
