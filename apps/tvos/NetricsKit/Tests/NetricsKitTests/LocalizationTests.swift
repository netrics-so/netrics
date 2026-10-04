import Foundation
import Testing

@testable import NetricsKit

// The screen language (ADR 0016, #256): NetricsKit's own words in English
// and German, the payload's `locale`, the app's String Catalog, and German
// labels against the studio readability rules.

@Suite struct ScreenLanguageTests {
    @Test func matchesByPrimarySubtag() {
        #expect(ScreenLanguage(tag: "de") == .de)
        #expect(ScreenLanguage(tag: "de-AT") == .de)
        #expect(ScreenLanguage(tag: "en_GB") == .en)
        #expect(ScreenLanguage(tag: "fr") == .en)
        #expect(ScreenLanguage(tag: nil) == .en)
        #expect(ScreenLanguage.system(["fr-FR", "de-CH", "en"]) == .de)
        #expect(ScreenLanguage.system(["fr"]) == .en)
    }

    @Test func everyKeyHasAnEnglishAndAGermanText() {
        for key in KitText.allCases {
            #expect(KitStrings.en[key]?.isEmpty == false, "\(key) in English")
            #expect(KitStrings.de[key]?.isEmpty == false, "\(key) in German")
            // Same placeholders, in the same order.
            #expect(placeholders(KitStrings.en[key] ?? "") == placeholders(KitStrings.de[key] ?? ""), "\(key)")
        }
    }

    private func placeholders(_ format: String) -> [String] {
        let pattern = try! NSRegularExpression(pattern: "%[@d]")
        return pattern.matches(in: format, range: NSRange(format.startIndex..., in: format)).map {
            String(format[Range($0.range, in: format)!])
        }
    }
}

@Suite struct GermanFormattingTests {
    let tile = DeviceTile(
        id: "t", label: "Downloads · Alle Apps", period: .last30Days, aggregation: .avg, value: 1284.5,
        unit: "count", change: .init(previousValue: 1000, delta: 284.5, ratio: 0.2845), spark: [],
        status: .ok, updatedAt: nil)

    @Test func labelsPeriodsComparisonsAndAggregations() {
        #expect(MetricFormat.periodLabel(.last12Months, language: .de) == "Letzte 12 Monate")
        #expect(MetricFormat.comparisonLabel(.last30Days, language: .de) == "vs. vorherige 30 Tage")
        #expect(MetricFormat.comparisonLabel(.thisMonth, language: .de) == "vs. Vormonat")
        #expect(MetricFormat.comparisonLabel(.today, language: .de) == "vs. gestern")
        #expect(MetricFormat.aggregationLabel(.last, language: .de) == "Aktuell")
        #expect(MetricFormat.subtitle(tile, language: .de) == "Letzte 30 Tage · Mittelwert")
        // English stays the default.
        #expect(MetricFormat.subtitle(tile) == "Last 30 days · Average")
    }

