import Foundation
import Testing

@testable import NetricsKit

@Suite struct MeasureWidgetTests {
    private func cell(_ value: String, type: String = "decimal", currency: String? = nil, unit: String? = nil) throws
        -> MeasureCell
    {
        let object: [String: Any] = [
            "value": value, "type": type, "currency": currency as Any? ?? NSNull(), "unit": unit as Any? ?? NSNull(),
            "status": "ok",
        ]
        return try JSONDecoder().decode(MeasureCell.self, from: JSONSerialization.data(withJSONObject: object))
    }
    @Test func preservesExactMoneyAndMinorUnitExponents() throws {
        #expect(try cell("9007199254740993.12", currency: "EUR").text(language: .en) == "9,007,199,254,740,993.12 EUR")
        #expect(try cell("9007199254740993.12", currency: "EUR").text(language: .de) == "9.007.199.254.740.993,12 EUR")
        #expect(try cell("150", currency: "EUR", unit: "currency_minor").text(language: .en) == "1.50 EUR")
        #expect(try cell("-1", currency: "KWD", unit: "currency_minor").text(language: .en) == "-0.001 KWD")
        #expect(try cell("150", currency: "JPY", unit: "currency_minor").text(language: .en) == "150 JPY")
        #expect(try cell("4.5", unit: "stars").text(language: .en) == "4.5 ★")
    }
    /// A measure table on a TV shows the rows that fit its tile above its
    /// footer lines and says how many of all (#768), as the web does.
    @Test func fitsTableRowsToTheTileAndCountsThem() throws {
        let rows = (1...20).map { #"{"dimensions":{"app":"App \#($0)"},"measures":{"downloads":{"value":\#(100 - $0),"type":"integer","status":"ok"}}}"# }
        let json = #"{"metadata":{"modelId":"m","modelName":"Downloads","measures":[{"id":"downloads","name":"Downloads"}],"dimensions":[{"id":"app","name":"App"}]},"result":{"rows":["# + rows.joined(separator: ",") + #"],"totalRows":20,"warnings":[],"provenance":[],"stale":false},"exclusions":[]}"#
        let data = try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
        let rowsOf = data.result!.rows
        func fit(_ box: (width: Double, height: Double)?, rows: [MeasureResultRow]) -> (shown: Int, rowsLine: String?) {
            let fit = data.tableFit(
                label: "Downloads", measureIds: ["downloads"], groupBy: ["app"], rows: rows, box: box,
                fontScale: 1, now: Date(timeIntervalSince1970: 0), language: .en)
            return (fit.shown, fit.rowsLine)
        }
        let small = fit((560, 414.2), rows: rowsOf)
        #expect(small.shown > 0 && small.shown < 20)
        #expect(small.rowsLine == "\(small.shown) of 20 groups")
        // A taller tile shows more; deterministic.
        #expect(fit((560, 892.4), rows: rowsOf).shown > small.shown)
        #expect(fit((560, 414.2), rows: rowsOf) == small)
        // Scroll cards (no box): every row, the line only for groups not received.
        #expect(fit(nil, rows: rowsOf) == (20, nil))
        #expect(fit((560, 892.4), rows: Array(rowsOf.prefix(2))).rowsLine == "2 of 20 groups")
    }
    /// A fitted table's columns (#780, as the web): even shares, unless a
    /// head's word is wider than one ("Downloads" at font scale 1.3 in a
    /// third of a 16:9 screen); then that column is as wide as the word
    /// needs and the others share the rest, so the head is not broken
    /// inside the word. On an iPad or iPhone the system font is wider, and
    /// so is the column.
    @Test func widensAColumnForItsHeadsWord() throws {
        let rows = (1...3).map { #"{"dimensions":{"app":"App \#($0)","store":"App Store"},"measures":{"downloads":{"value":\#(100 - $0),"type":"integer","status":"ok"}}}"# }
        let json = #"{"metadata":{"modelId":"m","modelName":"Downloads","measures":[{"id":"downloads","name":"Downloads"}],"dimensions":[{"id":"app","name":"App"},{"id":"store","name":"Store"}]},"result":{"rows":["# + rows.joined(separator: ",") + #"],"totalRows":3,"warnings":[],"provenance":[],"stale":false},"exclusions":[]}"#
        let data = try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
        func widths(_ box: (width: Double, height: Double)?, fontScale: Double, points: Double? = nil) -> [Double]? {
            data.tableFit(
                label: "Downloads", measureIds: ["downloads"], groupBy: ["app", "store"], rows: data.result!.rows,
                box: box, fontScale: fontScale, pixel: 1, points: points, now: Date(timeIntervalSince1970: 0),
                language: .en
            ).columnWidths
        }
        let third = 560.0 / 3
        #expect(widths((560, 414.2), fontScale: 1) == [third, third, third])
        let widened = try #require(widths((560, 414.2), fontScale: 1.3))
        let word = StudioLayout.measureTextWidth("Downloads", fontSize: 28 * 1.3, weight: .semibold, font: .tv)
        #expect(word + 21 > third)
        #expect(abs(widened[2] - (word + 21)) < 1e-9)
        #expect(abs(widened[0] - (560 - widened[2]) / 2) < 1e-9 && widened[0] == widened[1])
        #expect(abs(widened.reduce(0, +) - 560) < 1e-9)
        // At an iPhone's size the word is wider, and its column with it.
        let touch = try #require(widths((560, 414.2), fontScale: 1.3, points: 0.45))
        #expect(touch[2] > widened[2] + 5)
        // Scroll cards (no box) keep their own columns.
        #expect(widths(nil, fontScale: 1.3) == nil)
    }
    @Test func decodesAndCachesTypedPublishedResultsAndExpiresThemOffline() throws {
        let json =
            #"{"id":"measure-1","type":"measure","x":0,"y":0,"w":4,"h":3,"label":"Contribution","measureIds":["margin"],"groupBy":[],"options":{"view":"value","limit":20},"data":{"widgetId":"measure-1","scope":["Country: DE"],"metadata":{"modelId":"m","modelName":"Portfolio","measures":[{"id":"margin","name":"Contribution"}],"dimensions":[]},"result":{"releaseId":"release-1","expiresAt":"2026-11-06T00:00:00.000Z","rows":[{"dimensions":{},"measures":{"margin":{"value":"9007199254740993.12","type":"decimal","unit":"currency","currency":"EUR","status":"ok"}}}],"warnings":[],"provenance":[{"datasetId":"sales","generationId":"generation-1"}],"stale":false},"error":null,"exclusions":[]}}"#
        let widget = try JSONDecoder().decode(DeviceWidget.self, from: Data(json.utf8))
        guard case .measure(let ids, let groups, let options, let data) = widget.content else {
            Issue.record("measure widget")
            return
        }
        #expect(ids == ["margin"])
        #expect(groups.isEmpty)
        #expect(options.view == "value")
        #expect(data.result?.rows[0].measures["margin"]?.value == .text("9007199254740993.12"))
        #expect(data.scope == ["Country: DE"])
        #expect(!data.expired(at: Date(timeIntervalSince1970: 0)))
        #expect(data.expired(at: Date(timeIntervalSince1970: 2_000_000_000)))
        let cached = try JSONDecoder().decode(DeviceWidget.self, from: JSONEncoder().encode(widget))
        #expect(cached == widget)
        #expect(
            WidgetDetail.make(widget, now: Date(timeIntervalSince1970: 0))?.items.first?.value
                == "9,007,199,254,740,993.12 EUR")
        #expect(WidgetDetail.make(widget, now: Date(timeIntervalSince1970: 2_000_000_000))?.items.isEmpty == true)
    }
    @Test func retainsLabelsPendingInputsAndSourceActionsInOfflinePayloads() throws {
        let json = #"{"sourceHealth":[{"connectionId":"c","name":"Store account","status":"needs_reauthorization","lastSuccessAt":null}],"result":{"pendingSources":["waiting"],"rows":[{"dimensions":{"app":"stable-id"},"dimensionLabels":{"app":"Friendly app"},"measures":{"total":{"value":"1.20","type":"decimal","status":"partial"}}}],"warnings":["data_source_pending"],"provenance":[],"stale":false},"exclusions":[]}"#
        let data = try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
        #expect(data.result?.rows[0].dimensionLabels?["app"] == "Friendly app")
        #expect(data.result?.rows[0].dimensions["app"] == .text("stable-id"))
        #expect(data.result?.pendingSources == ["waiting"])
        #expect(data.sourceHealth?.first?.status == "needs_reauthorization")
        let cached = try JSONDecoder().decode(MeasureWidgetData.self, from: JSONEncoder().encode(data))
        #expect(cached == data)
    }
    @Test func showsPercentChangeMeasuresAsSignedPercentages() throws {
        let json =
            #"{"id":"measure-1","type":"measure","x":0,"y":0,"w":4,"h":3,"label":"Units","measureIds":["pct","units"],"groupBy":[],"options":{"view":"table","limit":20},"data":{"metadata":{"modelId":"m","modelName":"Units","measures":[{"id":"pct","name":"Change in %","percentChange":true},{"id":"units","name":"Units"}],"dimensions":[]},"result":{"rows":[{"dimensions":{},"measures":{"pct":{"value":"0.083333333333333333","type":"decimal","status":"ok"},"units":{"value":"0.5","type":"decimal","status":"ok"}}}],"warnings":[],"provenance":[],"stale":false},"error":null,"exclusions":[]}}"#
        let widget = try JSONDecoder().decode(DeviceWidget.self, from: Data(json.utf8))
        guard case .measure(_, _, _, let data) = widget.content else {
            Issue.record("measure widget")
            return
        }
        let row = try #require(data.result?.rows.first)
        #expect(data.metadata?.measures.map(\.percentChange) == [true, nil])
        #expect(data.text(row.measures["pct"], measure: "pct", language: .en) == "+8.3%")
        #expect(data.text(row.measures["units"], measure: "units", language: .en) == "0.5")
        #expect(try cell("-0.6").text(language: .de, percentChange: true) == "−60%")
        #expect(try cell("-0.0125").text(language: .de, percentChange: true) == "−1,3%")
        #expect(try cell("0").text(language: .en, percentChange: true) == "±0%")
        #expect(
            WidgetDetail.make(widget, now: Date(timeIntervalSince1970: 0))?.items.map(\.value) == ["+8.3%", "0.5"])
        // Payloads from servers before the flag still decode, as plain values.
        let olderJSON = json.replacingOccurrences(of: #","percentChange":true"#, with: "")
        guard case .measure(_, _, _, let older) = try JSONDecoder().decode(DeviceWidget.self, from: Data(olderJSON.utf8)).content
        else {
            Issue.record("older measure widget")
            return
        }
        #expect(older.metadata?.measures.first?.percentChange == nil)
        #expect(
            older.text(older.result?.rows.first?.measures["pct"], measure: "pct", language: .en)
                == "0.083333333333333333")
    }
    // Mirrors "display formatting (#619)" in packages/domain/src/dashboard-data.test.ts.
    @Test func showsACalendarDayInTheLanguagesDateFormatTheSameDayInEveryTimeZone() throws {
        #expect(DataFormat.date("2026-01-07", type: "date", language: .de) == "07.01.2026")
        #expect(DataFormat.date("2026-01-07", type: "date", language: .en) == "Jan 7, 2026")
        #expect(
            DataFormat.date("2026-01-07", type: "date", language: .de, timeZone: try #require(TimeZone(identifier: "Pacific/Honolulu")))
                == "07.01.2026")
    }
    @Test func showsATimestampWithItsTimeInTheGivenZone() throws {
        let utc = try #require(TimeZone(identifier: "UTC"))
        #expect(DataFormat.date("2026-01-07T09:15:00.000Z", type: "timestamp", language: .de, timeZone: utc) == "07.01.2026, 09:15")
        #expect(DataFormat.date("2026-01-07T09:15:00.000Z", type: "timestamp", language: .en, timeZone: utc) == "Jan 7, 2026, 9:15 AM")
    }
    @Test func leavesValuesThatAreNoDateToTheCaller() {
        #expect(DataFormat.date("soon", type: "date", language: .en) == nil)
        #expect(DataFormat.date("2026-02-30", type: "date", language: .en) == nil)
        #expect(DataFormat.date("42", type: "timestamp", language: .en) == nil)
        #expect(DataFormat.date("2026-01-07", type: "string", language: .en) == nil)
    }
    @Test func roundsDecimalTextHalfAwayFromZeroWithoutFloatingPoint() {
        #expect(DataFormat.roundDecimalText("4.2857", digits: 2) == "4.29")
        #expect(DataFormat.roundDecimalText("4.66667", digits: 2) == "4.67")
        #expect(DataFormat.roundDecimalText("4.5", digits: 2) == "4.5")
        #expect(DataFormat.roundDecimalText("4.995", digits: 2) == "5")
        #expect(DataFormat.roundDecimalText("4.10", digits: 2) == "4.1")
        #expect(DataFormat.roundDecimalText("-0.004", digits: 2) == "0")
        #expect(DataFormat.roundDecimalText("-1.005", digits: 2) == "-1.01")
        #expect(DataFormat.roundDecimalText("9007199254740993.125", digits: 2) == "9007199254740993.13")
        #expect(DataFormat.roundDecimalText("12", digits: 2) == "12")
        #expect(DataFormat.unitFractionDigits["stars"] == 2)
        // Beyond the TypeScript cases: a carry through every digit, and text that is no decimal.
        #expect(DataFormat.roundDecimalText("99.999", digits: 2) == "100")
        #expect(DataFormat.roundDecimalText("0.005", digits: 2) == "0.01")
        #expect(DataFormat.roundDecimalText("n/a", digits: 2) == "n/a")
    }
    @Test func showsRatingsWithTwoDecimalsAndDatesInTheScreenLanguage() throws {
        let utc = try #require(TimeZone(identifier: "UTC"))
        #expect(try cell("4.2857", unit: "stars").text(language: .en) == "4.29 ★")
        #expect(try cell("4.2857", unit: "stars").text(language: .de) == "4,29 ★")
        #expect(try cell("4.995", unit: "stars").text(language: .en) == "5 ★")
        let number = MeasureCell(value: .number(4.2857), type: "decimal", unit: "stars", currency: nil, status: "ok")
        #expect(number.text(language: .de) == "4,29 ★")
        let float = MeasureCell(value: .number(4.66667), type: "number", unit: "stars", currency: nil, status: "ok")
        #expect(float.text(language: .en) == "4.67 ★")
        // Units without a display precision keep every digit.
        #expect(try cell("1234.56789").text(language: .de) == "1.234,56789")
        #expect(try cell("2026-01-07", type: "date").text(language: .de) == "07.01.2026")
        #expect(try cell("2026-01-07", type: "date").text(language: .en) == "Jan 7, 2026")
        #expect(
            try cell("2026-01-07T09:15:00.000Z", type: "timestamp").text(language: .en, timeZone: utc)
                == "Jan 7, 2026, 9:15 AM")
        #expect(try cell("soon", type: "date").text(language: .en) == "soon")
    }
    @Test func showsDateDimensionsByTheirTypeAndPrefersLabels() throws {
        let json = #"{"metadata":{"modelId":"m","modelName":"Reviews","measures":[{"id":"rating","name":"Rating"}],"dimensions":[{"id":"day","name":"Day","type":"date"},{"id":"app","name":"App","type":"string"}]},"result":{"rows":[{"dimensions":{"day":"2026-01-07","app":"stable-id"},"dimensionLabels":{"app":"Friendly app"},"measures":{"rating":{"value":"4.2857","type":"decimal","unit":"stars","status":"ok"}}}],"warnings":[],"provenance":[],"stale":false},"exclusions":[]}"#
        let data = try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
        let row = try #require(data.result?.rows.first)
        #expect(data.metadata?.dimensions.map(\.type) == ["date", "string"])
        #expect(data.dimensionText(row, dimension: "day", language: .de) == "07.01.2026")
        #expect(data.dimensionText(row, dimension: "day", language: .en) == "Jan 7, 2026")
        #expect(data.dimensionText(row, dimension: "app", language: .en) == "Friendly app")
        #expect(data.dimensionText(row, dimension: "missing", language: .en) == "—")
        #expect(data.text(row.measures["rating"], measure: "rating", language: .de) == "4,29 ★")
    }
    @Test func shiftsMinorUnitNumbersFromTheirShortestTextLikeTheWeb() {
        func minor(_ number: Double) -> MeasureCell {
            MeasureCell(value: .number(number), type: "decimal", unit: "currency_minor", currency: "EUR", status: "ok")
        }
        #expect(minor(12.5).text(language: .en) == "0.125 EUR")
        #expect(minor(1e17).text(language: .en) == "1,000,000,000,000,000.00 EUR")
        #expect(minor(150).text(language: .de) == "1,50 EUR")
        #expect(MeasureCell.plainDecimal(1.5e-7) == "0.00000015")
        #expect(MeasureCell.plainDecimal(-1e21) == "-1000000000000000000000")
    }
    @Test func leavesNonASCIIDigitsUnchanged() throws {
        #expect(DataFormat.roundDecimalText("٤.٥٥٥", digits: 2) == "٤.٥٥٥")
        #expect(DataFormat.roundDecimalText("１.２３５", digits: 2) == "１.２３５")
        #expect(try cell("٤.٥٥٥", unit: "stars").text(language: .en) == "٤.٥٥٥ ★")
        #expect(DataFormat.date("٢٠٢٦-٠١-٠٧", type: "date", language: .en) == nil)
        #expect(DataFormat.date("２０２６-０１-０７T09:15:00Z", type: "timestamp", language: .en) == nil)
    }
    @Test func showsNegativeZeroDecimalsAsZero() {
        #expect(MeasureCell(value: .number(-0.0), type: "decimal", unit: nil, currency: nil, status: "ok").text(language: .en) == "0")
    }

    /// A tile with no rows, a warning count and sources needing attention.
    private func viewerData(
        error: String? = nil, warnings: Int = 1, codes: [String] = [], partial: Bool = false
    ) throws
        -> MeasureWidgetData
    {
        let rows =
            partial
            ? #"[{"dimensions":{},"measures":{"d":{"value":"1","type":"decimal","status":"partial"}}}]"# : "[]"
        let result =
            error == nil
            ? #"{"releaseId":null,"rows":\#(rows),"warnings":\#(Array(repeating: "\"w\"", count: warnings) + codes),"provenance":[],"stale":true}"#
            : "null"
        let json = #"""
            {"sourceHealth":[{"connectionId":"a","name":"Apple team","status":"needs_reauthorization"},
            {"connectionId":"b","name":"Play account","status":"auth_failed"},
            {"connectionId":"c","name":"Second Play","status":"outage"}],
            "metadata":null,"result":\#(result),"error":\#(error.map { "\"\($0)\"" } ?? "null"),"exclusions":[]}
            """#
        return try JSONDecoder().decode(MeasureWidgetData.self, from: Data(json.utf8))
    }

    /// Editor instructions, in either language (#649, #676).
    private func instructs(_ text: String) -> Bool {
        ["Check", "check", "Reconnect", "Update", "Try again", "Prüfe", "Verbinde", "Aktualisiere", "Versuche"]
            .contains { text.contains($0) }
    }

    @Test func wallScreenWordingAsTheWebKiosk() throws {
        let data = try viewerData()
        let rows = data.result?.rows ?? []
        #expect(data.viewerWarnings(rows: rows, language: .en) == ["1 data warning"])
        #expect(data.viewerWarnings(rows: rows, language: .de) == ["1 Datenhinweis"])
        let two = try viewerData(warnings: 2)
        #expect(two.viewerWarnings(rows: [], language: .en) == ["2 data warnings"])
        #expect(two.viewerWarnings(rows: [], language: .de) == ["2 Datenhinweise"])
        #expect(try viewerData(warnings: 0).viewerWarnings(rows: [], language: .en).isEmpty)
        let loading = try viewerData(warnings: 1, codes: ["source_history_incomplete"])
        #expect(
            loading.viewerWarnings(rows: [], language: .en) == [
                "History incomplete. Earlier days may be missing.", "1 data warning",
            ])
        #expect(
            try viewerData(warnings: 0, codes: ["source_history_incomplete"]).viewerWarnings(rows: [], language: .de)
                == ["Verlauf unvollständig. Frühere Tage können fehlen."])
        let partial = try viewerData(warnings: 0, partial: true)
        #expect(
            partial.viewerWarnings(rows: partial.result?.rows ?? [], language: .en) == ["Some source data is missing."])
        #expect(
            data.viewerSourceNotices(language: .en).map(\.text) == [
                "Imports from Apple team are paused.", "Imports from Play account are paused.",
                "Imports from Second Play are interrupted.",
            ])
        #expect(data.viewerSourceNotices(language: .de).first?.text == "Die Importe von Apple team sind pausiert.")
        #expect(KitStrings.text(.measureStale, .de) == "Letzte gültige Daten")
        #expect(data.viewerError(expired: false, language: .en) == nil)
        #expect(data.viewerError(expired: true, language: .en) == "Data not available")
    }

    @Test func failedRequestsSayOnlyTheState() throws {
        #expect(try viewerData(error: "data_source_pending").viewerError(expired: false, language: .en) == "Data not available yet")
        #expect(
            try viewerData(error: "data_source_pending").viewerError(expired: false, language: .de)
                == "Daten noch nicht verfügbar")
        #expect(try viewerData(error: "internal_error").viewerError(expired: false, language: .en) == "Data not available")
        #expect(try viewerData(error: "internal_error").viewerError(expired: false, language: .de) == "Daten nicht verfügbar")
        for language in [ScreenLanguage.en, .de] {
            for error in ["data_source_pending", "data_source_not_found", "internal_error"] {
                let data = try viewerData(error: error)
                let lines =
                    [data.viewerError(expired: false, language: language) ?? ""]
                    + data.viewerSourceNotices(language: language).map(\.text)
                let instructed = lines.contains(where: instructs)
                #expect(!instructed, "\(language) \(error)")
            }
            let data = try viewerData(warnings: 3, partial: true)
            let warned = data.viewerWarnings(rows: data.result?.rows ?? [], language: language)
            let instructed = warned.contains(where: instructs)
            #expect(!instructed)
        }
    }

    private func sources(_ health: String) throws -> MeasureWidgetData {
        try JSONDecoder().decode(
            MeasureWidgetData.self,
            from: Data(#"{"sourceHealth":\#(health),"metadata":null,"result":null,"error":null,"exclusions":[]}"#.utf8))
    }

    @Test func pausedAndFirstImportSourcesAsTheWebViewer() throws {
        let data = try sources(
            #"[{"connectionId":"a","name":"Apple team","status":"paused"},{"connectionId":"b","name":"Play","status":"pending"}]"#
        )
        #expect(
            data.viewerSourceNotices(language: .en).map(\.text) == [
                "App collection is paused for Apple team. Retained history remains available.",
                "Waiting for the first complete import from Play.",
            ])
        #expect(
            data.viewerSourceNotices(language: .de).map(\.text) == [
                "Die App-Erfassung für Apple team ist pausiert. Aufbewahrte Daten bleiben verfügbar.",
                "Der erste vollständige Import von Play steht noch aus.",
            ])
    }

    @Test func sameNamedSourcesKeepTheirOwnLines() throws {
        // Two "Google Play" connections both needing reauthorization: the
        // same text, two lines with their own ids (SwiftUI's ForEach).
        let data = try sources(
            #"[{"connectionId":"a","name":"Google Play","status":"needs_reauthorization"},{"connectionId":"b","name":"Google Play","status":"needs_reauthorization"}]"#
        )
        let notices = data.viewerSourceNotices(language: .en)
        #expect(notices.count == 2)
        #expect(notices[0].text == notices[1].text)
        #expect(Set(notices.map(\.id)).count == 2)
    }
}

@Suite struct MeasureLineChartTests {
    /** A line chart on a slide draws no table of its points, however many (#835). */
    @Test func aPlacedLineChartDrawsTheLineAlone() {
        #expect(MeasureLineChart.tableRows(placed: true, scroll: false, count: 365) == 0)
        #expect(MeasureLineChart.tableRows(placed: true, scroll: false, count: 1) == 0)
        // A scroll card grows with its content: every point.
        #expect(MeasureLineChart.tableRows(placed: false, scroll: true, count: 365) == 365)
        #expect(MeasureLineChart.tableRows(placed: true, scroll: true, count: 31) == 31)
        #expect(MeasureLineChart.tableRows(placed: false, scroll: false, count: 31) == 31)
    }
}
