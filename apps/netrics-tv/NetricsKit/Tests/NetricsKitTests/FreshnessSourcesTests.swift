import Foundation
import Testing

@testable import NetricsKit

// Freshness per source and a total with its split (#784): a widget whose
// rows come from several connectors lists each source's day and next time,
// in forms that degrade to fit (next times first, then numeric days, then
// a line per source); a value view with a grouping shows its total and a
// line per group.

private let berlin = TimeZone(identifier: "Europe/Berlin")!
private let us24 = Locale(identifier: "en_US@hours=h23")
private let germany = Locale(identifier: "de_DE")
private func at(_ iso: String) -> Date { ISODate.parse(iso)! }
/** 2026-11-18 14:00 in Berlin. */
private let now = at("2026-11-18T13:00:00Z")

private let appStore = WidgetFreshness(
    kind: .periodic, stream: "Sales", fetchedAt: "2026-11-18T12:50:00Z", dataThrough: "2026-11-17",
    nextExpectedAt: "2026-11-18T20:00:00Z", nextCheckAt: "2026-11-18T14:00:00Z")
private let play = WidgetFreshness(
    kind: .periodic, stream: "Installs", fetchedAt: "2026-11-18T12:50:00Z", dataThrough: "2026-11-11",
    nextCheckAt: "2026-11-18T16:00:00Z")
private var both: WidgetFreshness {
    var f = play
    f.sources = [
        WidgetFreshnessSource(source: "App Store", freshness: appStore),
        WidgetFreshnessSource(source: "Google Play", freshness: play),
    ]
    return f
}

@Suite struct FreshnessSourcesTests {
    @Test func decodesSourcesLenientlyAndDropsBadEntries() throws {
        let json = """
            {"kind":"periodic","stream":"Installs","fetchedAt":"2026-11-18T12:50:00Z","dataThrough":"2026-11-11",
             "sources":[
              {"source":"App Store","kind":"periodic","stream":"Sales","fetchedAt":"2026-11-18T12:50:00Z",
               "dataThrough":"2026-11-17","nextExpectedAt":"2026-11-18T20:00:00Z"},
              {"source":"Google Play","kind":"periodic","stream":"Installs","fetchedAt":"2026-11-18T12:50:00Z",
               "dataThrough":"2026-11-11"},
              {"source":"","kind":"periodic","stream":"X","fetchedAt":"2026-11-18T12:50:00Z"},
              {"source":"Broken","kind":"weekly","fetchedAt":"x"}
             ]}
            """
        let f = try JSONDecoder().decode(WidgetFreshness.self, from: Data(json.utf8))
        #expect(f.sources.map(\.source) == ["App Store", "Google Play"])
        #expect(f.sources[0].freshness.nextExpectedAt == "2026-11-18T20:00:00Z")
        // Round trip.
        let again = try JSONDecoder().decode(WidgetFreshness.self, from: JSONEncoder().encode(f))
        #expect(again == f)
        // One readable entry, or a damaged list: no sources, the summary stays.
        let one = try JSONDecoder().decode(
            WidgetFreshness.self,
            from: Data(
                #"{"kind":"continuous","stream":"S","fetchedAt":"2026-11-18T12:50:00Z","sources":[{"source":"A","kind":"continuous","stream":"S","fetchedAt":"2026-11-18T12:50:00Z"}]}"#
                    .utf8))
        #expect(one.sources.isEmpty)
        let damaged = try JSONDecoder().decode(
            WidgetFreshness.self,
            from: Data(#"{"kind":"continuous","stream":"S","fetchedAt":"2026-11-18T12:50:00Z","sources":7}"#.utf8))
        #expect(damaged.sources.isEmpty)
    }

    @Test func listsEverySourceAndDegradesInOrder() {
        let en = FreshnessText(language: .en, timeZone: berlin, region: us24).sourceLevels(both, now: now)
        #expect(
            en == [
                ["App Store up to Nov 17 · next ~21:00 · Google Play up to Nov 11 · fetched 10 min. ago"],
                ["App Store up to Nov 17 · next ~21:00 · Google Play up to Nov 11"],
                ["App Store up to Nov 17 · Google Play up to Nov 11"],
                ["App Store up to 11/17 · Google Play up to 11/11"],
                ["App Store 11/17 · Google Play 11/11"],
                ["App Store up to 11/17", "Google Play up to 11/11"],
            ])
        let de = FreshnessText(language: .de, timeZone: berlin, region: germany).sourceLevels(both, now: now)
        #expect(de[1] == ["App Store bis 17. Nov. · nächste ~21:00 · Google Play bis 11. Nov."])
        #expect(de[3] == ["App Store bis 17.11. · Google Play bis 11.11."])
        #expect(de[4] == ["App Store 17.11. · Google Play 11.11."])
        #expect(de[5] == ["App Store bis 17.11.", "Google Play bis 11.11."])
    }

    @Test func underAWarningOnlyEachDay() {
        let levels = FreshnessText(language: .en, timeZone: berlin, region: us24)
            .sourceLevels(both, status: .outage, now: now)
        #expect(levels[0] == ["App Store up to Nov 17 · Google Play up to Nov 11"])
        #expect(levels[5] == ["App Store up to 11/17", "Google Play up to 11/11"])
    }

    @Test func oneSourceKeepsTheSingleLine() {
        #expect(FreshnessText(language: .en, timeZone: berlin, region: us24).sourceLevels(play, now: now).isEmpty)
    }

    @Test func aTileCountsTheLinesOfTheFormThatFits() {
        let data = MeasureWidgetData(scope: nil, metadata: nil, result: nil, error: nil, exclusions: [], freshness: both)
        let wide = data.freshnessSourceLines(width: 2000, fontScale: 1, now: now, language: .en)
        #expect(wide?.count == 1)
        #expect(wide?.first?.contains("next") == true)
        let narrow = data.freshnessSourceLines(width: 300, fontScale: 1, now: now, language: .en)
        #expect(narrow?.count == 2)
        #expect(data.footerLines(rows: [], now: now, language: .en, freshnessLineCount: 2).filter { $0 == nil }.count == 2)
    }

    @Test func anUnfittedTileGetsEveryFormToFitItsWidth() {
        let data = MeasureWidgetData(scope: nil, metadata: nil, result: nil, error: nil, exclusions: [], freshness: both)
        // No width and no scroll card: every form, the last a line per
        // source, so the view picks one that fits and never cuts.
        guard case .firstThatFits(let levels) = data.freshnessSourceLayout(
            width: nil, scroll: false, fontScale: 1, now: now, language: .en)
        else { Issue.record("expected every form"); return }
        #expect(levels.count >= 4)
        #expect(levels.last?.count == 2)
        // A fitted tile and a scroll card get one form's lines.
        #expect(
            data.freshnessSourceLayout(width: 300, scroll: false, fontScale: 1, now: now, language: .en)
                == .lines(data.freshnessSourceLines(width: 300, fontScale: 1, now: now, language: .en)!))
        guard case .lines = data.freshnessSourceLayout(width: nil, scroll: true, fontScale: 1, now: now, language: .en)
        else { Issue.record("expected one form"); return }
    }