    @Test func changeLinesAndNotices() {
        #expect(MetricFormat.changeLine(tile, language: .de).text == "▲ +28% vs. vorherige 30 Tage")
        var flat = tile
        flat.change = .init(previousValue: nil, delta: nil, ratio: nil)
        #expect(MetricFormat.changeLine(flat, language: .de).text == "Keine Daten zum Vergleich (vs. vorherige 30 Tage)")
        flat.value = nil
        #expect(MetricFormat.changeLine(flat, language: .de).text == "Noch keine Daten für diesen Zeitraum")
        let now = ISODate.parse("2026-10-04T10:00:00.000Z")!
        #expect(
            TileNotices.notice(status: .stale, updatedAt: "2026-10-04T09:55:00.000Z", now: now, language: .de)
                == "Zuletzt synchronisiert vor 5 Minuten")
        #expect(RelativeTime.describe("2026-10-02T10:00:00.000Z", now: now, language: .de) == "vor 2 Tagen")
        #expect(RelativeTime.describe("2026-10-04T11:00:00.000Z", now: now, language: .de) == "in 1 Stunde")
        #expect(TileNotices.notice(status: .outage, updatedAt: nil, language: .de) == "Quelle nicht erreichbar")
    }

    @Test func numbersAndDatesInGerman() {
        #expect(MetricFormat.value(1284, unit: "count", language: .de) == "1.284")
        #expect(MetricFormat.value(3.14159, unit: "seconds", language: .de) == "3,14")
        // A no-break space before the symbol and unit, as Intl writes on the web.
        #expect(MetricFormat.value(123_456, unit: "EUR_minor", language: .de) == "1.234,56\u{00A0}€")
        #expect(MetricFormat.value(4_200_000, unit: "visitors", language: .de) == "4,2\u{00A0}Mio.")
        // The compact form keeps the shared vectors' suffixes, with a comma.
        #expect(MetricFormat.compactValue(12_345, unit: "count", language: .de) == "12,3K")
        #expect(MetricFormat.compactValue(12_345, unit: "count") == "12.3K")
        let t0 = ISODate.parse("2026-09-29T10:00:00.000Z")!
        #expect(TVTime.hourMinute(t0, timeZone: "Europe/Berlin", language: .de) == "12:00")
        #expect(TVTime.offlineMarker(updatedAt: nil, timeZone: "UTC", language: .de) == "Offline")
        #expect(
            TVTime.offlineMarker(updatedAt: t0, timeZone: "UTC", language: .de)
                == "Offline – letzte Aktualisierung 10:00")
        #expect(TVTime.clock(t0, timeZone: "Europe/Berlin", language: .de).hasSuffix(", 12:00"))
        #expect(
            MetricFormat.bucketLabel("2026-09-28T00:00:00.000Z", period: .last90Days, timeZone: "UTC", language: .de)?
                .hasPrefix("Woche vom 28.") == true)
    }

    @Test func conversionNoteAndServerMessages() {
        let conversion = TileConversion(
            displayCurrency: "EUR", source: "ECB euro foreign exchange reference rates",
            unconverted: [.init(currency: "TWD", value: 5)])
        #expect(ConversionFormat.note(conversion, language: .de) == "EZB-Referenzkurse · TWD nicht umgerechnet")
        #expect(ConversionFormat.note(conversion) == "ECB reference rates · TWD not converted")
        #expect(ServerCheckError.serverError(502).message(in: .de).contains("HTTP 502"))
        #expect(ServerCheckError.timedOut.message == KitStrings.text(.serverTimedOut))
        // A blocked phase's English message shows in the TV's language.
        let blocked = KitStrings.text(.certificateChangedBlocked)
        #expect(KitStrings.translate(blocked, to: .de).hasPrefix("Das Zertifikat des Servers"))
        #expect(KitStrings.translate("Something else", to: .de) == "Something else")
    }
}

@Suite struct PayloadLocaleTests {
    let v1Body = """
        {"version":"abc","refreshAfterSec":60,"timeZone":"UTC","dashboard":null,"tiles":[]%@}
        """

    @Test func schema1WithoutLocaleIsEnglish() throws {
        let payload = try JSONDecoder().decode(
            DeviceDashboard.self, from: Data(String(format: v1Body, "").utf8))
        #expect(payload.locale == nil)
        #expect(payload.language == .en)
        // An English payload round-trips through the cache without a locale.
        let encoded = String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)
        #expect(!encoded.contains("locale"))
    }

    @Test func schema1WithLocale() throws {
        let payload = try JSONDecoder().decode(
            DeviceDashboard.self, from: Data(String(format: v1Body, ",\"locale\":\"de\"").utf8))
        #expect(payload.language == .de)
        let again = try JSONDecoder().decode(DeviceDashboard.self, from: JSONEncoder().encode(payload))
        #expect(again == payload)
        #expect(DashboardPayload.v1(payload).language == .de)
    }

    @Test func schema2WithAndWithoutLocale() throws {
        #expect(v2Payload().locale == nil)
        #expect(v2Payload().language == .en)
        let german = v2JSON().replacingOccurrences(of: "\"schema\": 2,", with: "\"schema\": 2, \"locale\": \"de\",")
        let payload = try JSONDecoder().decode(DashboardPayload.self, from: Data(german.utf8))
        #expect(payload.language == .de)
        let again = try JSONDecoder().decode(DashboardPayload.self, from: JSONEncoder().encode(payload))
        #expect(again.language == .de)
        // A malformed locale is ignored, not fatal.
        let odd = v2JSON().replacingOccurrences(of: "\"schema\": 2,", with: "\"schema\": 2, \"locale\": 7,")
        #expect(try JSONDecoder().decode(DashboardPayload.self, from: Data(odd.utf8)).language == .en)
    }
}

/** The app's String Catalog (NetricsTV/Localizable.xcstrings) and the keys the app uses. */
@Suite struct AppStringCatalogTests {
    static let appDirectory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("NetricsTV")

    struct Catalog: Decodable {
        struct Entry: Decodable {
            struct Localization: Decodable {
                struct Unit: Decodable {
                    var state: String
                    var value: String
                }
                var stringUnit: Unit?
            }
            var localizations: [String: Localization]?
        }
        var sourceLanguage: String
        var strings: [String: Entry]
    }

    func catalog() throws -> Catalog {
        let data = try Data(contentsOf: Self.appDirectory.appendingPathComponent("Localizable.xcstrings"))
        return try JSONDecoder().decode(Catalog.self, from: data)
    }

