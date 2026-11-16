import Foundation
import Testing

@testable import NetricsKit

// A status board's freshness streams (#727, ADR 0025 section 8): decoded
// leniently, worded in the list form with the stream's name first, the
// warning for an overdue stream, no "next" while syncs are paused, and
// laid out in the rows the sources leave free, as the web does
// (apps/web/src/lib/studio-status.ts, statusWidgetLayout).

private let berlin = TimeZone(identifier: "Europe/Berlin")!
private let clock24 = Locale(identifier: "en_US@hours=h23")
private let germany = Locale(identifier: "de_DE")
/** 2026-11-16 14:00 in Berlin. */
private let now = ISODate.parse("2026-11-16T13:00:00Z")!

private let sales = """
    {"key": "sales", "kind": "periodic", "stream": "Sales", "fetchedAt": "2026-11-16T12:50:00Z",
     "dataThrough": "2026-11-15", "nextExpectedAt": "2026-11-16T20:00:00Z", "nextCheckAt": "2026-11-16T14:10:00Z"}
    """
private let reviews = """
    {"key": "reviews", "kind": "continuous", "stream": "Reviews", "fetchedAt": "2026-11-16T12:50:00Z",
     "nextCheckAt": "2026-11-16T13:30:00Z", "futureField": [1]}
    """
private let overdue = """
    {"key": "analytics", "kind": "periodic", "stream": "Analytics", "fetchedAt": "2026-11-16T12:50:00Z",
     "dataThrough": "2026-11-14", "nextExpectedAt": "2026-11-15T08:00:00Z", "late": true, "overdue": true,
     "nextCheckAt": "2026-11-16T13:30:00Z"}
    """