    @Test func aMetricKeepsItsFreshnessLineBeforeTheTrend() {
        let layout = { (freshnessNote: Bool) in
            StudioRender.metricLayout(
                label: "Revenue, last 30 days · App Store", value: ("€1,234.56", "€1.2K"),
                periodText: "Last 30 days · Total",
                change: ("▲ +12% vs previous 30 days", "▲ +12%", "vs previous 30 days"), notice: nil,
                note: "Up to Nov 17 · fetched 10 min. ago", placement: StudioPlacement(x: 0, y: 0, w: 4, h: 3),
                showHeader: true, fontScale: 1.3, showSparkline: true, freshnessNote: freshnessNote)
        }
        // Too short for everything: the freshness line stays (#784).
        #expect(layout(true).showNote)
        // A conversion note gives way to the change line, as before.
        #expect(!layout(false).showNote)
        #expect(layout(false).changeText != nil)
    }

    @Test func aTotalWithItsSplit() {
        let cell = { (value: Double) in MeasureCell(value: .number(value), type: "integer", status: "ok") }
        var data = MeasureWidgetData(
            scope: nil, metadata: nil,
            result: MeasureResult(
                releaseId: nil, rows: [
                    MeasureResultRow(
                        dimensionLabels: ["store": "App Store"], dimensions: ["store": .text("apple")],
                        measures: ["downloads": cell(412)]),
                    MeasureResultRow(
                        dimensionLabels: ["store": "Google Play"], dimensions: ["store": .text("google")],
                        measures: ["downloads": cell(223)]),
                ], warnings: [], provenance: [], stale: false),
            error: nil, exclusions: [])
        data.totals = [cell(635)]
        let rows = data.result!.rows
        #expect(data.splitTotal(measureIds: ["downloads"]) == "635")
        #expect(
            data.splitLines(measureIds: ["downloads"], groupBy: ["store"], rows: rows).map { "\($0.0) \($0.1)" }
                == ["App Store 412", "Google Play 223"])
        let fit = data.splitFit(
            label: "Downloads", measureIds: ["downloads"], groupBy: ["store"], rows: rows,
            box: (width: 560, height: 414), fontScale: 1)
        #expect(fit.shown == 2 && fit.rowsLine == nil && fit.valueSize == 84)
        // Totals decode leniently.
        let json = #"{"exclusions":[],"totals":[{"value":635,"type":"integer","status":"ok"},{"bad":1}]}"#
        let decoded = try? JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
        #expect(decoded?.totals?.count == 1)
    }
}