    @Test func everyKeyHasATranslatedGermanValue() throws {
        let catalog = try catalog()
        #expect(catalog.sourceLanguage == "en")
        #expect(!catalog.strings.isEmpty)
        for (key, entry) in catalog.strings {
            let german = entry.localizations?["de"]?.stringUnit
            #expect(german?.state == "translated", "\(key)")
            #expect(german?.value.isEmpty == false, "\(key)")
            #expect(
                key.components(separatedBy: "%@").count == (german?.value ?? "").components(separatedBy: "%@").count,
                "\(key): placeholders")
        }
    }

    @Test func everyTextTheAppLooksUpIsInTheCatalog() throws {
        let keys = Set(try catalog().strings.keys)
        let pattern = try NSRegularExpression(pattern: #"L10n\.tr\(\s*(?:[a-z.]+ \? )?"((?:[^"\\]|\\.)*)"(?: : "((?:[^"\\]|\\.)*)")?"#)
        var used: Set<String> = []
        let files = try FileManager.default.contentsOfDirectory(at: Self.appDirectory, includingPropertiesForKeys: nil)
        for file in files where file.pathExtension == "swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            for match in pattern.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                for group in 1...2 {
                    if let range = Range(match.range(at: group), in: source) {
                        used.insert(String(source[range]))
                    }
                }
            }
        }
        #expect(used.count > 20)
        #expect(used.subtracting(keys).isEmpty, "missing from the catalog: \(used.subtracting(keys))")
    }
}

/** German labels are longer; the readability rules must still keep them readable. */
@Suite struct GermanReadabilityTests {
    @Test func theComparisonStaysOnTheAppleTVWidget() {
        for fontScale in [1, 1.15, 1.3] {
            let layout = StudioRender.metricLayout(
                label: "Downloads · Alle Ressourcen", value: ("718", "718"),
                periodText: "Letzte 30 Tage · Summe",
                change: ("▼ −28% vs. vorherige 30 Tage", "▼ −28%", "vs. vorherige 30 Tage"), notice: nil, note: nil,
                placement: StudioPlacement(x: 0, y: 0, w: 3, h: 4), showHeader: true, fontScale: fontScale,
                showSparkline: true)
            #expect(layout.changeText == "▼ −28%")
            #expect(layout.comparisonText == "vs. vorherige 30 Tage", "fontScale \(fontScale)")
            #expect(layout.comparison >= StudioLayout.Minimum.any)
            #expect(layout.showPeriod)
            #expect(layout.value.size >= StudioLayout.Minimum.value)
            #expect(!layout.label.title.truncated)
            #expect(layout.label.resource?.truncated == false)
        }
    }

    @Test func wideWidgetsKeepTheWholeGermanChangeLine() {
        let layout = StudioRender.metricLayout(
            label: "Downloads · Alle Apps", value: ("1.284", "1,3K"),
            periodText: "Letzte 12 Monate · Mittelwert",
            change: ("▲ +28% vs. vorherige 12 Monate", "▲ +28%", "vs. vorherige 12 Monate"), notice: nil,
            note: "EZB-Referenzkurse · TWD nicht umgerechnet",
            placement: StudioPlacement(x: 0, y: 0, w: 6, h: 5), showHeader: true, fontScale: 1, showSparkline: true)
        #expect(layout.changeText == "▲ +28% vs. vorherige 12 Monate")
        #expect(layout.showPeriod)
        #expect(layout.sparkline >= StudioRender.minSparklineHeight)
    }

    @Test(arguments: [
        ("Downloads · Alle Ressourcen", 3, 2),
        ("Downloads · Alle Apps", 3, 2),
        ("Seitenaufrufe · Alle Websites", 3, 2),
        ("Klicks · Alle Properties", 3, 2),
    ])
    func germanLabelsFitTheSmallestMetricWidget(_ label: String, _ w: Int, _ h: Int) {
        #expect(StudioLayout.fits(label, type: .metric, w: w, h: h))
    }

    @Test func aStaleNoticeInGermanStillLeavesTheValue() {
        let notice = TileNotices.notice(
            status: .stale, updatedAt: "2026-10-04T09:00:00.000Z", now: ISODate.parse("2026-10-04T10:00:00.000Z")!,
            language: .de)
        let layout = StudioRender.metricLayout(
            label: "Downloads · Alle Ressourcen", value: ("718", "718"), periodText: "Letzte 30 Tage · Summe",
            change: ("▼ −28% vs. vorherige 30 Tage", "▼ −28%", "vs. vorherige 30 Tage"), notice: notice, note: nil,
            placement: StudioPlacement(x: 0, y: 0, w: 3, h: 2), showHeader: true, fontScale: 1, showSparkline: true)
        #expect(notice == "Zuletzt synchronisiert vor 1 Stunde")
        #expect(layout.value.size >= StudioLayout.Minimum.value)
        #expect(!layout.label.title.truncated)
    }
}