private func item(_ id: String, status: String = "ok", streams: String? = nil) -> String {
    let field = streams.map { #", "streams": \#($0)"# } ?? ""
    return """
        {"connectionId": "\(id)", "name": "Source \(id)", "status": "\(status)",
         "lastSuccessAt": "2026-11-16T12:50:00Z"\(field)}
        """
}

private func board(_ items: [String]) throws -> StatusWidgetData {
    try JSONDecoder().decode(
        StatusWidgetData.self, from: Data(#"{"status": "ok", "items": [\#(items.joined(separator: ","))]}"#.utf8))
}

private func words(_ language: ScreenLanguage = .en) -> FreshnessText {
    FreshnessText(language: language, timeZone: berlin, region: language == .en ? clock24 : germany)
}

@Suite struct StatusStreamTests {
    // MARK: Decoding

    @Test func streamsDecodeLenientlyAndDamagedOnesAreDropped() throws {
        let data = try board([
            item("a", streams: "[\(sales), \(reviews), \(overdue), {\"key\": \"x\"}, \"broken\", {\"kind\": \"continuous\", \"stream\": \"No key\", \"fetchedAt\": \"2026-11-16T12:50:00Z\"}]"),
            item("b"),
            item("c", streams: "\"not a list\""),
        ])
        #expect(data.items.count == 3)
        let streams = data.items[0].streams
        #expect(streams.map(\.key) == ["sales", "reviews", "analytics"])
        #expect(streams[0].freshness.dataThrough == "2026-11-15")
        #expect(streams[0].overdue == false)
        #expect(streams[2].overdue == true)
        #expect(data.items[1].streams.isEmpty)
        #expect(data.items[2].streams.isEmpty)
        // The cache keeps them.
        let again = try JSONDecoder().decode(StatusWidgetData.self, from: JSONEncoder().encode(data))
        #expect(again == data)
    }

    // MARK: Wording

    @Test func theListFormNamesTheStreamFirst() throws {
        let streams = try board([item("a", streams: "[\(sales), \(reviews), \(overdue)]")]).items[0].streams
        #expect(words().streamCandidates(streams[0], paused: false, now: now).first == "Sales up to Nov 15 · next ~21:00")
        #expect(
            words().streamCandidates(streams[1], paused: false, now: now)
                == ["Reviews checked 10 min. ago · next check ~14:30", "Reviews checked 10 min. ago"])
        // Overdue: the covered day and the late wording only.
        #expect(
            words().streamCandidates(streams[2], paused: false, now: now)
                == ["Analytics up to Nov 14 · Nov 15 not published yet", "Analytics up to Nov 14"])
        #expect(words(.de).streamCandidates(streams[0], paused: false, now: now).first == "Sales bis 15. Nov. · nächste ~21:00")
        #expect(
            words(.de).streamCandidates(streams[1], paused: false, now: now).first
                == "Reviews geprüft vor 10 Min. · nächste Prüfung ~14:30")
        #expect(
            words(.de).streamCandidates(streams[2], paused: false, now: now).first
                == "Analytics bis 14. Nov. · 15. Nov. noch nicht veröffentlicht")
    }

    @Test func pausedSyncsNeverPromiseTheNextOne() throws {
        let streams = try board([item("a", streams: "[\(sales), \(reviews)]")]).items[0].streams
        #expect(words().streamCandidates(streams[0], paused: true, now: now) == ["Sales up to Nov 15"])
        #expect(words().streamCandidates(streams[1], paused: true, now: now) == ["Reviews checked 10 min. ago"])
        let paused = try board([item("a", status: "auth_failed", streams: "[\(sales)]")]).items[0]
        #expect(
            StatusBoard.streamLine(paused.streams[0], of: paused, now: now, language: .en, timeZone: berlin, region: clock24)
                == "Sales up to Nov 15")
    }

    // MARK: Layout

    private func layout(height: Double, width: Double = 520) -> StudioLayout.StatusLayout {
        StudioLayout.statusLayout(label: "Sources", width: width, height: height, fontScale: 1, showAge: true)
    }

    private func rows(_ data: StatusWidgetData, _ layout: StudioLayout.StatusLayout) -> [String: [StatusBoard.StreamRow]] {
        StatusBoard.streamRows(data.items, layout: layout, now: now, language: .en, timeZone: berlin, region: clock24)
    }

    @Test func streamsTakeOnlyTheRowsTheSourcesLeaveFree() throws {
        let data = try board([
            item("a", streams: "[\(sales), \(reviews)]"), item("b", streams: "[\(overdue)]"), item("c"),
        ])
        // Room for every source and every stream.
        let roomy = layout(height: 900)
        #expect(roomy.rowCapacity >= 6)
        let all = rows(data, roomy)
        #expect(all["a"]?.map(\.key) == ["sales", "reviews"])
        #expect(all["b"]?.map(\.overdue) == [true])
        #expect(all["c"] == nil)
        // Room for the three sources and one stream: the first one, in the sources' order.
        let tight = try #require(
            stride(from: 200.0, through: 900, by: 1).lazy.map { self.layout(height: $0) }.first { $0.rowCapacity == 4 })
        #expect(StatusBoard.rows(data.items, capacity: tight.rowCapacity).shown.count == 3)
        let one = rows(data, tight)
        #expect(one["a"]?.map(\.key) == ["sales"])
        #expect(one["b"] == nil)
        // No room beyond the sources, or a "+N more" row: no stream at all.
        let exact = try #require(
            stride(from: 200.0, through: 900, by: 1).lazy.map { self.layout(height: $0) }.first { $0.rowCapacity == 3 })
        #expect(rows(data, exact).isEmpty)
        let more = try #require(
            stride(from: 200.0, through: 900, by: 1).lazy.map { self.layout(height: $0) }.first { $0.rowCapacity == 2 })
        #expect(StatusBoard.rows(data.items, capacity: more.rowCapacity).more == 2)
        #expect(rows(data, more).isEmpty)
    }

    @Test func aStreamLineDropsPartsToFitOneLine() throws {
        let data = try board([item("a", streams: "[\(sales)]")])
        let narrow = layout(height: 900, width: 300)
        let line = try #require(rows(data, narrow)["a"]?.first?.text)
        #expect(line == "Sales up to Nov 15")
        let wide = layout(height: 900, width: 900)
        #expect(rows(data, wide)["a"]?.first?.text == "Sales up to Nov 15 · next ~21:00")
        // Fits the name and age columns at the age size.
        let fit = narrow.columns.name + narrow.columns.age + narrow.columns.gap
        #expect(StudioLayout.wrappedLineCount(line, maxWidth: fit, fontSize: narrow.sizes.age) == 1)
    }

    // MARK: Detail sheet

    @Test func theDetailListsEachSourcesStreams() throws {
        let data = try board([item("a", streams: "[\(sales), \(overdue)]"), item("b")])
        let widget = DeviceWidget(
            id: "s", type: "status", placement: StudioPlacement(x: 0, y: 0, w: 4, h: 4), label: "Sources",
            content: .status(StatusWidgetOptions(), data))
        let detail = try #require(
            WidgetDetail.make(widget, now: now, language: .en, timeZone: berlin, region: clock24))
        #expect(
            detail.items[0].lines == [
                WidgetDetail.Item.Line(text: "Sales up to Nov 15 · next ~21:00", warning: false),
                WidgetDetail.Item.Line(text: "Analytics up to Nov 14 · Nov 15 not published yet", warning: true),
            ])
        #expect(detail.items[1].lines.isEmpty)
    }
}
