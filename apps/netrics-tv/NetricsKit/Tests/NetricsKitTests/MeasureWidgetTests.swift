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
}
